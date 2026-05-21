/**
 * Display-mode escalation policy.
 *
 * Pure functions that decide which `ui/request-display-mode` value the
 * canvas should request based on:
 *   - the host's declared `availableDisplayModes` (from `McpUiHostContext`)
 *   - the canvas's content state (empty vs. has-content)
 *   - the host's current `displayMode`
 *
 * The rules implement this core matrix:
 *
 *   ┌─────────────────────────────┬──────────────────────────┐
 *   │ canvas state                │ requested target         │
 *   ├─────────────────────────────┼──────────────────────────┤
 *   │ mounted, navStack empty     │ pip (fallback inline)    │
 *   │ navStack has ≥1 item        │ fullscreen (then pip,    │
 *   │                             │ then inline)             │
 *   └─────────────────────────────┴──────────────────────────┘
 *
 *   - Never request `fullscreen` when the canvas is empty (taking over
 *     the whole screen to show a single pill is hostile UX).
 *   - For content state, prefer `fullscreen` > `pip` > `inline`.
 *   - `inline` is the silent fallback when neither `pip` nor
 *     `fullscreen` is available — the canvas renders inside whatever
 *     box the host gives it, no escalation request fires.
 *
 * Boundary discipline:
 *
 *   - No DOM, no postMessage, no React. The reconciler returns a
 *     decision ('request X' or 'do nothing'); the caller fires the
 *     request via the iframe-runtime's existing
 *     `requestDisplayModeInParent()` seam.
 *   - No HTTP, no IO. Every input is a value; the function is
 *     referentially transparent so tests don't need mocks.
 *   - No subscriptions, no listeners. The reconciler is called by the
 *     canvas shell at navStack transitions + on
 *     `ui/notifications/host-context-changed` notifications.
 *
 * Why pure functions: the policy IS the contract between the host's
 * capability surface and ggui's user-experience guarantees. Testing it
 * exhaustively requires nothing but a value-in / value-out matrix.
 */

import type { McpUiDisplayMode } from '@ggui-ai/protocol';

/**
 * What the canvas should request when navStack is empty (just the
 * animator pill visible). Never returns `'fullscreen'` — fullscreen
 * with no content is hostile UX.
 *
 *   - `['pip']` or supersets containing pip → `'pip'`
 *   - everything else → `'inline'`
 *
 * Treats absent / empty `available` as `['inline']`-only.
 */
export function pickEmptyStateMode(
  available: readonly McpUiDisplayMode[] | undefined,
): McpUiDisplayMode {
  if (!available || available.length === 0) return 'inline';
  if (available.includes('pip')) return 'pip';
  return 'inline';
}

/**
 * What the canvas should request when navStack has ≥1 item (content
 * is visible; pill compressed into navbar). Prefers `fullscreen` for
 * the most prominent presentation; falls back to `pip` then `inline`.
 *
 *   - `'fullscreen'` if available
 *   - else `'pip'` if available
 *   - else `'inline'`
 *
 * Treats absent / empty `available` as `['inline']`-only.
 */
export function pickContentStateMode(
  available: readonly McpUiDisplayMode[] | undefined,
): McpUiDisplayMode {
  if (!available || available.length === 0) return 'inline';
  if (available.includes('fullscreen')) return 'fullscreen';
  if (available.includes('pip')) return 'pip';
  return 'inline';
}

/**
 * Decision for the reconciler. The canvas calls
 * {@link reconcileDisplayMode} on every state change; the result tells
 * it whether to fire a `ui/request-display-mode` postMessage.
 *
 *   - `{ kind: 'noop' }` — already at target; nothing to do. Skips
 *     postMessage + audit envelope traffic.
 *   - `{ kind: 'request', mode }` — fire the request.
 */
export type DisplayModeDecision =
  | { readonly kind: 'noop' }
  | { readonly kind: 'request'; readonly mode: McpUiDisplayMode };

/**
 * State the reconciler considers.
 *
 *   - `available` — host's declared `availableDisplayModes`.
 *   - `current` — host's current `displayMode`.
 *   - `contentState` — whether the canvas's navStack has content.
 */
export interface DisplayModePolicyInput {
  readonly available: readonly McpUiDisplayMode[] | undefined;
  readonly current: McpUiDisplayMode | undefined;
  readonly contentState: 'empty' | 'has-content';
}

/**
 * Compute whether a display-mode change should be requested. Returns
 * `noop` when current already matches the policy target (saves
 * postMessage round-trips + audit-envelope noise on no-ops).
 *
 * When `current` is undefined (host hasn't reported a mode yet), the
 * reconciler treats it as `'inline'` and fires a request to the
 * policy target — matches the worst-case assumption that the host
 * started in inline.
 */
export function reconcileDisplayMode(
  input: DisplayModePolicyInput,
): DisplayModeDecision {
  const target =
    input.contentState === 'empty'
      ? pickEmptyStateMode(input.available)
      : pickContentStateMode(input.available);
  const current = input.current ?? 'inline';
  if (current === target) return { kind: 'noop' };
  return { kind: 'request', mode: target };
}
