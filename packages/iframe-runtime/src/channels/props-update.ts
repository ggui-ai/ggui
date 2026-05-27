/**
 * `props_update` channel handler — patches the currently-mounted
 * render's props in place via the renderer's `applyRender`
 * callback.
 *
 * Post-stack-removal (2026-05-27): each iframe holds exactly one
 * mounted render. The handler reads the current render via
 * `getCurrentRender()`, validates the inbound props against its
 * cached `propsSpec`, and re-applies the patched render through
 * `applyRender` — the same callback the render handler uses, so the
 * React update surface is unified.
 *
 * Skips when:
 *   - `renderId` is empty or not a string.
 *   - `props` is null / not an object (defensive — server can't emit
 *     this shape, but the dispatcher routes the frame on type alone).
 *   - No render is currently mounted (`getCurrentRender` returns null).
 *   - The current render's id doesn't match `payload.renderId` —
 *     the server may have raced ahead of an in-flight render swap.
 *   - The current render is `mcpApps` / `system` (no `propsSpec`;
 *     server should never emit `props_update` for these).
 *   - The new props fail validation against the cached spec.
 *
 * R6 (2026-05-26) retired the per-handler polling descriptor. Polling
 * is now registry-level — the iframe-runtime composes the
 * `/api/renders/:id/state?wsToken=<token>` URL and a snapshot-parsing
 * function once at bind time (see `runtime.ts`); a single fetch per
 * tick projects the slice envelope into per-handler frames the
 * `PollingTransport` dispatches.
 */

import type { ChannelHandler } from '@ggui-ai/live-channel';
import type {
  PropsUpdatePayload,
  Render,
} from '@ggui-ai/protocol';

import { validateInboundPropsPayload } from '../validation.js';

export interface PropsUpdateHandlerDeps {
  /**
   * Read the currently-mounted render. Returns `null` when no
   * render has been mounted yet (the first render frame hasn't landed)
   * or after teardown. The handler short-circuits on `null` —
   * `props_update` before the first render frame has no React tree to
   * patch.
   */
  readonly getCurrentRender: () => Render | null;
  /**
   * Re-apply the patched render to the single mount slot. Shared with
   * the render-frame handler so React updates flow through one path.
   */
  readonly applyRender: (render: Render) => Promise<void>;
}

export function createPropsUpdateHandler(
  deps: PropsUpdateHandlerDeps,
): ChannelHandler<PropsUpdatePayload> {
  return {
    type: 'props_update',
    onMessage: async (payload) => {
      const { renderId, props } = payload;
      if (typeof renderId !== 'string' || renderId.length === 0) return;
      if (props === null || typeof props !== 'object') return;

      const current = deps.getCurrentRender();
      if (current === null) return;
      if (current.id !== renderId) return;
      if (current.type === 'mcpApps' || current.type === 'system') return;

      const result = validateInboundPropsPayload(current.propsSpec, props);
      if (!result.valid) return;

      await deps.applyRender({ ...current, props });
    },
  };
}
