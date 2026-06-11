/**
 * `ChannelRegistry` — registration surface for channel handlers +
 * transport-selection point at bind time.
 *
 * Usage pattern:
 *
 * ```ts
 * const registry = new ChannelRegistry({
 *   subscribeFrameBuilder: () => ({
 *     type: 'subscribe',
 *     payload: { sessionId, appId, wsToken },
 *   }),
 * });
 * registry.register(propsUpdateHandler);
 * registry.register(drainAckHandler);
 * registry.register(channelPayloadHandler);
 *
 * const handle = await registry.bind({ bootstrap, logger });
 * // ... later, when the iframe re-mounts or unloads:
 * await handle.dispose();
 * ```
 *
 * Transport selection:
 *   - `bootstrap.wsUrl + bootstrap.wsToken` present (both non-empty) →
 *     `WSTransport` (wrapped in `FailoverHandle` so a hard failure
 *     swaps in `PollingTransport` transparently).
 *   - Either missing → `PollingTransport`.
 *
 * **Failover** — when a `WSTransport` transitions to `'failed'`
 * (either via the never-opened fail-fast path or the exhausted-retry-
 * ladder path), `FailoverHandle` disposes it and spins up a
 * `PollingTransport` with the same handler map. Callers observe the
 * swap only via the transport `kind` discriminator on the handle; the
 * `onStatusChange` callback continues to fire with the polling
 * transport's status thereafter. Empirically required for MCP-Apps
 * hosts whose iframe sandbox refuses `wss://` regardless of
 * `_meta.ui.csp.connectDomains` (Claude Desktop is the known case).
 */

import { PollingTransport } from './polling-transport.js';
import type {
  AnyTransportHandle,
  BindOptions,
  ChannelHandler,
  ChannelLogger,
  TransportStatus,
  WsTransportHandle,
} from './types.js';
import { WSTransport, type SubscribeFrameBuilder } from './ws-transport.js';

export interface ChannelRegistryOptions {
  /**
   * Caller-supplied subscribe-frame factory. The library stays
   * protocol-version-agnostic — the consumer (iframe-runtime) knows
   * the exact `{type:'subscribe', payload:{sessionId, appId?,
   * wsToken, fromSeq?}}` shape its server expects and supplies it
   * via this factory at bind time.
   *
   * Called on every WSTransport `open` event (initial connect AND
   * each reconnect), so reconnect-resume semantics live in the
   * caller's factory closure.
   */
  readonly subscribeFrameBuilder: SubscribeFrameBuilder;
  /**
   * Test hook — inject a WebSocket constructor. Defaults to
   * `globalThis.WebSocket`.
   */
  readonly webSocketFactory?: (url: string) => WebSocket;
  /**
   * Test hook — inject a fetch impl. Defaults to `globalThis.fetch`.
   */
  readonly fetchImpl?: typeof fetch;
}

export class ChannelRegistry {
  private readonly handlers = new Map<string, ChannelHandler>();
  private bound = false;

  constructor(private readonly opts: ChannelRegistryOptions) {}

  /**
   * Register a channel handler. Returns a function that
   * un-registers — useful for tests + handlers with scoped lifetime.
   *
   * Throws when a handler is already registered for the given `type`
   * (the registry is a flat map, not a multi-cast bus). Consumers
   * that need multi-listener semantics can layer a fan-out callback
   * on top of `onMessage`.
   *
   * Throws when called after `bind()` — the handler set is fixed at
   * bind time so the transport can snapshot it.
   */
  register<TPayload>(handler: ChannelHandler<TPayload>): () => void {
    if (this.bound) {
      throw new Error(
        `ChannelRegistry: cannot register("${handler.type}") after bind() — handler set is frozen at bind time.`,
      );
    }
    if (this.handlers.has(handler.type)) {
      throw new Error(
        `ChannelRegistry: handler for type "${handler.type}" already registered.`,
      );
    }
    this.handlers.set(handler.type, handler as ChannelHandler);
    return () => {
      this.handlers.delete(handler.type);
    };
  }

