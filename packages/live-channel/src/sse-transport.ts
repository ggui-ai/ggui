/**
 * `SSETransport` — opens one `EventSource`, dispatches inbound frames
 * to a registered handler-map by `type`. Every SSE `data:` line is
 * exactly one `ChannelFrame` `{type, payload}` JSON — byte-same shape
 * as the WS push — so dispatch mirrors `WSTransport.onmessage`
 * line-for-line. SSE is inbound-only: there is no subscribe frame and
 * no outbound channel — the URL path + wsToken query IS the
 * subscription.
 *
 * Failure policy (how `'failed'` is DECIDED for an auto-reconnecting
 * EventSource — the browser never terminates its own retry loop from
 * readyState CONNECTING, so the transport bounds it):
 *
 *   (a) Missing `EventSource` global (Node < 22, locked-down hosts) or
 *       any constructor throw → immediate `'failed'`.
 *   (b) Liveness watchdog: no `open`/`message` activity for 2× the
 *       server heartbeat cadence (50s) → `'failed'`. Heartbeat
 *       comment lines (`: hb`) are invisible to the JS API, so each
 *       watchdog tick also treats `readyState === OPEN` as liveness —
 *       a quiet-but-alive stream is never demoted.
 *   (c) `onerror` with `readyState === CLOSED` (non-200, wrong
 *       content-type, CORS — the browser never retries from CLOSED):
 *       recreate the instance once; a second consecutive terminal
 *       close → `'failed'` (mirrors the WS 2-strike never-opened
 *       precedent).
 *
 * Resume cursors: the first connect appends `&sinceSequence=<n>` from
 * `RegistrySseOptions.initialSinceSequence`; browser-internal
 * reconnects stamp the `Last-Event-ID` header (which the server
 * prefers over the query param); manual recreates re-seed the query
 * from the latest dispatched sequence so a recreate resumes instead
 * of replaying.
 */

import type {
  ChannelFrame,
  ChannelHandler,
  ChannelLogger,
  RegistrySseOptions,
  SseTransportHandle,
  TransportStatus,
} from './types.js';

/**
 * Server-side heartbeat cadence (`: hb` comment every 25s — an
 * ALB-idle-timeout concern; comments never reach `onmessage`). The
 * client never parses heartbeats — this constant exists only as the
 * base for the liveness watchdog floor below.
 */
const SSE_HEARTBEAT_MS = 25_000;
/**
 * Liveness floor: no `open`/`message` activity (and readyState not
 * OPEN at any watchdog tick) for 2× the heartbeat cadence →
 * `'failed'`. Converts the browser's unbounded silent CONNECTING
 * retry loop into a bounded demotion signal.
 */
const SSE_LIVENESS_WATCHDOG_MS = 2 * SSE_HEARTBEAT_MS;
/**
 * Delay before recreating an instance after a terminal close
 * (readyState CLOSED — the browser never retries from CLOSED).
 */
const SSE_RECREATE_DELAY_MS = 1_000;
/**
 * Consecutive terminal closes (readyState CLOSED in `onerror`,
 * without an intervening `open`) before the transport declares
 * `'failed'` instead of recreating again. Mirrors the WS
 * `NEVER_OPENED_FAIL_FAST_THRESHOLD` precedent: two structural
 * refusals in a row signal an unreachable endpoint, not a blip.
 */
const SSE_TERMINAL_CLOSE_FAIL_FAST_THRESHOLD = 2;

// EventSource readyState values as local constants — referencing
// `EventSource.OPEN` would throw ReferenceError in environments
// without the global (jsdom, Node < 22), which this transport must
// tolerate at runtime.
const ES_READY_STATE_OPEN = 1;
const ES_READY_STATE_CLOSED = 2;

export interface SSETransportOptions {
  readonly sse: RegistrySseOptions;
  readonly handlers: ReadonlyMap<string, ChannelHandler>;
  readonly logger?: ChannelLogger;
  /**
   * Test hook — inject an EventSource factory. Defaults to
   * `globalThis.EventSource`. jsdom has no EventSource and Node < 22
   * has no global: absence is caught by the construct guard and maps
   * to status `'failed'` (the failover ladder demotes to polling).
   */
  readonly eventSourceFactory?: (url: string) => EventSource;
  /**
   * Fires on every status transition. `'failed'` is the demotion
   * trigger the failover ladder intercepts.
   */
  readonly onStatusChange?: (status: TransportStatus) => void;
}

export class SSETransport implements SseTransportHandle {
  readonly kind = 'sse' as const;
  private source: EventSource | null = null;
  private disposed = false;
  private currentStatus: TransportStatus = 'connecting';
  /**
   * Count of consecutive `onerror` events at readyState CLOSED without
   * an intervening `open`. Hitting
   * `SSE_TERMINAL_CLOSE_FAIL_FAST_THRESHOLD` trips `'failed'` instead
   * of another recreate. Resets on every successful `open`.
   */
  private consecutiveTerminalCloses = 0;
  private recreateTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** Epoch ms of the last observed liveness signal (start/open/message/OPEN-at-tick). */
  private lastActivityAt = 0;
  /**
   * Latest ledger sequence dispatched by this transport (parsed from
   * `event.lastEventId`). Used to re-seed the `sinceSequence` query
   * on manual recreates so they resume instead of replaying from the
   * initial seed.
   */
  private lastSequence: number | undefined = undefined;

  constructor(private readonly opts: SSETransportOptions) {}

  get status(): TransportStatus {
    return this.currentStatus;
  }

