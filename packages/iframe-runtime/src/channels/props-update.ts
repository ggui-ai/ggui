/**
 * `props_update` channel handler — patches the currently-mounted
 * render's props in place via the renderer's `applyRender`
 * callback.
 *
 * Post-stack-removal (2026-05-27): each iframe holds exactly one
 * mounted render. The handler reads the current render via
 * `getCurrentGguiSession()`, validates the inbound props against its
 * cached `propsSpec`, and re-applies the patched render through
 * `applyRender` — the same callback the render handler uses, so the
 * React update surface is unified.
 *
 * Skips when:
 *   - `sessionId` is empty or not a string.
 *   - `props` is null / not an object (defensive — server can't emit
 *     this shape, but the dispatcher routes the frame on type alone).
 *   - No render is currently mounted (`getCurrentGguiSession` returns null).
 *   - The current render's id doesn't match `payload.sessionId` —
 *     the server may have raced ahead of an in-flight render swap.
 *   - The current render is `mcpApps` / `system` (no `propsSpec`;
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
  GguiSession,
} from '@ggui-ai/protocol/wire';
import type { GguiSessionSeedInput } from '../types.js';

import { validateInboundPropsPayload } from '../validation.js';

export interface PropsUpdateHandlerDeps {
  /**
   * Read the currently-mounted render. Returns `null` when no
   * render has been mounted yet (the first render frame hasn't landed)
   * or after teardown. The handler short-circuits on `null` —
   * `props_update` before the first render frame has no React tree to
   * patch.
   */
  readonly getCurrentGguiSession: () => GguiSession | GguiSessionSeedInput | null;
  /**
   * Re-apply the patched render to the single mount slot. Shared with
   * the render-frame handler so React updates flow through one path.
   */
  readonly applyRender: (render: GguiSession | GguiSessionSeedInput) => Promise<void>;
  /**
   * This mount's OWN history epoch (#483 freeze latch). A
   * `props_update` frame carrying a HIGHER epoch means an
   * `ggui_update` minted a newer card and this one is now history —
   * the handler hands off to {@link onSuperseded} instead of applying.
   * Absent ⇒ 0 (a fresh render).
   */
  readonly getSelfEpoch?: () => number;
  /**
   * Invoked (once) when a higher-epoch update supersedes this mount.
   * The runtime freezes the frame: stop applying, tear down
   * subscriptions, disable dispatch, show the superseded cue.
   */
  readonly onSuperseded?: () => void;
  /**
   * True after this mount has frozen. When true the handler drops
   * every frame — a superseded mount never repaints again.
   */
  readonly isSuperseded?: () => boolean;
}

export function createPropsUpdateHandler(
  deps: PropsUpdateHandlerDeps,
): ChannelHandler<PropsUpdatePayload> {
  return {
    type: 'props_update',
    onMessage: async (payload) => {
      // Already frozen (#483): a superseded mount never repaints again.
      if (deps.isSuperseded?.() === true) return;

      const { sessionId, props, epoch } = payload;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;

      // Freeze latch (#483): a frame stamped with a HIGHER epoch than
      // this mount's own means a `ggui_update` minted a newer card —
      // this one is history. Do NOT apply; hand off to the freeze
      // routine. (`ggui_amend` carries the unchanged head epoch, so
      // amends to the live head still apply.)
      const selfEpoch = deps.getSelfEpoch?.() ?? 0;
      if (typeof epoch === 'number' && epoch > selfEpoch) {
        deps.onSuperseded?.();
        return;
      }

      if (props === null || typeof props !== 'object') return;

      const current = deps.getCurrentGguiSession();
      if (current === null) return;
      if (current.id !== sessionId) return;
      if (current.type === 'mcpApps' || current.type === 'system') return;

      const result = validateInboundPropsPayload(current.propsSpec, props);
      if (!result.valid) return;

      await deps.applyRender({ ...current, props });
    },
  };
}
