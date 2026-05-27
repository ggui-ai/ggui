/**
 * `push` channel handler — folds an inbound `push` frame into the
 * stack model, re-renders the placeholder DOM, refreshes the status
 * line, then (when triad wiring is present) applies the new stack
 * through the React renderer + activates the channel-transport router
 * against the new top of stack.
 *
 * The placeholder side-effects (stack model upsert + DOM render +
 * status update) are unconditional — they're load-bearing for the
 * C7a-era specs that boot WITHOUT triad wiring (boot.test.ts in
 * particular). Triad-only consumers (production runtime) pass the
 * `getStackRenderer` + `getChannelTransport` thunks; tests that
 * exercise the placeholder path only leave them off.
 *
 * Pre-B3b: the placeholder fold lived in a separate
 * `handleServerMessage` call in `runtime.ts`, fired before triad
 * dispatch. B3b absorbed both into this single handler so the
 * registry-owned WS transport is the sole dispatch site.
 */

import type { ChannelHandler } from '@ggui-ai/live-channel';
import type { PushPayload } from '@ggui-ai/protocol';

import type { ChannelTransportRouter } from '../channel-transport.js';
import type { StackRenderer } from '../stack-item-renderer.js';
import type { StackModel } from '../stack.js';
import {
  refreshStackDom,
  setConnectedStatus,
  type StatusRefs,
} from '../status-dom.js';

export interface PushHandlerDeps {
  readonly stackModel: StackModel;
  /**
   * Status DOM refs the placeholder fold updates. Required — even
   * triad-mode consumers want the status text to reflect the live
   * count for operator-visible boot debugging.
   */
  readonly statusRefs: StatusRefs;
  /**
   * Triad-mode hook — returns the React stack renderer. Absent in
   * placeholder-only mode (tests, and callers that don't mount the
   * React stack).
   */
  readonly getStackRenderer?: () => StackRenderer;
  /**
   * Triad-mode hook — returns the per-channel transport router so the
   * push handler can activate / tear down `source.tool` channels on
   * the new top of stack. Absent in placeholder-only mode.
   */
  readonly getChannelTransport?: () => ChannelTransportRouter;
}

export function createPushHandler(
  deps: PushHandlerDeps,
): ChannelHandler<PushPayload> {
  return {
    type: 'push',
    onMessage: async (payload) => {
      // 1. Stack model upsert + status log — unconditional. Triad and
      //    placeholder consumers both fold the new stackItem into the
      //    model + bump the `[ggui:connected] Connected (N item)`
      //    console log.
      deps.stackModel.upsert(payload.stackItem);
      setConnectedStatus(deps.statusRefs, deps.stackModel);

      // 2. Triad-mode work — only fires when the production runtime
      //    supplied the renderer + transport thunks.
      const stackRenderer = deps.getStackRenderer?.();
      const channelTransport = deps.getChannelTransport?.();

      // 3. Placeholder DOM render — `<li data-ggui-stack-item>` rows
      //    that boot.test.ts (no-triad path) asserts against. Triad-
      //    mode iframes own the `<ul data-ggui-stack>` for React
      //    mounts via `containerFor`; calling `refreshStackDom` there
      //    would wipe React's mounts. Skip when a renderer is wired.
      if (stackRenderer === undefined) {
        refreshStackDom(deps.statusRefs, deps.stackModel);
        return;
      }

      const snapshot = deps.stackModel.snapshot();
      await stackRenderer.applyStack(snapshot);

      if (channelTransport === undefined) return;

      const top = snapshot[snapshot.length - 1];
      if (
        top !== undefined &&
        top.type !== 'mcpApps' &&
        top.type !== 'system'
      ) {
        channelTransport.applyStackItem({
          stackItemId: top.id,
          ...(top.streamSpec !== undefined
            ? { streamSpec: top.streamSpec }
            : {}),
        });
      }
    },
  };
}