  /**
   * Pick a transport based on the bootstrap shape, start it, and
   * return a handle the caller uses to inspect status + dispose.
   *
   * Idempotent against double-bind: a second call throws so consumers
   * don't accidentally open two transports.
   */
  async bind(opts: BindOptions): Promise<AnyTransportHandle> {
    if (this.bound) {
      throw new Error(
        'ChannelRegistry: already bound — dispose the previous transport before re-binding.',
      );
    }
    this.bound = true;

    const transport = this.selectTransport(opts);
    transport.start();
    return transport;
  }

  /**
   * Construct a `PollingTransport` from the bind opts. Shared between
   * the initial selection path (when the bootstrap omits wsUrl/token)
   * and the `FailoverHandle` swap path (when a WSTransport reaches
   * `'failed'`).
   */
  private buildPollingTransport(opts: BindOptions): PollingTransport {
    const { logger } = opts;
    const pollOpts: ConstructorParameters<typeof PollingTransport>[0] = {
      handlers: this.handlers,
      ...(logger !== undefined ? { logger } : {}),
      ...(opts.minPollIntervalMs !== undefined
        ? { minPollIntervalMs: opts.minPollIntervalMs }
        : {}),
      ...(this.opts.fetchImpl !== undefined
        ? { fetchImpl: this.opts.fetchImpl }
        : {}),
      ...(opts.polling !== undefined ? { polling: opts.polling } : {}),
    };
    return new PollingTransport(pollOpts);
  }

  /**
   * Test-only: return the registered handler map (snapshot). Useful
   * for tests that want to assert a particular handler is wired
   * through the registry.
   */
  inspectHandlers(): ReadonlyMap<string, ChannelHandler> {
    return new Map(this.handlers);
  }

  private selectTransport(opts: BindOptions): InternalTransport {
    const { bootstrap, logger } = opts;
    const wsViable =
      typeof bootstrap.wsUrl === 'string' &&
      bootstrap.wsUrl.length > 0 &&
      typeof bootstrap.wsToken === 'string' &&
      bootstrap.wsToken.length > 0;
    if (wsViable) {
      // Wrap WSTransport in FailoverHandle so a hard failure
      // (never-opened fail-fast OR retry-ladder exhaustion) transparently
      // swaps in PollingTransport with the same handlers. Callers see a
      // single handle whose `kind` flips from 'ws' → 'polling' across
      // the swap; their `onStatusChange` keeps firing on the post-swap
      // transport.
      return new FailoverHandle({
        wsUrl: bootstrap.wsUrl!,
        subscribeFrame: this.opts.subscribeFrameBuilder,
        handlers: this.handlers,
        webSocketFactory: this.opts.webSocketFactory,
        buildPolling: () => this.buildPollingTransport(opts),
        ...(logger !== undefined ? { logger } : {}),
        ...(opts.onStatusChange !== undefined
          ? { onStatusChange: opts.onStatusChange }
          : {}),
      });
    }
    return this.buildPollingTransport(opts);
  }
}

/**
 * Tagged-union of the two concrete Transport classes — kept private
 * so consumers see the public `AnyTransportHandle` discriminated union
 * (narrowable via `.kind`) without reaching into class internals.
 */
type InternalTransport = WSTransport | PollingTransport | FailoverHandle;

interface FailoverHandleOptions {
  readonly wsUrl: string;
  readonly subscribeFrame: SubscribeFrameBuilder;
  readonly handlers: ReadonlyMap<string, ChannelHandler>;
  readonly webSocketFactory?: (url: string) => WebSocket;
  readonly logger?: ChannelLogger;
  readonly onStatusChange?: (status: TransportStatus) => void;
  /**
   * Factory the wrapper invokes when the inner WSTransport reaches
   * `'failed'`. Closure-bound to the bind() opts so the swapped-in
   * PollingTransport shares the same handlers, logger, fetch impl,
   * and minPollIntervalMs as the initial-selection path would have
   * constructed.
   */
  readonly buildPolling: () => PollingTransport;
}

