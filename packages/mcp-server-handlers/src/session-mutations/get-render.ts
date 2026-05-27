/**
 * `createGguiGetRenderHandler` — read full render state.
 *
 * Shared by every deployment — both the cloud server and the
 * standalone `@ggui-ai/mcp-server` compose this one factory.
 *
 * Behavior:
 *   - Resolves render via `renderStore.get(renderId)`.
 *   - Tenancy gate via `ctx.appId` — cross-tenant + missing both
 *     surface uniformly as {@link RenderNotFoundError}.
 *   - Returns the wire-shape `Render` payload directly (the
 *     {@link StoredRender} wrapper's lifecycle fields are already
 *     embedded on the render via `RenderBase` for component / system
 *     variants; the MCP-Apps variant is locator-only).
 *   - Optional heartbeat hook — when set, the handler invokes
 *     `heartbeat(renderId)` on every successful read so cloud's
 *     activity-bump-on-get behavior is preserved without forcing
 *     OSS to maintain a TTL store.
 *
 * Post-Phase-B (flatten-render-identity): collapsed from
 * `ggui_get_session` which projected a vessel-shape `SessionView`
 * (ISO timestamps + stack array). The wire response is now the
 * `Render` shape with epoch-ms timestamps + flat (no stack).
 */

import { z } from 'zod';
import type { Render, GguiGetRenderOutput } from '@ggui-ai/protocol';
import type {
  RenderStore,
  StoredRender,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { RenderNotFoundError } from './errors.js';

const inputSchema = {
  renderId: z
    .string()
    .min(1)
    .describe('Render opaque id (UUID) — returned by ggui_render.'),
} as const;

const outputSchema = {
  // `Render` is a discriminated union; downstream typing comes from
  // the typed `GguiGetRenderOutput` return shape — the raw record-
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
export interface GetRenderHeartbeatResult {
  readonly lastActivityAt?: number;
  readonly expiresAt?: number;
}

export interface GguiGetRenderHandlerDeps {
  readonly renderStore: RenderStore;
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
    renderId: string,
  ) =>
    | Promise<GetRenderHeartbeatResult | void>
    | GetRenderHeartbeatResult
    | void;
}

export function createGguiGetRenderHandler(
  deps: GguiGetRenderHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, GguiGetRenderOutput> {
  return {
    name: 'ggui_get_render',
    title: 'Get render',
    audience: ['agent'],
    description:
      'Retrieve full render state — id, appId, eventSequence, render variant. Bumps the render activity heartbeat on every successful read.',
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiGetRenderOutput> {
      const { renderId } = z.object(inputSchema).parse(rawInput);

      const stored = await deps.renderStore.get(renderId);
      if (!stored || stored.appId !== ctx.appId) {
        // Tenancy + missing both surface uniformly so cross-tenant
        // existence is not leaked.
        throw new RenderNotFoundError(renderId);
      }

      // Best-effort heartbeat — don't fail the read if the bump fails.
      let heartbeatResult: GetRenderHeartbeatResult | void = undefined;
      if (deps.heartbeat) {
        try {
          heartbeatResult = await deps.heartbeat(renderId);
        } catch {
          // Intentionally swallowed.
        }
      }

      const overlayed = applyHeartbeatOverlay(stored, heartbeatResult);
      return projectRender(overlayed);
    },
  };
}

/**
 * Apply heartbeat-returned timestamps onto the stored render so the
 * wire response reflects post-heartbeat TTL.
 */
function applyHeartbeatOverlay(
  stored: StoredRender,
  heartbeat: GetRenderHeartbeatResult | void,
): StoredRender {
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
 * Project the {@link StoredRender} into the wire-shape `Render`.
 *
 * Component / system variants extend `RenderBase` which already
 * carries the lifecycle fields; we overlay the store's authoritative
 * `eventSequence` / `lastActivityAt` / `expiresAt` so a freshly-
 * minted render that hasn't been re-read since commit still surfaces
 * the latest values the store knows about.
 *
 * The MCP-Apps variant is locator-only (no `RenderBase` fields by
 * design); we surface it verbatim — clients reading `ui://ggui/render`
 * mounts have separate paths for MCP-Apps resources.
 */
function projectRender(stored: StoredRender): Render {
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
