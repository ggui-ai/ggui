/**
 * `push` channel handler — folds an inbound `push` frame into the
 * single-item render slot and (when transport wiring is present)
 * activates the per-channel transport router against the newly-
 * mounted item.
 *
 * Post-stack-removal (2026-05-27): each iframe holds exactly one
 * mounted item for its lifetime. The push handler routes the inbound
 * `stackItem` to a caller-supplied `applyItem` callback that either
 * mounts (first push) or re-applies (subsequent push to the same id).
 * Pushes addressed to a different `stackItemId` are out-of-spec and
 * drop with a console warning — the host spawns a fresh iframe per
 * unique stack-item id.
 *
 * Placeholder mode (boot.test.ts and the C7a placeholder-only spec)
 * omits `applyItem` + `getChannelTransport`. The handler still fires
 * for those callers — status log keeps firing — but no React mount
 * happens. The boot-without-renderer path remains testable.
 */

import type { ChannelHandler } from '@ggui-ai/live-channel';
import type { PushPayload, SessionStackEntry } from '@ggui-ai/protocol';

import type { ChannelTransportRouter } from '../channel-transport.js';
import { setConnectedStatus, type StatusRefs } from '../status-dom.js';

export interface PushHandlerDeps {
  /**
   * Status DOM refs the connected-status log updates. Required —
   * even renderer-mode consumers want a `[ggui:connected]` console
   * log on every push for operator-visible boot debugging.
   */
  readonly statusRefs: StatusRefs;
  /**
   * Pin — when set, push payloads with a different `stackItemId`
   * are dropped with a console warning. Set by the renderer hook to
   * the stack-item id the iframe was bootstrapped against (every
   * post-displayMode iframe is pinned to a single item).
   */
  readonly pinnedItemId?: string;
  /**
   * Apply the inbound item to the single mount slot. Absent in
   * placeholder mode (no React mount). When present, the handler
   * `await`s the apply before activating the per-channel transport
   * so the router targets the item React already mounted.
   */
  readonly applyItem?: (item: SessionStackEntry) => Promise<void>;
  /**
   * Renderer-mode hook — returns the per-channel transport router so
   * the push handler can activate `source.tool` channel subscriptions
   * against the newly-mounted item. Absent in placeholder-only mode.
   */
  readonly getChannelTransport?: () => ChannelTransportRouter;
}

export function createPushHandler(
  deps: PushHandlerDeps,
): ChannelHandler<PushPayload> {
  return {
    type: 'push',
    onMessage: async (payload) => {
      const item = payload.stackItem;

      if (deps.pinnedItemId !== undefined && item.id !== deps.pinnedItemId) {
        // Out-of-spec: each iframe is pinned to exactly one stack-item
        // id post-displayMode-divergence; the host spawns a fresh
        // iframe per push. A push for some other id means the host
        // wired the wrong session or the server is broadcasting
        // cross-item frames.
        // eslint-disable-next-line no-console
        console.warn(
          `[ggui:push] ignoring push for ${item.id} — iframe pinned to ${deps.pinnedItemId}`,
        );
        return;
      }

      if (deps.applyItem !== undefined) {
        await deps.applyItem(item);
      }
      setConnectedStatus(deps.statusRefs);

      const channelTransport = deps.getChannelTransport?.();
      if (channelTransport === undefined) return;
      if (item.type === 'mcpApps' || item.type === 'system') return;
      channelTransport.applyStackItem({
        stackItemId: item.id,
        ...(item.streamSpec !== undefined
          ? { streamSpec: item.streamSpec }
          : {}),
      });
    },
  };
}
