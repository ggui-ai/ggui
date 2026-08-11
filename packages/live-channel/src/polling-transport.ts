/**
 * `PollingTransport` — registry-level HTTP polling for clients without
 * WebSocket access (locked-down enterprise hosts, future server-side /
 * native SDK consumers, or as a failover when `WSTransport`'s reconnect
 * budget runs out).
 *
 * R6 (2026-05-26) collapsed the pre-R6 per-handler polling descriptor
 * shape into a single registry-level descriptor
 * ({@link RegistryPollingOptions}). One URL, one tick interval, one
 * snapshot parser. The consumer composes the snapshot URL (e.g.
 * `/api/sessions/:id/state?wsToken=<token>`) and supplies a
 * `parseSnapshot` closure that returns a `Record<type, frame>` map
 * (or `null` to short-circuit when nothing changed since the last
 * poll).
 *
 * Each tick fires ONE carrier call — an HTTP `fetch()` of
 * `polling.url`, or `polling.fetchBody()` for the bridge-pull rung
 * (CSP-jailed MCP-Apps iframes pulling the event ledger over the
 * host's `tools/call` postMessage bridge; the resolved value IS the
 * body — no `res.ok` / `.json()` step). Exactly one of the two
 * carriers must be set; a descriptor violating that fails at
 * `start()` (status `'failed'` + log, mirroring the WS
 * constructor-throw route). For every entry in the parsed map the
 * transport looks up the handler by `type` in the registry's handler
 * map and calls `handler.onMessage(frame.payload)`.
 *
 * Failures are absorbed and logged; the loop keeps trying on the
 * next tick. By default errors never escalate to `'failed'` status
 * because the NEXT poll might succeed (transient network blip) — the
 * terminal-rung posture. With a `failureBudget` configured (the
 * registry injects one into the HTTP polling rung when a bridge rung
 * sits below it), N CONSECUTIVE tick failures (carrier throw/reject
 * or `!res.ok`; any success resets the count) stop the timer and
 * report `'failed'` so the failover ladder can demote.
 *
 * No polling descriptor on `BindOptions` → the transport has nothing
 * to poll. It still satisfies the `PollingTransportHandle` contract;
 * status transitions to `'open'` and stays there (no fetches fire,
 * handlers stay inert). Used by tests + the `WSTransport`-only path
 * when callers don't opt into the polling fallback.
 */

import type {
  ChannelFrame,
  ChannelHandler,
  ChannelLogger,
  PollingTransportHandle,
  RegistryPollingOptions,
  TransportStatus,
} from './types.js';

const DEFAULT_MIN_POLL_INTERVAL_MS = 500;

export interface PollingTransportOptions {
  readonly handlers: ReadonlyMap<string, ChannelHandler>;
  readonly logger?: ChannelLogger;
  /**
   * Floor for the polling interval. Defaults to 500ms — `polling.intervalMs`
   * smaller than this is clamped.
   */
  readonly minPollIntervalMs?: number;
  /**
   * Test hook — inject a fetch impl. Defaults to `globalThis.fetch`.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Registry-level polling descriptor (R6). When absent, the transport
   * runs but never fetches — handlers stay inert.
   */
  readonly polling?: RegistryPollingOptions;
  /**
   * Fires on every status transition. `'failed'` — reachable only via
   * an exhausted {@link failureBudget} or an invalid carrier
   * combination at `start()` — is the demotion trigger the failover
   * ladder intercepts.
   */
  readonly onStatusChange?: (status: TransportStatus) => void;
  /**
   * Transport-level failure budget — see
   * {@link RegistryPollingOptions.failureBudget} for the semantics.
   * The descriptor-level field wins when both are set. Kept separate
   * so the registry can inject the ladder's budget without rewriting
   * the consumer's descriptor.
   */
  readonly failureBudget?: number;
}

/**
 * Sentinel `tick()` resolves to when the tick FAILED (carrier
 * throw/reject, `!res.ok`, or no fetch impl) — distinct from any body
 * value, including `undefined`, so chain-mode pacing can fall back to
 * `intervalMs` without consulting `nextDelayMs` on garbage.
 */
const TICK_FAILURE: unique symbol = Symbol('ggui.polling.tick_failure');

