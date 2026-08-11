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
 * Transport selection — an ordered failover ladder (ws → sse →
 * polling); each rung is armed only when its inputs are present:
 *   - `bootstrap.wsUrl + bootstrap.wsToken` present (both non-empty) →
 *     WS rung is primary. The handle keeps `kind: 'ws'` across
 *     demotions (consumers narrow on it for `send()`).
 *   - WS not viable but `opts.sse` present → SSE rung is primary
 *     (handle `kind: 'sse'`).
 *   - Otherwise → `PollingTransport` directly (no ladder).
 *
 * **Failover** — when the active rung transitions to `'failed'`
 * (WS: never-opened fail-fast / retry-ladder exhaustion; SSE:
 * construct throw / liveness watchdog / terminal-close 2-strike), the
 * ladder disposes it and spins up the next rung with the same handler
 * map. Callers observe the demotion only as a synthetic
 * `'connecting'` re-entry via `onStatusChange` — `'failed'` is never
 * forwarded while a lower rung remains. Polling is the terminal rung
 * and never emits `'failed'` (per-tick errors are absorbed).
 * Empirically required for MCP-Apps hosts whose iframe sandbox
 * refuses `wss://` regardless of `_meta.ui.csp.connectDomains`
 * (Claude Desktop is the known case).
 */

import { PollingTransport } from './polling-transport.js';
import { SSETransport } from './sse-transport.js';
import type {
  AnyTransportHandle,
  BindOptions,
  ChannelHandler,
  ChannelLogger,
  RegistrySseOptions,
  SseTransportHandle,
  TransportKind,
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
   * caller's factory closure. WS-only concept — SSE subscribes via
   * its URL; polling has no handshake.
   */
  readonly subscribeFrameBuilder: SubscribeFrameBuilder;
  /**
   * Test hook — inject a WebSocket constructor. Defaults to
   * `globalThis.WebSocket`.
   */
  readonly webSocketFactory?: (url: string) => WebSocket;
  /**
   * Test hook — inject an EventSource constructor. Defaults to
   * `globalThis.EventSource`.
   */
  readonly eventSourceFactory?: (url: string) => EventSource;
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
   * the initial selection path (no WS, no SSE) and the ladder's
   * terminal rung (built when the previous rung reaches `'failed'`).
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
   * Construct an `SSETransport` from the bind opts. Ladder-only path —
   * the `onStatusChange` is the ladder's interception callback, not
   * the consumer's.
   */
  private buildSseTransport(
    opts: BindOptions,
    sse: RegistrySseOptions,
    onStatusChange: (status: TransportStatus) => void,
  ): SSETransport {
    const { logger } = opts;
    const sseOpts: ConstructorParameters<typeof SSETransport>[0] = {
      sse,
      handlers: this.handlers,
      onStatusChange,
      ...(logger !== undefined ? { logger } : {}),
      ...(this.opts.eventSourceFactory !== undefined
        ? { eventSourceFactory: this.opts.eventSourceFactory }
        : {}),
    };
    return new SSETransport(sseOpts);
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
    const sse = opts.sse;

    const sseRung = (sseOpts: RegistrySseOptions): LadderRung => ({
      kind: 'sse',
      build: (onStatus) => this.buildSseTransport(opts, sseOpts, onStatus),
    });
    const pollingRung: LadderRung = {
      kind: 'polling',
      // PollingTransport has no status callback surface — it is the
      // terminal rung and never emits 'failed' (per-tick errors are
      // absorbed), so the ladder has nothing to intercept.
      build: () => this.buildPollingTransport(opts),
    };

    const wsUrl = bootstrap.wsUrl;
    const wsToken = bootstrap.wsToken;
    if (
      typeof wsUrl === 'string' &&
      wsUrl.length > 0 &&
      typeof wsToken === 'string' &&
      wsToken.length > 0
    ) {
      // WS is viable — ladder: ws → [sse if descriptor present] →
      // polling. The handle keeps `kind: 'ws'` across demotions;
      // consumers see each demotion as a `'connecting'` re-entry via
      // `onStatusChange`.
      const rungs: readonly LadderRung[] = [
        {
          kind: 'ws',
          build: (onStatus) => {
            const wsOpts: ConstructorParameters<typeof WSTransport>[0] = {
              url: wsUrl,
              subscribeFrame: this.opts.subscribeFrameBuilder,
              handlers: this.handlers,
              onStatusChange: onStatus,
              ...(logger !== undefined ? { logger } : {}),
              ...(this.opts.webSocketFactory !== undefined
                ? { webSocketFactory: this.opts.webSocketFactory }
                : {}),
            };
            return new WSTransport(wsOpts);
          },
        },
        ...(sse !== undefined ? [sseRung(sse)] : []),
        pollingRung,
      ];
      return new WsFailoverHandle(
        new TransportLadder(rungs, opts.onStatusChange, logger),
        logger,
      );
    }
    if (sse !== undefined) {
      // SSE-primary — ladder: sse → polling. Honest `kind: 'sse'`:
      // SSE-primary sessions never had an outbound channel.
      return new SseFailoverHandle(
        new TransportLadder([sseRung(sse), pollingRung], opts.onStatusChange, logger),
      );
    }
    return this.buildPollingTransport(opts);
  }
}