  /**
   * (Re)create the EventSource. Idempotent against the disposed flag —
   * calling after `dispose()` is a no-op.
   */
  start(): void {
    if (this.disposed) return;
    // A manual start() supersedes any scheduled recreate — clear it so
    // the two paths can't double-create.
    if (this.recreateTimer !== null) {
      clearTimeout(this.recreateTimer);
      this.recreateTimer = null;
    }
    // Close any previous instance so a stale source can't keep
    // dispatching alongside the new one (recreate paths arrive here
    // with the old instance already CLOSED; manual re-arms may not).
    this.source?.close();
    this.source = null;
    this.setStatus('connecting');

    const factory =
      this.opts.eventSourceFactory ??
      ((url: string) => new EventSource(url));

    let source: EventSource;
    try {
      source = factory(this.composeUrl());
    } catch (err) {
      // Missing global (ReferenceError), CSP refusal, malformed URL —
      // structurally unable to stream. The ladder demotes to polling.
      this.enterFailed('channel_sse_construct_failed', {
        url: this.opts.sse.url,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.source = source;
    this.lastActivityAt = Date.now();
    this.armWatchdog();

    source.onopen = () => {
      if (this.disposed) return;
      this.lastActivityAt = Date.now();
      // A successful open is proof the endpoint is reachable — reset
      // the terminal-close streak (parity with the WS never-opened
      // streak reset in `onopen`).
      this.consecutiveTerminalCloses = 0;
      this.setStatus('open');
    };

    source.onmessage = (event) => {
      if (this.disposed) return;
      this.lastActivityAt = Date.now();
      let parsed: ChannelFrame;
      try {
        parsed = JSON.parse(event.data as string) as ChannelFrame;
      } catch {
        // Malformed JSON — drop. One bad frame can't take the loop down.
        return;
      }
      // Pong is a WS heartbeat ack — kept for wire parity; not routable.
      if (parsed.type === 'pong') return;
      this.dispatch(parsed);
      // Cursor bridge: the server stamps `id:` = ledger sequence on
      // ledger-backed replay frames (live frames are id-less).
      if (typeof event.lastEventId === 'string' && event.lastEventId !== '') {
        const sequence = Number(event.lastEventId);
        if (Number.isInteger(sequence) && sequence >= 0) {
          this.lastSequence = sequence;
          this.opts.sse.onSequence?.(sequence);
        }
      }
    };

    source.onerror = () => {
      if (this.disposed) return;
      if (source.readyState === ES_READY_STATE_CLOSED) {
        // Terminal instance death (non-200 / wrong content-type /
        // CORS) — the browser will NOT retry from CLOSED.
        this.consecutiveTerminalCloses += 1;
        if (
          this.consecutiveTerminalCloses >=
          SSE_TERMINAL_CLOSE_FAIL_FAST_THRESHOLD
        ) {
          this.enterFailed('channel_sse_fail_fast', {
            url: this.opts.sse.url,
            consecutive_terminal_closes: this.consecutiveTerminalCloses,
            reason:
              'EventSource closed terminally on consecutive instances — assumed structurally unreachable (non-200 / content-type / CORS). Bailing out.',
          });
          return;
        }
        this.setStatus('closed');
        this.recreateTimer = setTimeout(() => {
          if (this.disposed) return;
          this.recreateTimer = null;
          this.start();
        }, SSE_RECREATE_DELAY_MS);
        return;
      }
      // readyState CONNECTING — the browser owns the retry loop
      // (cadence server-tunable via `retry:`). The liveness watchdog
      // bounds a hopeless loop; nothing to schedule here.
      this.setStatus('connecting');
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.source?.close();
    this.source = null;
    this.setStatus('closed');
  }

  /**
   * Compose the connect URL. First connect seeds the replay cursor
   * from `initialSinceSequence`; manual recreates prefer the latest
   * dispatched sequence. Browser-internal reconnects additionally
   * stamp the `Last-Event-ID` header, which the server prefers over
   * this query param.
   */
  private composeUrl(): string {
    const { url, initialSinceSequence } = this.opts.sse;
    const cursor = this.lastSequence ?? initialSinceSequence;
    if (cursor === undefined) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}sinceSequence=${cursor}`;
  }

  private armWatchdog(): void {
    if (this.watchdogTimer !== null) return;
    this.watchdogTimer = setInterval(() => {
      if (this.disposed) return;
      if (
        this.source !== null &&
        this.source.readyState === ES_READY_STATE_OPEN
      ) {
        // Heartbeat comments (`: hb`) never reach `onmessage` —
        // readyState OPEN at tick time counts as liveness so a
        // quiet-but-alive stream is never demoted.
        this.lastActivityAt = Date.now();
        return;
      }
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs >= SSE_LIVENESS_WATCHDOG_MS) {
        this.enterFailed('channel_sse_watchdog_expired', {
          url: this.opts.sse.url,
          idle_ms: idleMs,
          ready_state: this.source === null ? null : this.source.readyState,
        });
      }
    }, SSE_HEARTBEAT_MS);
  }

  /** Terminal failure: log, tear down the instance + timers, emit `'failed'`. */
  private enterFailed(event: string, fields: Record<string, unknown>): void {
    this.opts.logger?.warn?.(event, fields);
    this.clearTimers();
    this.source?.close();
    this.source = null;
    this.setStatus('failed');
  }

  private clearTimers(): void {
    if (this.recreateTimer !== null) {
      clearTimeout(this.recreateTimer);
      this.recreateTimer = null;
    }
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
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