export class PollingTransport implements PollingTransportHandle {
  readonly kind = 'polling' as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private chainTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;
  private currentStatus: TransportStatus = 'connecting';
  /**
   * Count of consecutive failed ticks (carrier throw/reject or
   * `!res.ok`). Any successful tick resets it. Only consulted when a
   * failure budget is configured — see
   * {@link RegistryPollingOptions.failureBudget}.
   */
  private consecutiveFailures = 0;

  constructor(private readonly opts: PollingTransportOptions) {}

  get status(): TransportStatus {
    return this.currentStatus;
  }

  start(): void {
    if (this.disposed) return;
    // Idempotence guard — a second start() while a loop is live
    // (e.g. a facade-proxied re-arm) must not double-schedule ticks.
    // A boolean rather than a timer-handle check: in chain mode the
    // timeout handle is null WHILE a tick is in flight, so the handle
    // alone can't witness liveness.
    if (this.started) return;
    this.started = true;
    const { polling } = this.opts;
    if (polling === undefined) {
      // No descriptor — transport is logically alive but does nothing.
      // Consumers that bind without a polling option see an `'open'`
      // PollingTransportHandle whose handlers never fire. Matches the
      // pre-R6 "no handler had polling" behavior at a different layer.
      this.setStatus('open');
      return;
    }
    const hasUrl = polling.url !== undefined;
    const hasFetchBody = polling.fetchBody !== undefined;
    if (hasUrl === hasFetchBody) {
      // Exactly one of url / fetchBody must be set. Neither → nothing
      // to poll; both → ambiguous carrier. Either way the descriptor
      // is structurally unusable, not transiently broken — fail at
      // start() (mirroring the WS constructor-throw route) so the
      // failover ladder can demote instead of ticking into nonsense.
      this.opts.logger?.warn?.('channel_polling_invalid_carrier', {
        has_url: hasUrl,
        has_fetch_body: hasFetchBody,
        reason:
          'RegistryPollingOptions requires exactly one of url / fetchBody.',
      });
      this.setStatus('failed');
      return;
    }
    this.consecutiveFailures = 0;
    const minInterval =
      this.opts.minPollIntervalMs ?? DEFAULT_MIN_POLL_INTERVAL_MS;
    const intervalMs = Math.max(polling.intervalMs, minInterval);
    const { nextDelayMs } = polling;
    if (nextDelayMs !== undefined) {
      // Subscription-mode chain: one tick in flight at a time, the
      // composer's callback paces each successor. See the
      // `RegistryPollingOptions.nextDelayMs` docstring for the
      // contract (failed ticks pace at intervalMs; min-interval clamp
      // deliberately not applied).
      void this.chainTick(polling, nextDelayMs, intervalMs);
      this.setStatus('open');
      return;
    }
    // Fire immediately so consumers get a payload as fast as possible,
    // then schedule recurring ticks.
    void this.tick(polling);
    this.timer = setInterval(() => {
      void this.tick(polling);
    }, intervalMs);
    this.setStatus('open');
  }

  /**
   * Self-scheduling long-poll chain — the `nextDelayMs` mode of
   * {@link start}. Serializes ticks (no overlap even when a held call
   * outlives the nominal interval) and stops rescheduling the moment
   * the transport is disposed or the failure budget demotes it.
   */
  private async chainTick(
    polling: RegistryPollingOptions,
    nextDelayMs: (body: unknown) => number,
    failureIntervalMs: number,
  ): Promise<void> {
    const outcome = await this.tick(polling);
    if (this.disposed || this.currentStatus === 'failed') return;
    const delay =
      outcome === TICK_FAILURE
        ? failureIntervalMs
        : Math.max(0, nextDelayMs(outcome));
    this.chainTimer = setTimeout(() => {
      void this.chainTick(polling, nextDelayMs, failureIntervalMs);
    }, delay);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimer();
    this.setStatus('closed');
  }