/**
 * Tagged-union of the concrete shapes `selectTransport` may return —
 * kept private so consumers see the public `AnyTransportHandle`
 * discriminated union (narrowable via `.kind`) without reaching into
 * class internals.
 */
type InternalTransport =
  | WSTransport
  | SSETransport
  | PollingTransport
  | WsFailoverHandle
  | SseFailoverHandle;

/** Any concrete transport a ladder rung can build. */
type RungTransport = WSTransport | SSETransport | PollingTransport;

interface LadderRung {
  readonly kind: TransportKind;
  /**
   * Deferred constructor for the rung's transport, closure-bound to
   * the `bind()` opts. Receives the ladder's status-interception
   * callback; the polling rung ignores it (PollingTransport has no
   * status callback and never emits `'failed'`).
   */
  readonly build: (onStatus: (status: TransportStatus) => void) => RungTransport;
}

/**
 * Ordered failover ladder core. Builds the first rung eagerly and
 * demotes down the ladder on `'failed'`:
 *
 *   - Pre-demotion: forwards the active rung's status verbatim EXCEPT
 *     `'failed'` — which is intercepted to trigger the demotion when a
 *     lower rung exists. The consumer sees the demotion as a
 *     `'connecting'` re-entry instead of a terminal `'failed'`.
 *   - On demotion: disposes the failed rung, logs
 *     `channel_failover_swap {from, to, reason}`, builds + starts the
 *     next rung.
 *   - On the LAST rung, `'failed'` is forwarded verbatim (unreachable
 *     in practice: polling never emits `'failed'`).
 *
 * Status callbacks from an already-demoted rung are stale-guarded so
 * a zombie rung can never trigger a second demotion. `dispose()`
 * disposes only the active rung — earlier rungs were already disposed
 * at their demotion.
 */
class TransportLadder {
  private activeTransport: RungTransport;
  private rungIndex = 0;
  private demoted = false;
  private disposed = false;

  constructor(
    private readonly rungs: readonly LadderRung[],
    private readonly onStatusChange?: (status: TransportStatus) => void,
    private readonly logger?: ChannelLogger,
  ) {
    this.activeTransport = this.spawnRung(0);
  }

  get active(): RungTransport {
    return this.activeTransport;
  }

  /**
   * Test seam — the kind of the currently active rung. Production
   * code shouldn't introspect this; ladder tests use it to assert
   * which rung is live without timing-coupled status sniffing.
   */
  get activeKind(): TransportKind {
    return this.rungs[this.rungIndex].kind;
  }

  /**
   * Test seam — whether at least one demotion has fired. Kept with
   * the pre-ladder `FailoverHandle.hasSwapped` semantics.
   */
  get hasSwapped(): boolean {
    return this.demoted;
  }

  get status(): TransportStatus {
    return this.activeTransport.status;
  }

  start(): void {
    if (this.disposed) return;
    this.activeTransport.start();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.activeTransport.dispose();
  }

