/**
 * `WSTransport` — opens one WebSocket, dispatches inbound frames
 * to a registered handler-map by `type`. Auto-reconnect with
 * exponential backoff; on close code 1012 (service_restart) the
 * first retry skips backoff so end-users don't see a multi-second
 * blink mid-session.
 *
 * Lifted from `iframe-runtime/src/ws-manager.ts` with the
 * subscribe-frame composition kept opaque (caller supplies it via
 * `subscribeFrame` factory). Outbound frames are queued while
 * connecting; the queue drains on `open`.
 */

import type {
  ChannelFrame,
  ChannelHandler,
  ChannelLogger,
  TransportStatus,
  WsTransportHandle,
} from './types.js';

const PING_INTERVAL_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const CLOSE_CODE_SERVICE_RESTART = 1012;
const SERVICE_RESTART_RECONNECT_DELAY_MS = 100;
/**
 * Fail-fast threshold for never-opened-close events. If `onopen` never
 * fires before `onclose` arrives more than this many times in a row, we
 * assume the destination is structurally unreachable (host CSP blocks
 * `wss://`, sandbox attribute prohibits, etc.) rather than transiently
 * dropping and stop the reconnect ladder immediately.
 *
 * Empirical motivation: Claude Desktop's iframe sandbox does not honor
 * our `_meta.ui.csp.connectDomains` declaration for `wss://`. The
 * browser refuses the handshake before any TCP attempt, the socket
 * closes immediately, and the default reconnect ladder
 * (1+2+4+8+16+32+60+60+60+60s ≈ 5min) burns a UX-relevant amount of
 * time with no chance of success. Two fast fails (≈ 1.1s combined)
 * gives us enough signal to pivot to `PollingTransport` via
 * `FailoverHandle` without false-positiving on a single packet loss.
 */
const NEVER_OPENED_FAIL_FAST_THRESHOLD = 2;
// Bumped from 50 → 500 at B3 (parity with the retired
// `RendererWebSocketManager`) — chatty outbound frames during a long
// disconnect can buffer more than 50 outbound frames before the
// reconnect ladder lands.
const OUTBOUND_QUEUE_LIMIT = 500;

/**
 * Frame factory the caller supplies — the subscribe frame composed
 * from `(sessionId, appId, bootstrap-token)`. Lives at the call site
 * so the library stays protocol-agnostic.
 */
export type SubscribeFrameBuilder = () => unknown;

export interface WSTransportOptions {
  readonly url: string;
  readonly subscribeFrame: SubscribeFrameBuilder;
  readonly handlers: ReadonlyMap<string, ChannelHandler>;
  readonly logger?: ChannelLogger;
  /**
   * Test hook — inject a WebSocket factory. Defaults to
   * `globalThis.WebSocket`. Tests pass a mock to exercise the
   * lifecycle without a real socket.
   */
  readonly webSocketFactory?: (url: string) => WebSocket;
  /**
   * Fires on every status transition. Lets the protocol-aware wrapper
   * in iframe-runtime surface connect / reconnect / failure to the
   * renderer's status DOM + observability emitter without reaching
   * into transport internals.
   */
  readonly onStatusChange?: (status: TransportStatus) => void;
}

class BoundedQueue {
  private readonly items: unknown[] = [];
  constructor(private readonly limit: number) {}
  push(item: unknown): void {
    if (this.items.length >= this.limit) this.items.shift();
    this.items.push(item);
  }
  drain(): unknown[] {
    const out = this.items.splice(0);
    return out;
  }
}

export class WSTransport implements WsTransportHandle {
  readonly kind = 'ws' as const;
  private socket: WebSocket | null = null;
  private readonly queue = new BoundedQueue(OUTBOUND_QUEUE_LIMIT);
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private currentStatus: TransportStatus = 'connecting';
  /**
   * Per-attempt flag — flipped to `true` inside `onopen` so a subsequent
   * `onclose` can distinguish "WS connected then dropped" (transient,
   * keep retrying) from "WS never opened" (host CSP / sandbox refusal,
   * structurally unreachable). Reset to `false` at the start of every
   * fresh `start()` call.
   */
  private wasOpenedThisAttempt = false;
  /**
   * Count of consecutive attempts that fired `onclose` without ever
   * firing `onopen` first. Hitting `NEVER_OPENED_FAIL_FAST_THRESHOLD`
   * trips fail-fast — we set `status='failed'` immediately instead of
   * burning the full retry ladder, so the caller (`FailoverHandle`)
   * can pivot to `PollingTransport` quickly.
   *
   * Resets to zero on every successful `onopen` so a session that
   * connects, drops, and re-connects doesn't accumulate stale signal.
   */
  private consecutiveNeverOpenedCloses = 0;

  constructor(private readonly opts: WSTransportOptions) {}

  get status(): TransportStatus {
    return this.currentStatus;
  }

