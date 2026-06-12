/**
 * `createGguiGetSessionHandler` — read full render state.
 *
 * Shared by every deployment — both the cloud server and the
 * standalone `@ggui-ai/mcp-server` compose this one factory.
 *
 * Behavior:
 *   - Resolves render via `renderStore.get(sessionId)`.
 *   - Tenancy gate via `ctx.appId` — cross-tenant + missing both
 *     surface uniformly as {@link GguiSessionNotFoundError}.
 *   - Returns the wire-shape `GguiSession` payload directly (the
 *     {@link StoredGguiSession} wrapper's lifecycle fields are already
 *     embedded on the render via `GguiSessionBase` for component / system
 *     variants; the MCP-Apps variant is locator-only).
 *   - Optional heartbeat hook — when set, the handler invokes
 *     `heartbeat(sessionId)` on every successful read so cloud's
 *     activity-bump-on-get behavior is preserved without forcing
 *     OSS to maintain a TTL store.
 *
 * Post-Phase-B (flatten-render-identity): collapsed from
 * `ggui_get_session` which projected a vessel-shape `SessionView`
 * (ISO timestamps + stack array). The wire response is now the
 * `GguiSession` shape with epoch-ms timestamps + flat (no stack).
 */

import { z } from 'zod';
import { getSessionInputShape } from '@ggui-ai/protocol';
import type { GguiSession, GguiGetSessionOutput } from '@ggui-ai/protocol';
import type {
  GguiSessionStore,
  StoredGguiSession,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { GguiSessionNotFoundError } from './errors.js';

// Canonical SSoT shape — authored once in `@ggui-ai/protocol`
// (`schemas/mcp.ts`).
const inputSchema = getSessionInputShape;

const outputSchema = {
  // `GguiSession` is a discriminated union; downstream typing comes from
  // the typed `GguiGetSessionOutput` return shape — the raw record-
  // shaped zod schema here is just for runtime validation framing.
  id: z.string(),
  appId: z.string(),
  eventSequence: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
} as const;

/**
 * Optional return shape from the heartbeat hook. Lets the host
 * surface its just-written `lastActivityAt` / `expiresAt` onto the
 * response — cloud's heartbeat writes both, and we want the wire
 * response to reflect the post-heartbeat TTL, not the pre-heartbeat
 * row state. `void` return = no overlay; factory uses the values
 * already on the resolved render.
 */
export interface GetSessionHeartbeatResult {
  readonly lastActivityAt?: number;
  readonly expiresAt?: number;
}

export interface GguiGetSessionHandlerDeps {
  readonly renderStore: GguiSessionStore;
  /**
   * Optional activity-bump hook. When set, the handler calls this
   * after a successful read so the render's lastActivity / TTL stay
   * fresh — same posture as cloud's `heartbeatSession`.
   *
   * Return value (optional) lets the hook surface the post-write
   * timestamps onto the response.
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
): SharedHandler<typeof inputSchema, typeof outputSchema, GguiGetSessionOutput> {
  return {
    name: 'ggui_get_session',
    title: 'Get GguiSession',
    audience: ['agent'],
    description:
      'Retrieve full GguiSession state — id, appId, eventSequence, GguiSession variant. Bumps the GguiSession activity heartbeat on every successful read.',
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiGetSessionOutput> {
      const { sessionId } = z.object(inputSchema).parse(rawInput);

      const stored = await deps.renderStore.get(sessionId);
      if (!stored || stored.appId !== ctx.appId) {
        // Tenancy + missing both surface uniformly so cross-tenant
        // existence is not leaked.
        throw new GguiSessionNotFoundError(sessionId);
      }

      // Best-effort heartbeat — don't fail the read if the bump fails.
      let heartbeatResult: GetSessionHeartbeatResult | void = undefined;
      if (deps.heartbeat) {
        try {
          heartbeatResult = await deps.heartbeat(sessionId);
        } catch {
          // Intentionally swallowed.
        }
      }

      const overlayed = applyHeartbeatOverlay(stored, heartbeatResult);
      return projectGguiSession(overlayed);
    },
  };
}

/**
 * Apply heartbeat-returned timestamps onto the stored render so the
 * wire response reflects post-heartbeat TTL.
 */
function applyHeartbeatOverlay(
  stored: StoredGguiSession,
  heartbeat: GetSessionHeartbeatResult | void,
): StoredGguiSession {
  if (!heartbeat) return stored;
  if (
    heartbeat.lastActivityAt === undefined &&
    heartbeat.expiresAt === undefined
  ) {
    return stored;
  }
  return {
    ...stored,
    ...(heartbeat.lastActivityAt !== undefined
      ? { lastActivityAt: heartbeat.lastActivityAt }
      : {}),
    ...(heartbeat.expiresAt !== undefined
      ? { expiresAt: heartbeat.expiresAt }
      : {}),
  };
}

/**
 * Project the {@link StoredGguiSession} into the wire-shape `GguiSession`.
 *
 * Component / system variants extend `GguiSessionBase` which already
 * carries the lifecycle fields; we overlay the store's authoritative
 * `eventSequence` / `lastActivityAt` / `expiresAt` so a freshly-
 * minted render that hasn't been re-read since commit still surfaces
 * the latest values the store knows about.
 *
 * The MCP-Apps variant is locator-only (no `GguiSessionBase` fields by
 * design); we surface it verbatim — clients reading `ui://ggui/render`
 * mounts have separate paths for MCP-Apps resources.
 */
function projectGguiSession(stored: StoredGguiSession): GguiSession {
  const r = stored.render;
  if (r.type === 'mcpApps') {
    return r;
  }
  return {
    ...r,
    id: stored.id,
    appId: stored.appId,
    eventSequence: stored.eventSequence,
    createdAt: stored.createdAt,
    lastActivityAt: stored.lastActivityAt,
    expiresAt: stored.expiresAt,
    ...(stored.status !== undefined ? { status: stored.status } : {}),
    ...(stored.endUserIdentity !== undefined
      ? { endUserIdentity: stored.endUserIdentity }
      : {}),
    ...(stored.themeId !== undefined ? { themeId: stored.themeId } : {}),
    ...(stored.hostSession !== undefined
      ? { hostSession: stored.hostSession }
      : {}),
    ...(stored.hostContext !== undefined
      ? { hostContext: stored.hostContext }
      : {}),
  };
}