  /**
   * Build the rung at `index`, wiring its status callback through a
   * stale guard: once the ladder has moved past this rung, its late
   * callbacks are dropped (its own `dispose()` already fired the
   * final `'closed'` during the demotion).
   */
  private spawnRung(index: number): RungTransport {
    let self: RungTransport | null = null;
    const transport = this.rungs[index].build((status) => {
      if (self !== null && self !== this.activeTransport) return;
      this.onInnerStatus(status);
    });
    self = transport;
    return transport;
  }

  private onInnerStatus(status: TransportStatus): void {
    if (this.disposed) return;
    const next: LadderRung | undefined = this.rungs[this.rungIndex + 1];
    if (status !== 'failed' || next === undefined) {
      this.onStatusChange?.(status);
      return;
    }
    // Active rung hit terminal failure — demote.
    this.demoted = true;
    const from = this.rungs[this.rungIndex].kind;
    this.logger?.warn?.('channel_failover_swap', {
      from,
      to: next.kind,
      reason: `${from} transport reached status=failed — swapping to ${next.kind}.`,
    });
    void this.activeTransport.dispose();
    this.rungIndex += 1;
    this.activeTransport = this.spawnRung(this.rungIndex);
    // Surface `connecting` on the demotion so consumers see a clean
    // status re-entry instead of a terminal `failed`.
    this.onStatusChange?.('connecting');
    this.activeTransport.start();
  }
}

/**
 * WS-primary ladder facade. Keeps `kind: 'ws' as const` across
 * demotions — consumers (iframe-runtime's registry-subscribe) narrow
 * on it once at bind time; the demotion is internal. `send()` only
 * works while the WS rung is active: both lower rungs (SSE, polling)
 * are inbound-only, so post-demotion sends are logged + dropped.
 */
class WsFailoverHandle implements WsTransportHandle {
  readonly kind = 'ws' as const;

  constructor(
    private readonly ladder: TransportLadder,
    private readonly logger?: ChannelLogger,
  ) {}

  get status(): TransportStatus {
    return this.ladder.status;
  }

  /** Test seam — see {@link TransportLadder.hasSwapped}. */
  get hasSwapped(): boolean {
    return this.ladder.hasSwapped;
  }

  /** Test seam — see {@link TransportLadder.activeKind}. */
  get activeKind(): TransportKind {
    return this.ladder.activeKind;
  }

  start(): void {
    this.ladder.start();
  }

  async dispose(): Promise<void> {
    await this.ladder.dispose();
  }

  send(frame: unknown): void {
    const active = this.ladder.active;
    if (active instanceof WSTransport) {
      active.send(frame);
      return;
    }
    // Post-demotion: the outbound channel is gone — neither SSE nor
    // polling has one. Best-effort log + drop — consumer code may
    // still call `send` from a stale closure.
    this.logger?.debug?.('channel_failover_send_dropped_post_swap', {
      reason: 'active transport has no outbound channel (SSE/polling rung)',
    });
  }
}

/**
 * SSE-primary ladder facade (`kind: 'sse'`). No `send()` — honest
 * type: SSE-primary sessions never had an outbound channel.
 */
class SseFailoverHandle implements SseTransportHandle {
  readonly kind = 'sse' as const;

  constructor(private readonly ladder: TransportLadder) {}

  get status(): TransportStatus {
    return this.ladder.status;
  }

  /** Test seam — see {@link TransportLadder.hasSwapped}. */
  get hasSwapped(): boolean {
    return this.ladder.hasSwapped;
  }

  /** Test seam — see {@link TransportLadder.activeKind}. */
  get activeKind(): TransportKind {
    return this.ladder.activeKind;
  }

  start(): void {
    this.ladder.start();
  }

  async dispose(): Promise<void> {
    await this.ladder.dispose();
  }
}

// Re-exports for consumers that want to instantiate transports
// directly (rare — `ChannelRegistry.bind()` is the canonical entry).
export { WSTransport } from './ws-transport.js';
export { SSETransport } from './sse-transport.js';
export { PollingTransport } from './polling-transport.js';

// Re-export the logger type so consumers wiring telemetry get a
// single import surface.
export type { ChannelLogger };
