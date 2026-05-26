/**
 * `PollingTransport` — per-channel HTTP polling for clients without
 * WebSocket access (locked-down enterprise hosts, future
 * server-side / native SDK consumers, or as a failover when
 * WSTransport's reconnect budget runs out).
 *
 * Each channel handler declares its own `polling` descriptor with
 * URL + interval + parse fn. Channels that omit `polling` are inert
 * under this transport (they simply never receive payloads).
 *
 * Polling is per-channel and independent — channels with sub-second
 * cadence don't block channels at higher intervals. Each poll fires
 * a `fetch()` against the channel's URL; the handler's `parse()` is
 * responsible for diff detection (return `null` when no new payload).
 *
 * Failures are absorbed and logged; the loop keeps trying on the
 * next tick. Errors don't escalate to `'failed'` status because the
 * NEXT poll might succeed (transient network blip).
 */

import type {
  ChannelHandler,
  ChannelLogger,
  PollingTransportHandle,
  TransportStatus,
} from './types.js';

const DEFAULT_MIN_POLL_INTERVAL_MS = 500;

export interface PollingTransportOptions {
  readonly handlers: ReadonlyMap<string, ChannelHandler>;
  readonly logger?: ChannelLogger;
  /**
   * Floor for the polling interval. Defaults to 500ms — any handler
   * declaring a smaller interval is clamped here.
   */
  readonly minPollIntervalMs?: number;
  /**
   * Test hook — inject a fetch impl. Defaults to `globalThis.fetch`.
   */
  readonly fetchImpl?: typeof fetch;
}

interface PollerHandle {
  readonly type: string;
  readonly url: string;
  readonly intervalMs: number;
  timer: ReturnType<typeof setInterval> | null;
  cancelled: boolean;
}

export class PollingTransport implements PollingTransportHandle {
  readonly kind = 'polling' as const;
  private readonly pollers: PollerHandle[] = [];
  private disposed = false;
  private currentStatus: TransportStatus = 'connecting';

  constructor(private readonly opts: PollingTransportOptions) {}

  get status(): TransportStatus {
    return this.currentStatus;
  }

  start(): void {
    if (this.disposed) return;
    const minInterval =
      this.opts.minPollIntervalMs ?? DEFAULT_MIN_POLL_INTERVAL_MS;
    for (const handler of this.opts.handlers.values()) {
      if (!handler.polling) continue;
      const clampedInterval = Math.max(handler.polling.intervalMs, minInterval);
      const poller: PollerHandle = {
        type: handler.type,
        url: handler.polling.url,
        intervalMs: clampedInterval,
        timer: null,
        cancelled: false,
      };
      this.pollers.push(poller);
      // Fire immediately so consumers get a payload as fast as
      // possible, then schedule recurring ticks.
      void this.tick(poller, handler);
      poller.timer = setInterval(() => {
        void this.tick(poller, handler);
      }, clampedInterval);
    }
    // No pollers = nothing to do, but the transport is still
    // "running" in the sense that handlers without polling
    // descriptors are simply inert.
    this.currentStatus = 'open';
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const poller of this.pollers) {
      poller.cancelled = true;
      if (poller.timer !== null) {
        clearInterval(poller.timer);
        poller.timer = null;
      }
    }
    this.pollers.length = 0;
    this.currentStatus = 'closed';
  }

  private async tick(
    poller: PollerHandle,
    handler: ChannelHandler,
  ): Promise<void> {
    if (this.disposed || poller.cancelled) return;
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      this.opts.logger?.warn?.('channel_polling_no_fetch', {
        type: poller.type,
      });
      return;
    }
    let body: unknown;
    try {
      // Request the JSON branch on content-negotiated URLs (e.g.
      // `/r/<shortCode>` returns HTML by default, slice-envelope JSON
      // when `Accept: application/json` is sent). Servers that ignore
      // Accept simply continue serving whatever they always served.
      const resp = await fetchImpl(poller.url, {
        headers: { accept: 'application/json' },
      });
      if (!resp.ok) {
        this.opts.logger?.debug?.('channel_polling_non_ok', {
          type: poller.type,
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
        type: poller.type,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (this.disposed || poller.cancelled) return;
    const payload = handler.polling?.parse(body);
    if (payload === null || payload === undefined) return;
    try {
      const result = handler.onMessage(payload);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          this.opts.logger?.warn?.('channel_handler_throw', {
            type: poller.type,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      this.opts.logger?.warn?.('channel_handler_throw', {
        type: poller.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
