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
 * `/api/renders/:id/state?wsToken=<token>`) and supplies a
 * `parseSnapshot` closure that returns a `Record<type, frame>` map
 * (or `null` to short-circuit when nothing changed since the last
 * poll).
 *
 * Each tick fires ONE `fetch()`; for every entry in the returned map
 * the transport looks up the handler by `type` in the registry's
 * handler map and calls `handler.onMessage(frame.payload)`.
 *
 * Failures are absorbed and logged; the loop keeps trying on the
 * next tick. Errors don't escalate to `'failed'` status because the
 * NEXT poll might succeed (transient network blip).
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
}

export class PollingTransport implements PollingTransportHandle {
  readonly kind = 'polling' as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private currentStatus: TransportStatus = 'connecting';

  constructor(private readonly opts: PollingTransportOptions) {}

  get status(): TransportStatus {
    return this.currentStatus;
  }

  start(): void {
    if (this.disposed) return;
    const { polling } = this.opts;
    if (polling === undefined) {
      // No descriptor — transport is logically alive but does nothing.
      // Consumers that bind without a polling option see an `'open'`
      // PollingTransportHandle whose handlers never fire. Matches the
      // pre-R6 "no handler had polling" behavior at a different layer.
      this.currentStatus = 'open';
      return;
    }
    const minInterval =
      this.opts.minPollIntervalMs ?? DEFAULT_MIN_POLL_INTERVAL_MS;
    const intervalMs = Math.max(polling.intervalMs, minInterval);
    // Fire immediately so consumers get a payload as fast as possible,
    // then schedule recurring ticks.
    void this.tick(polling);
    this.timer = setInterval(() => {
      void this.tick(polling);
    }, intervalMs);
    this.currentStatus = 'open';
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.currentStatus = 'closed';
  }

  private async tick(polling: RegistryPollingOptions): Promise<void> {
    if (this.disposed) return;
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      this.opts.logger?.warn?.('channel_polling_no_fetch', {
        url: polling.url,
      });
      return;
    }
    let body: unknown;
    try {
      const resp = await fetchImpl(polling.url, {
        headers: { accept: 'application/json' },
      });
      if (!resp.ok) {
        this.opts.logger?.debug?.('channel_polling_non_ok', {
          url: polling.url,
          status: resp.status,
        });
        return;
      }
      // 204 No Content — explicit "nothing new this tick" — short
      // circuit before .json() throws on empty body.
      if (resp.status === 204) return;
      const ct = resp.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        body = await resp.json();
      } else {
        body = await resp.text();
      }
    } catch (err) {
      this.opts.logger?.debug?.('channel_polling_fetch_failed', {
        url: polling.url,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (this.disposed) return;
    let frames: Record<string, ChannelFrame> | null;
    try {
      frames = polling.parseSnapshot(body);
    } catch (err) {
      this.opts.logger?.warn?.('channel_polling_parse_failed', {
        url: polling.url,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (frames === null) return;
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
}
