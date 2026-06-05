/**
 * `render` channel handler — folds an inbound `render` frame into the
 * single-render mount slot and (when transport wiring is present)
 * activates the per-channel transport router against the newly-
 * mounted render.
 *
 * Post-render-identity-collapse (2026-05-27): each iframe holds
 * exactly one mounted render for its lifetime. The handler routes the
 * inbound `render` to a caller-supplied `applyRender` callback that
 * either mounts (first frame) or re-applies (subsequent frames to the
 * same id). Frames addressed to a different `renderId` are out-of-spec
 * and drop with a console warning — the host spawns a fresh iframe
 * per unique render id.
 *
 * Placeholder mode (boot.test.ts and the C7a placeholder-only spec)
 * omits `applyRender` + `getChannelTransport`. The handler still fires
 * for those callers — status log keeps firing — but no React mount
 * happens. The boot-without-renderer path remains testable.
 */

import type { ChannelHandler } from '@ggui-ai/live-channel';
import type { RenderPayload, GguiSession } from '@ggui-ai/protocol';

import type { ChannelTransportRouter } from '../channel-transport.js';
import { setConnectedStatus, type StatusRefs } from '../status-dom.js';

export interface RenderHandlerDeps {
  /**
   * Status DOM refs the connected-status log updates. Required —
   * even renderer-mode consumers want a `[ggui:connected]` console
   * log on every render frame for operator-visible boot debugging.
   */
  readonly statusRefs: StatusRefs;
  /**
   * Pin — when set, render frames with a different `renderId`
   * are dropped with a console warning. Set by the renderer hook to
   * the render id the iframe was bootstrapped against (every
   * post-displayMode iframe is pinned to a single render).
   */
  readonly pinnedRenderId?: string;
  /**
   * Apply the inbound render to the single mount slot. Absent in
   * placeholder mode (no React mount). When present, the handler
   * `await`s the apply before activating the per-channel transport
   * so the router targets the render React already mounted.
   */
  readonly applyRender?: (render: GguiSession) => Promise<void>;
  /**
   * Renderer-mode hook — returns the per-channel transport router so
   * the render handler can activate `source.tool` channel subscriptions
   * against the newly-mounted render. Absent in placeholder-only mode.
   */
  readonly getChannelTransport?: () => ChannelTransportRouter;
}

export function createRenderHandler(
  deps: RenderHandlerDeps,
): ChannelHandler<RenderPayload> {
  return {
    type: 'render',
    onMessage: async (payload) => {
      const render = payload.render;

      if (deps.pinnedRenderId !== undefined && render.id !== deps.pinnedRenderId) {
        // Out-of-spec: each iframe is pinned to exactly one render id
        // post-displayMode-divergence; the host spawns a fresh iframe
        // per render. A frame for some other id means the host wired
        // the wrong render or the server is broadcasting cross-render
        // frames.
        // eslint-disable-next-line no-console
        console.warn(
          `[ggui:render] ignoring render for ${render.id} — iframe pinned to ${deps.pinnedRenderId}`,
        );
        return;
      }

      if (deps.applyRender !== undefined) {
        await deps.applyRender(render);
      }
      setConnectedStatus(deps.statusRefs);

      const channelTransport = deps.getChannelTransport?.();
      if (channelTransport === undefined) return;
      if (render.type === 'mcpApps' || render.type === 'system') return;
      channelTransport.applyRender({
        renderId: render.id,
        ...(render.streamSpec !== undefined
          ? { streamSpec: render.streamSpec }
          : {}),
      });
    },
  };
}