  /**
   * Open the connection. Idempotent against the disposed flag —
   * calling after `dispose()` is a no-op.
   */
  start(): void {
    if (this.disposed) return;
    this.setStatus('connecting');
    // Reset per-attempt open flag. The consecutive-never-opened counter
    // is intentionally NOT reset here — its purpose is to detect a
    // streak across attempts.
    this.wasOpenedThisAttempt = false;

    const factory =
      this.opts.webSocketFactory ??
      ((url: string) => new WebSocket(url));

    let socket: WebSocket;
    try {
      socket = factory(this.opts.url);
    } catch (err) {
      this.opts.logger?.warn?.('channel_ws_construct_failed', {
        url: this.opts.url,
        error: err instanceof Error ? err.message : String(err),
      });
      this.setStatus('failed');
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.disposed) return;
      this.reconnectAttempts = 0;
      // Mark this attempt as having opened. A subsequent close is
      // transient (drop after successful connect), NOT structural
      // unreachability — reset the consecutive-never-opened streak.
      this.wasOpenedThisAttempt = true;
      this.consecutiveNeverOpenedCloses = 0;
      try {
        socket.send(JSON.stringify(this.opts.subscribeFrame()));
      } catch (err) {
        this.opts.logger?.warn?.('channel_ws_subscribe_send_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.setStatus('open');
      this.flushQueue();
      this.startPing();
    };

    socket.onmessage = (event) => {
      if (this.disposed) return;
      let parsed: ChannelFrame;
      try {
        parsed = JSON.parse(event.data as string) as ChannelFrame;
      } catch {
        // Malformed JSON — drop. One bad frame can't take the loop down.
        return;
      }
      // Pong is purely a heartbeat ack; not routable.
      if (parsed.type === 'pong') return;
      this.dispatch(parsed);
    };

    socket.onclose = (event) => {
      if (this.disposed) return;
      this.stopPing();
      this.setStatus('closed');
      // Fail-fast on never-opened-close streak. The browser refuses
      // CSP-blocked `wss://` BEFORE handshake — no `onopen`, immediate
      // `onclose`. Two such fails in a row signal structural blockage
      // (not a transient drop); bail out of the retry ladder so the
      // caller (FailoverHandle) can pivot to PollingTransport.
      if (!this.wasOpenedThisAttempt) {
        this.consecutiveNeverOpenedCloses += 1;
        if (
          this.consecutiveNeverOpenedCloses >= NEVER_OPENED_FAIL_FAST_THRESHOLD
        ) {
          this.opts.logger?.warn?.('channel_ws_fail_fast', {
            url: this.opts.url,
            consecutive_never_opened: this.consecutiveNeverOpenedCloses,
            close_code: event?.code,
            reason:
              'WS never opened on consecutive attempts — assumed structurally blocked (CSP / sandbox). Bailing out of retry ladder.',
          });
          this.setStatus('failed');
          return;
        }
      }
      const isServiceRestart = event?.code === CLOSE_CODE_SERVICE_RESTART;
      const isFirstRetryAfterServiceRestart =
        isServiceRestart && this.reconnectAttempts === 0;
      if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts += 1;
        const delay = isFirstRetryAfterServiceRestart
          ? SERVICE_RESTART_RECONNECT_DELAY_MS
          : Math.min(
              INITIAL_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
              MAX_RECONNECT_DELAY_MS,
            );
        this.reconnectTimer = setTimeout(() => {
          if (this.disposed) return;
          this.start();
        }, delay);
      } else {
        this.setStatus('failed');
      }
    };

    socket.onerror = () => {
      // Error events forward to onclose; nothing actionable here.
    };
  }

  /**
   * Queue an outbound frame. Sends immediately if the socket is open;
   * otherwise queues for drain on next `open`. Capped at
   * `OUTBOUND_QUEUE_LIMIT` so a slow/dead socket can't blow heap.
   */
  send(frame: unknown): void {
    if (this.disposed) return;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(frame));
      } catch (err) {
        this.opts.logger?.warn?.('channel_ws_send_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    this.queue.push(frame);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      try {
        this.socket.close();
      } catch {
        /* already closing */
      }
    }
    this.socket = null;
    this.setStatus('closed');
  }

  private dispatch(frame: ChannelFrame): void {
    const handler = this.opts.handlers.get(frame.type);
    if (!handler) return;
    try {
      const result = handler.onMessage(frame.payload);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          this.opts.logger?.warn?.('channel_handler_throw', {
            type: frame.type,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      this.opts.logger?.warn?.('channel_handler_throw', {
        type: frame.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private flushQueue(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const items = this.queue.drain();
    for (const item of items) {
      try {
        this.socket.send(JSON.stringify(item));
      } catch {
        // Send error during flush — re-queue and bail; next open
        // will retry.
        this.queue.push(item);
        return;
      }
    }
  }

  private startPing(): void {
    if (this.pingInterval !== null) return;
    this.pingInterval = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify({ type: 'ping', payload: {} }));
        } catch {
          /* will surface via onclose */
        }
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private setStatus(next: TransportStatus): void {
    if (this.currentStatus === next) return;
    this.currentStatus = next;
    try {
      this.opts.onStatusChange?.(next);
    } catch (err) {
      this.opts.logger?.warn?.('channel_status_listener_throw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
