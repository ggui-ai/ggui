/**
 * `createGguiGetSessionHandler` — read full session state.
 *
 * Shared by every deployment — both the cloud server and the
 * standalone `@ggui-ai/mcp-server` compose this one factory.
 *
 * Behavior:
 *   - Resolves session via `sessionStore.get(sessionId)`.
 *   - Tenancy gate via `ctx.appId` — cross-tenant + missing both
 *     surface uniformly as {@link SessionNotFoundError}.
 *   - Projects the OSS `Session` shape (numeric epoch timestamps)
 *     to the protocol `SessionView` shape (ISO strings) for the
 *     wire response. Status defaults to `'active'` since the OSS
 *     SessionStore doesn't track lifecycle status today; a future
 *     slice that lands close/expire wires this through.
 *   - Optional heartbeat hook — when set, the handler invokes
 *     `heartbeat(sessionId)` on every successful read so cloud's
 *     activity-bump-on-get behavior is preserved without forcing
 *     OSS to maintain a TTL store.
 */

import { z } from 'zod';
import type {
  AdapterPermissions,
  EndUserIdentity,
  Session,
  SessionStatus,
  SessionStackEntry,
  SessionView,
} from '@ggui-ai/protocol';
import type { SessionStore } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { SessionNotFoundError } from './errors.js';

const inputSchema = {
  sessionId: z
    .string()
    .min(1)
    .describe('The session id to retrieve'),
} as const;

const outputSchema = {
  id: z.string(),
  appId: z.string(),
  stack: z.array(z.record(z.string(), z.unknown())),
  currentStackIndex: z.number().int().nonnegative(),
  adapterPermissions: z.record(z.string(), z.unknown()),
  eventSequence: z.number().int().nonnegative(),
  status: z.string(),
  endUserIdentity: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  expiresAt: z.string(),
} as const;

/**
 * Optional return shape from the heartbeat hook. Lets the host
 * surface its just-written `lastActivityAt` / `expiresAt` onto the
 * response — cloud's heartbeat writes both, and we want the wire
 * response to reflect the post-heartbeat TTL, not the pre-heartbeat
 * row state. `void` return = no overlay; factory uses the values
 * already on the resolved session.
 */
export interface GetSessionHeartbeatResult {
  readonly lastActivityAt?: number;
  readonly expiresAt?: number;
}

export interface GguiGetSessionHandlerDeps {
  readonly sessionStore: SessionStore;
  /**
   * Optional activity-bump hook. When set, the handler calls this
   * after a successful read so the session's lastActivity / TTL
   * stay fresh — same posture as cloud's `heartbeatSession`.
   *
   * Return value (optional) lets the hook surface the post-write
   * timestamps onto the response. Cloud passes back the values
   * it just wrote so the wire response reflects post-heartbeat TTL.
   *
   * Failures are swallowed (best-effort) so a transient write
   * failure doesn't prevent returning the snapshot we just read.
   */
  readonly heartbeat?: (
    sessionId: string,
  ) =>
    | Promise<GetSessionHeartbeatResult | void>
    | GetSessionHeartbeatResult
    | void;
}

