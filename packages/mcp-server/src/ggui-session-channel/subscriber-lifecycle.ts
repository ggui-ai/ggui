/**
 * WS subscriber lifecycle for the live channel — registration into the
 * shared subscriber set, the per-subscriber live-tail pump loop, and
 * the symmetric teardown path (`unregister`) that ends the pump,
 * unhooks the StreamFanout subscription, and clears every
 * `channel_subscribe` polling loop the subscriber owned.
 *
 * Owns the per-render subscriber counter that drives the
 * `onFirstSubscriber` / `onLastSubscriberGone` 0↔1 transition hooks —
 * no other module reads it.
 */

import type { WebSocketMessage } from "@ggui-ai/protocol/transport/websocket";
import type { WebSocket } from "ws";
import type { Logger } from "../logger.js";
import type { Subscriber } from "./internal-types.js";

export interface SubscriberLifecycleDeps {
  readonly logger: Logger;
  /** Flat set of all live WS subscribers — membership owned HERE. */
  readonly wsSubscribers: Set<Subscriber>;
  /** ws → subscriber reverse index so socket-close can look up cheaply. */
  readonly subscribersByWs: WeakMap<WebSocket, Subscriber>;
  /** Low-level wire write from the outbound module. */
  readonly send: (ws: WebSocket, msg: WebSocketMessage) => void;
  /** 0→1 transition hook — see `GguiSessionChannelOptions.onFirstSubscriber`. */
  readonly onFirstSubscriber?: (sessionId: string) => void;
  /** 1→0 transition hook — see `GguiSessionChannelOptions.onLastSubscriberGone`. */
  readonly onLastSubscriberGone?: (sessionId: string) => void;
}

export interface SubscriberLifecycle {
  /** Add a subscriber to the live set and start its pump loop. */
  register(sub: Subscriber): void;
  /**
   * Tear down the subscriber bound to `ws` (if any): remove from the
   * live set, end the fanout iterator (terminates the pump), clear
   * every channel-subscribe polling timer. Idempotent.
   */
  unregister(ws: WebSocket): void;
}

export function createSubscriberLifecycle(deps: SubscriberLifecycleDeps): SubscriberLifecycle {
  /**
   * Per-render local subscriber count. Drives the
   * `onFirstSubscriber` / `onLastSubscriberGone` 0↔1 transition hooks
   * multi-process deployments use for per-render cross-process pub/sub
   * channel scoping. Distinct from the channel server's `renderCount`
   * getter — that walks `wsSubscribers` on demand; this map is the
   * registration-time counter the hooks key off.
   */
  const renderCountById = new Map<string, number>();

  /**
   * Pump live frames from the StreamFanout iterator out to this
   * subscriber's WS. Started fire-and-forget by `register`; ends when
   * the iterator yields done (close() on the seam) OR `unregister`
   * calls `iter.return()`. Per-subscriber seq filter applied here:
   * frames with `seq <= replayCompletedSeq` were (or will be)
   * delivered via the replay path on subscribe.
   *
   * The pump's first action is `await iter.next()`, which yields
   * control back to the event loop. This is what preserves the
   * subscribe-handler ordering invariant: ack → replay frames →
   * live frames. The replay-frame send loop completes synchronously
   * before the pump can ever send anything, regardless of fanout
   * timing.
   */
  async function pumpSubscriber(sub: Subscriber): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await sub.iter.next();
        if (done) return;
        if (value.seq <= sub.replayCompletedSeq) continue;
        if (sub.ws.readyState !== sub.ws.OPEN) {
          await sub.iter.return?.();
          return;
        }
        deps.send(sub.ws, { type: "data", payload: value });
      }
    } catch (err) {
      deps.logger.warn("render_channel_pump_failed", {
        sessionId: sub.sessionId,
        error: String(err),
      });
    }
  }

  function register(sub: Subscriber): void {
    deps.wsSubscribers.add(sub);
    deps.subscribersByWs.set(sub.ws, sub);
    // Per-render count bookkeeping + 0→1 hook for cloud pubsub
    // adapter scoping. Increment FIRST so the hook sees the up-to-date
    // state; hook fires only on the transition (prevCount === 0).
    const prevCount = renderCountById.get(sub.sessionId) ?? 0;
    renderCountById.set(sub.sessionId, prevCount + 1);
    if (prevCount === 0 && deps.onFirstSubscriber) {
      try {
        deps.onFirstSubscriber(sub.sessionId);
      } catch (err) {
        // Best-effort: a thrown hook MUST NOT corrupt the
        // wsSubscribers set vs the real socket lifecycle.
        deps.logger.warn("render_channel_on_first_subscriber_threw", {
          sessionId: sub.sessionId,
          error: String(err),
        });
      }
    }
    // Start the pump loop. Fire-and-forget — pump errors are logged
    // inside pumpSubscriber, never propagated.
    void pumpSubscriber(sub);
  }

  function unregister(ws: WebSocket): void {
    const sub = deps.subscribersByWs.get(ws);
    if (!sub) return;
    deps.subscribersByWs.delete(ws);
    deps.wsSubscribers.delete(sub);
    // Per-render count bookkeeping + 1→0 hook (symmetric with register).
    const prevCount = renderCountById.get(sub.sessionId) ?? 0;
    if (prevCount <= 1) {
      renderCountById.delete(sub.sessionId);
      if (prevCount === 1 && deps.onLastSubscriberGone) {
        try {
          deps.onLastSubscriberGone(sub.sessionId);
        } catch (err) {
          deps.logger.warn("render_channel_on_last_subscriber_gone_threw", {
            sessionId: sub.sessionId,
            error: String(err),
          });
        }
      }
    } else {
      renderCountById.set(sub.sessionId, prevCount - 1);
    }
    // Ending the iter terminates pumpSubscriber AND unregisters this
    // subscriber from the StreamFanout. Idempotent on the seam side
    // (close-after-return is a no-op).
    void sub.iter.return?.();
    // Tear down every `channel_subscribe` polling loop owned
    // by this subscriber. Symmetric with stream-iterator teardown
    // above. clearInterval is idempotent on already-cleared handles,
    // so a concurrent channel_unsubscribe + WS close is safe.
    for (const state of sub.channelSubs.values()) {
      clearInterval(state.timer);
    }
    sub.channelSubs.clear();
  }

  return { register, unregister };
}
