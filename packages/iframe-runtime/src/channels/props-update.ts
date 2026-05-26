/**
 * `props_update` channel handler — factored out of `runtime.ts` into
 * the `@ggui-ai/live-channel` layer.
 *
 * Receives a `{stackItemId, props}` payload from the live channel, validates
 * the new props against the stack item's cached `propsSpec`, patches
 * the in-model entry, and re-applies the renderer so React picks up
 * the change.
 *
 * Skips when:
 *   - `stackItemId` is empty or not a string.
 *   - `props` is null / not an object (defensive — server can't emit
 *     this shape, but the dispatcher routes the frame on type alone).
 *   - No matching stack item exists (server raced ahead of our pop).
 *   - The matched item is `mcpApps` / `system` (no `propsSpec`; server
 *     should never emit `props_update` for these).
 *   - The new props fail validation against the cached spec.
 *
 * R6 (2026-05-26) retired the per-handler polling descriptor. Polling
 * is now registry-level — the iframe-runtime composes the
 * `/api/sessions/:id/state?wsToken=<token>` URL and a snapshot-parsing
 * function once at bind time (see `runtime.ts`); a single fetch per
 * tick projects the slice envelope into per-handler frames the
 * `PollingTransport` dispatches.
 */

import type { ChannelHandler } from '@ggui-ai/live-channel';
import type {
  PropsUpdatePayload,
  SessionStackEntry,
} from '@ggui-ai/protocol';

import type { StackRenderer } from '../stack-item-renderer.js';
import type { StackModel } from '../stack.js';
import { validateInboundPropsPayload } from '../validation.js';

export interface PropsUpdateHandlerDeps {
  readonly stackModel: StackModel;
  readonly getStackRenderer: () => StackRenderer;
}

export function createPropsUpdateHandler(
  deps: PropsUpdateHandlerDeps,
): ChannelHandler<PropsUpdatePayload> {
  return {
    type: 'props_update',
    onMessage: async (payload) => {
      const { stackItemId, props } = payload;
      if (typeof stackItemId !== 'string' || stackItemId.length === 0) return;
      if (props === null || typeof props !== 'object') return;

      const target = deps.stackModel
        .snapshot()
        .find((item) => item.id === stackItemId);
      if (target === undefined) return;
      if (target.type === 'mcpApps' || target.type === 'system') return;

      const result = validateInboundPropsPayload(target.propsSpec, props);
      if (!result.valid) return;

      const nextSnapshot: SessionStackEntry[] = deps.stackModel
        .snapshot()
        .map((item) => {
          if (item.id !== stackItemId) return item;
          if (item.type === 'mcpApps' || item.type === 'system') return item;
          return { ...item, props };
        });
      deps.stackModel.setAll(nextSnapshot);
      await deps.getStackRenderer().applyStack(deps.stackModel.snapshot());
    },
  };
}
