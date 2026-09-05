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
 *   - Returns the protocol's wire projection (`gguiGetSessionOutputSchema`):
 *     `variant` + the store row's six base fields, for EVERY session —
 *     an MCP-Apps mount is locator-only on its render object, but the
 *     row carries the base fields, so the wire never fails on it.
 *   - Optional heartbeat hook — when set, the handler invokes
 *     `heartbeat(sessionId)` on every successful read so cloud's
 *     activity-bump-on-get behavior is preserved without forcing
 *     OSS to maintain a TTL store.
 *
 * Post-Phase-B (flatten-render-identity): collapsed from
 * `ggui_get_session` which projected a vessel-shape `SessionView`
 * (ISO timestamps + stack array). The wire response is the seven-field
 * projection with epoch-ms timestamps + flat (no stack); nothing else on
 * the row travels (#817 part C).
 */

import { z } from 'zod';
import { getSessionInputShape, gguiGetSessionOutputSchema } from '@ggui-ai/protocol';
import type { GguiGetSessionOutput } from '@ggui-ai/protocol';
import type {
  GguiSessionStore,
  StoredGguiSession,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { GguiSessionNotFoundError } from './errors.js';
import { isVisibleToCaller } from './tenancy.js';

// Canonical SSoT shape — authored once in `@ggui-ai/protocol`
// (`schemas/mcp.ts`).
const inputSchema = getSessionInputShape;

// The wire is the protocol's seven-field projection — registered as its
// `.shape`, never a copy.
const outputSchema = gguiGetSessionOutputSchema.shape;

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
      'Retrieve the GguiSession wire projection — variant (render | mcpApps), id, appId, eventSequence, createdAt, lastActivityAt, expiresAt; nothing else travels. Bumps the GguiSession activity heartbeat on every successful read.',
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiGetSessionOutput> {
      const { sessionId } = z.object(inputSchema).parse(rawInput);

      const stored = await deps.renderStore.get(sessionId);
      if (!isVisibleToCaller(stored, ctx)) {
        // Tenancy (appId + per-user) + missing all surface uniformly so
        // cross-tenant / cross-user existence is not leaked.
        // `stored` is narrowed to StoredGguiSession past this guard.
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
 * Project a stored session onto the wire: `variant` plus the store row's
 * six base fields — for EVERY session. An MCP-Apps mount is locator-only
 * on its render object, but the ROW carries the base fields, so the wire
 * never fails on that variant (the latent gap #817 part C surfaced); the
 * locator itself is not on this wire (MCP-Apps resources have their own
 * paths). Everything else on the row — themeId, status, hostSession — was
 * never delivered: the transport strip-parses to this shape.
 */
function projectGguiSession(stored: StoredGguiSession): GguiGetSessionOutput {
  return {
    variant: stored.render.type === 'mcpApps' ? 'mcpApps' : 'render',
    id: stored.id,
    appId: stored.appId,
    eventSequence: stored.eventSequence,
    createdAt: stored.createdAt,
    lastActivityAt: stored.lastActivityAt,
    expiresAt: stored.expiresAt,
  };
}