export function createGguiGetSessionHandler(
  deps: GguiGetSessionHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, SessionView> {
  return {
    name: 'ggui_get_session',
    title: 'Get session',
    audience: ['agent'],
    description:
      'Retrieve full session state — id, appId, stack metadata, currentStackIndex, status. Stack entries omit componentCode + sourceCode (those live on the renderable surface, not the agent-visible one). Bumps the session activity heartbeat on every successful read.',
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<SessionView> {
      const { sessionId } = z.object(inputSchema).parse(rawInput);

      const session = await deps.sessionStore.get(sessionId);
      if (!session || session.appId !== ctx.appId) {
        // Tenancy + missing both surface uniformly so cross-tenant
        // existence is not leaked.
        throw new SessionNotFoundError(
          `ggui_get_session: session "${sessionId}" not found, expired, or owned by a different appId.`,
        );
      }

      // Best-effort heartbeat — don't fail the read if the bump fails.
      // When the hook returns updated timestamps, overlay them onto
      // the session before projection so the wire response reflects
      // the post-heartbeat TTL.
      let heartbeatResult: GetSessionHeartbeatResult | void = undefined;
      if (deps.heartbeat) {
        try {
          heartbeatResult = await deps.heartbeat(sessionId);
        } catch {
          // Intentionally swallowed.
        }
      }

      const projected: Session =
        heartbeatResult &&
        (heartbeatResult.lastActivityAt !== undefined ||
          heartbeatResult.expiresAt !== undefined)
          ? {
              ...session,
              ...(heartbeatResult.lastActivityAt !== undefined
                ? { lastActivityAt: heartbeatResult.lastActivityAt }
                : {}),
              ...(heartbeatResult.expiresAt !== undefined
                ? { expiresAt: heartbeatResult.expiresAt }
                : {}),
            }
          : session;
      return projectSessionView(projected);
    },
  };
}

function projectSessionView(session: Session): SessionView {
  // Status comes from the SessionStore when populated (InMemory +
  // Sqlite compute from internal closed flag + expiresAt; cloud
  // Dynamo reads sessionStatus column). Fall back to 'active' for
  // legacy stores that don't yet surface lifecycle state.
  const status: SessionStatus = session.status ?? 'active';
  const view: SessionView = {
    id: session.id,
    appId: session.appId,
    status,
    stack: projectStackForAgent(session.stack),
    currentStackIndex: session.currentStackIndex,
    eventSequence: session.eventSequence,
    adapterPermissions: session.adapterPermissions as AdapterPermissions,
    createdAt: toIso(session.createdAt),
    lastActivityAt: toIso(session.lastActivityAt),
    expiresAt: toIso(session.expiresAt),
  };
  if (session.endUserIdentity) {
    (view as { endUserIdentity?: EndUserIdentity }).endUserIdentity =
      session.endUserIdentity;
  }
  return view;
}

/**
 * Strip code-body fields from every stack entry before serializing.
 *
 * `componentCode` (compiled ESM, 5-50KB per item) and `sourceCode`
 * (raw TSX, similar size) belong on the renderable surface — the
 * iframe-runtime reads them via `_meta.ggui.bootstrap` / `/r/<shortCode>`
 * / `/code/<hash>.js`. The agent has no use for the bytes; agents
 * reason about state via id/props/contextSnapshot/kind. Dropping the
 * fields here saves kilobytes per `ggui_get_session` call (multiplied
 * by stack depth) without removing any signal the agent consumes.
 *
 * Cast through `unknown` is acceptable at this projection boundary —
 * we're producing a structurally-narrower view of the same JSON-safe
 * shape, not erasing type info.
 */
function projectStackForAgent(
  stack: readonly SessionStackEntry[],
): SessionStackEntry[] {
  return stack.map((entry) => {
    const wide = entry as unknown as Record<string, unknown>;
    if ('componentCode' in wide || 'sourceCode' in wide) {
      const lean = { ...wide };
      delete lean['componentCode'];
      delete lean['sourceCode'];
      return lean as unknown as SessionStackEntry;
    }
    return entry;
  });
}

// JavaScript Date represents ±8.64e15 ms from epoch. The
// "effectively infinite" session TTL uses Number.MAX_SAFE_INTEGER
// (~9e15), which overflows that range. Clamp to the JS Date max so
// we always produce a valid ISO-8601 string on the wire.
const MAX_DATE_MS = 8_640_000_000_000_000;

function toIso(epochMs: number | undefined): string {
  // Defensive: InMemorySessionStore may leave timestamps unset on
  // freshly-created sessions. Fall back to "now" so the wire shape
  // stays valid ISO-8601 instead of throwing on Invalid Date.
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    return new Date().toISOString();
  }
  const clamped = Math.min(epochMs, MAX_DATE_MS);
  return new Date(clamped).toISOString();
}
