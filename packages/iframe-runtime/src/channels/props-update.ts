/**
 * `props_update` channel handler — patches the currently-mounted
 * stack entry's props in place via the renderer's `applyItem`
 * callback.
 *
 * Post-stack-removal (2026-05-27): each iframe holds exactly one
 * mounted item. The handler reads the current item via
 * `getCurrentItem()`, validates the inbound props against its cached
 * `propsSpec`, and re-applies the patched entry through `applyItem`
 * — the same callback the push handler uses, so the React update
 * surface is unified.
 *
 * Skips when:
 *   - `stackItemId` is empty or not a string.
 *   - `props` is null / not an object (defensive — server can't emit
 *     this shape, but the dispatcher routes the frame on type alone).
 *   - No item is currently mounted (`getCurrentItem` returns null).
 *   - The current item's id doesn't match `payload.stackItemId` —
 *     the server may have raced ahead of an in-flight item swap.
 *   - The current item is `mcpApps` / `system` (no `propsSpec`;
 *     server should never emit `props_update` for these).
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

import { validateInboundPropsPayload } from '../validation.js';

export interface PropsUpdateHandlerDeps {
  /**
   * Read the currently-mounted stack entry. Returns `null` when no
   * item has been mounted yet (the first push hasn't landed) or after
   * teardown. The handler short-circuits on `null` — `props_update`
   * before the first push has no React tree to patch.
   */
  readonly getCurrentItem: () => SessionStackEntry | null;
  /**
   * Re-apply the patched entry to the single mount slot. Shared with
   * the push handler so React updates flow through one path.
   */
  readonly applyItem: (item: SessionStackEntry) => Promise<void>;
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

      const current = deps.getCurrentItem();
      if (current === null) return;
      if (current.id !== stackItemId) return;
      if (current.type === 'mcpApps' || current.type === 'system') return;

      const result = validateInboundPropsPayload(current.propsSpec, props);
      if (!result.valid) return;

      await deps.applyItem({ ...current, props });
    },
  };
}
