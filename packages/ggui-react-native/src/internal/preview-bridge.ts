/**
 * preview-bridge — platform-agnostic pub/sub for live-channel StreamEnvelopes
 * inside React Native.
 *
 * Why a bridge: on Expo Web the existing client dispatches `data`
 * envelopes as window CustomEvents (`BRIDGE_EVENTS.AGENT_DATA`).
 * On iOS / Android there's no `window`, so every consumer that wants
 * to observe live-channel deliveries needs a native-safe seam. This
 * module is that seam — a minimal in-process emitter keyed by
 * subscriber function.
 *
 * Scope discipline:
 *
 *   - Internal-only. Not exported from the package root. Only the
 *     renderer's internal `useChannelStream` subscribes. The emitter
 *     seat is VACANT since the legacy `GguiRender` WS path was
 *     deleted (ggui#425) — the future native A2UI transport re-wires
 *     it when it lands.
 *   - Knows nothing about A2UI, preview surfaces, or channel naming
 *     policies. It's a dumb fan-out over `StreamEnvelope` — reserved
 *     channel semantics live in `@ggui-ai/protocol`.
 *   - No persistence, no buffering, no replay. If a subscriber
 *     attaches after an emit it simply misses that emit — same
 *     "live tail only" rule the web `window.addEventListener` seam
 *     already has.
 *
 * The module-level `Set<Listener>` is intentional: React contexts
 * would force every renderer consumer into a subscription, and
 * we want the fan-out to be opt-in per renderer call. Keeping the
 * emitter as a JS singleton matches the one-WebSocket-per-app
 * reality on native and keeps cross-platform parity trivial.
 */
import type { StreamEnvelope } from '@ggui-ai/protocol';

/** Subscriber callback signature. */
export type PreviewBridgeListener = (envelope: StreamEnvelope) => void;

const listeners = new Set<PreviewBridgeListener>();

/**
 * Broadcast a delivery to every subscriber. The transport that owns
 * the live channel calls this after any reserved-channel bypass /
 * streamSpec validation has run — subscribers see only envelopes the
 * transport decided to forward. (No production emitter exists today;
 * see the header note.)
 */
export function emitPreviewBridge(envelope: StreamEnvelope): void {
  // Copy the listener set before iterating so a listener that
  // unsubscribes during delivery doesn't mutate the set we're
  // walking.
  for (const listener of [...listeners]) {
    try {
      listener(envelope);
    } catch {
      // Listener threw — isolate the fault so one subscriber can't
      // bring down the others. Not logged here; the renderer's own
      // error boundary surfaces rendering failures downstream.
    }
  }
}

/**
 * Subscribe to the bridge. Returns a disposer that removes the
 * listener from the set.
 */
export function subscribePreviewBridge(
  listener: PreviewBridgeListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Clear all listeners. Exported only for test isolation — production
 * code doesn't tear down the bridge.
 * @internal
 */
export function __resetPreviewBridgeForTests(): void {
  listeners.clear();
}