/**
 * Wraps a primary `WSTransport` with a deferred `PollingTransport`
 * fallback. On the primary's `'failed'` status, disposes it and spins
 * up the fallback so the iframe-runtime keeps receiving frames without
 * a manual re-bind. From the caller's perspective the handle continues
 * to satisfy `WsTransportHandle` (including the `send()` method, which
 * no-ops post-swap because polling has no outbound channel) — the swap
 * is internal. Callers that need to know whether they're still on WS
 * can subscribe to `onStatusChange`: a `'connecting'` transition
 * AFTER an earlier `'open'` or `'closed'` signals the swap has
 * happened.
 *
 * Status forwarding rules:
 *   - Pre-swap: forwards the WSTransport's status verbatim EXCEPT for
 *     `'failed'` — which is intercepted to trigger the swap. The
 *     consumer sees the swap as a `'connecting'` re-entry instead of
 *     a terminal `'failed'`.
 *   - Post-swap: forwards the PollingTransport's status verbatim.
 */
class FailoverHandle implements WsTransportHandle {
  readonly kind = 'ws' as const;
  private active: WSTransport | PollingTransport;
  private swapped = false;
  private disposed = false;

  constructor(private readonly opts: FailoverHandleOptions) {
    const wsOpts: ConstructorParameters<typeof WSTransport>[0] = {
      url: opts.wsUrl,
      subscribeFrame: opts.subscribeFrame,
      handlers: opts.handlers,
      onStatusChange: (status) => this.onInnerStatus(status),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      ...(opts.webSocketFactory !== undefined
        ? { webSocketFactory: opts.webSocketFactory }
        : {}),
    };
    this.active = new WSTransport(wsOpts);
  }

  get status(): TransportStatus {
    return this.active.status;
  }

  start(): void {
    if (this.disposed) return;
    this.active.start();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.active.dispose();
  }

  send(frame: unknown): void {
    if (this.active instanceof WSTransport) {
      this.active.send(frame);
      return;
    }
    // Post-swap to polling: outbound channel is gone (PollingTransport
    // has no `send`). Best-effort log + drop — consumer code may still
    // call `send` from a stale closure during the swap window.
    this.opts.logger?.debug?.('channel_failover_send_dropped_post_swap', {
      reason: 'PollingTransport has no outbound channel',
    });
  }

  /**
   * Test seam — exposes whether the failover swap has fired. Production
   * code shouldn't introspect this; tests in `registry.test.ts` use it
   * to assert the swap happened without timing-coupled status sniffing.
   */
  get hasSwapped(): boolean {
    return this.swapped;
  }

  private onInnerStatus(status: TransportStatus): void {
    if (this.disposed) return;
    if (status !== 'failed' || this.swapped) {
      this.opts.onStatusChange?.(status);
      return;
    }
    // WS hit terminal failure — swap.
    this.swapped = true;
    this.opts.logger?.warn?.('channel_failover_swap', {
      from: 'ws',
      to: 'polling',
      reason:
        'WSTransport reached status=failed (never-opened or retry-ladder exhausted) — swapping to PollingTransport.',
    });
    void this.active.dispose();
    const polling = this.opts.buildPolling();
    this.active = polling;
    // Surface `connecting` on the swap so consumers see a clean status
    // re-entry. The polling transport itself will fire `'open'` on its
    // first successful tick via its own `currentStatus` transition.
    this.opts.onStatusChange?.('connecting');
    polling.start();
  }
}

// Re-exports for consumers that want to instantiate transports
// directly (rare — `ChannelRegistry.bind()` is the canonical entry).
export { WSTransport } from './ws-transport.js';
export { PollingTransport } from './polling-transport.js';

// Re-export the logger type so consumers wiring telemetry get a
// single import surface.
export type { ChannelLogger };