  private async tick(
    polling: RegistryPollingOptions,
  ): Promise<unknown | typeof TICK_FAILURE> {
    if (this.disposed) return TICK_FAILURE;
    let body: unknown;
    if (polling.fetchBody !== undefined) {
      // Bridge carrier — the resolved value IS the body. No `res.ok`
      // check, no `.json()` step: there is no HTTP response to
      // inspect, only a promise that resolved or rejected.
      try {
        body = await polling.fetchBody();
      } catch (err) {
        this.opts.logger?.debug?.('channel_polling_fetch_failed', {
          carrier: 'fetchBody',
          error: err instanceof Error ? err.message : String(err),
        });
        this.recordTickFailure(polling);
        return TICK_FAILURE;
      }
    } else if (polling.url !== undefined) {
      const url = polling.url;
      const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
      if (typeof fetchImpl !== 'function') {
        this.opts.logger?.warn?.('channel_polling_no_fetch', { url });
        return TICK_FAILURE;
      }
      try {
        const resp = await fetchImpl(url, {
          headers: { accept: 'application/json' },
        });
        if (!resp.ok) {
          this.opts.logger?.debug?.('channel_polling_non_ok', {
            url,
            status: resp.status,
          });
          this.recordTickFailure(polling);
          return TICK_FAILURE;
        }
        // 204 No Content — explicit "nothing new this tick" — short
        // circuit before .json() throws on empty body. Still a
        // success: the carrier reached the server, so the
        // consecutive-failure streak resets.
        if (resp.status === 204) {
          this.consecutiveFailures = 0;
          return undefined;
        }
        const ct = resp.headers.get('content-type') ?? '';
        if (ct.includes('application/json')) {
          body = await resp.json();
        } else {
          body = await resp.text();
        }
      } catch (err) {
        this.opts.logger?.debug?.('channel_polling_fetch_failed', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
        this.recordTickFailure(polling);
        return TICK_FAILURE;
      }
    } else {
      // Unreachable: the exactly-one-of guard in start() fails the
      // transport before any tick can fire on a carrier-less
      // descriptor.
      return TICK_FAILURE;
    }
    // Any successful tick resets the consecutive-failure streak.
    this.consecutiveFailures = 0;
    if (this.disposed) return body;
    let frames: Record<string, ChannelFrame> | null;
    try {
      frames = polling.parseSnapshot(body);
    } catch (err) {
      this.opts.logger?.warn?.('channel_polling_parse_failed', {
        ...(polling.url !== undefined
          ? { url: polling.url }
          : { carrier: 'fetchBody' }),
        error: err instanceof Error ? err.message : String(err),
      });
      return body;
    }
    if (frames === null) return body;
    // Dispatch each frame to its matching handler. Handlers absent from
    // the registry are skipped silently — the snapshot may describe
    // event types this consumer doesn't observe.
    for (const [type, frame] of Object.entries(frames)) {
      const handler = this.opts.handlers.get(type);
      if (handler === undefined) {
        this.opts.logger?.debug?.('channel_polling_no_handler', {
          type,
        });
        continue;
      }
      try {
        const result = handler.onMessage(frame.payload);
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            this.opts.logger?.warn?.('channel_handler_throw', {
              type,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (err) {
        this.opts.logger?.warn?.('channel_handler_throw', {
          type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Count a consecutive tick failure (carrier throw/rejection or
   * `!res.ok`) against the failure budget. No budget configured →
   * never-fail: per-tick errors are absorbed forever (the
   * terminal-rung posture). Budget reached → stop the timer + report
   * `'failed'` so the failover ladder can demote to the next rung.
   * Descriptor-level budget wins over the transport-level one (the
   * latter is the registry's injection seam).
   */
  private recordTickFailure(polling: RegistryPollingOptions): void {
    this.consecutiveFailures += 1;
    const budget = polling.failureBudget ?? this.opts.failureBudget;
    if (budget === undefined || this.consecutiveFailures < budget) return;
    this.opts.logger?.warn?.('channel_polling_budget_exhausted', {
      consecutive_failures: this.consecutiveFailures,
      failure_budget: budget,
      ...(polling.url !== undefined
        ? { url: polling.url }
        : { carrier: 'fetchBody' }),
      reason:
        'Consecutive tick failures reached the failure budget — stopping the poll loop and reporting failed.',
    });
    this.stopTimer();
    this.setStatus('failed');
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.chainTimer !== null) {
      clearTimeout(this.chainTimer);
      this.chainTimer = null;
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
