/**
 * Per-channel transport router.
 *
 * Owns the runtime-side half of the dual-transport stream-channel
 * negotiation. For each `streamSpec[channelName]` entry that
 * declares a `source.tool`, the router picks ONE of two transports
 * per channel:
 *
 *   - **WS subscribe** — when `source.tool` is in the bootstrap's
 *     `streamWebSocketLocalTools` allowlist. The router sends a
 *     `channel_subscribe` WS frame; the server polls the tool and
 *     fans out `channel_payload` frames. Cheapest path: zero LLM
 *     traffic, zero parent-iframe postMessage round-trips per
 *     payload.
 *
 *   - **Iframe polling** — fallback for every other channel. The
 *     router runs a setInterval that fires `tools/call` against
 *     the parent MCP host (direct, no bridge). Works
 *     for any tool the agent has access to, including third-party
 *     MCP servers the local pod can't subscribe-for.
 *
 * The dispatch decision is per-channel + per-render (each new render
 * brings a potentially-new contract; we re-run the routing). The
 * StreamBus + `useStream(channel)` API stay unchanged — the router
 * adapts payloads from both transports into the same envelope shape
 * the bus already accepts.
 *
 * **Reconnect handling** — when the WS drops, every WS-bound channel:
 *   1. Immediately falls back to iframe polling (no delay). The user
 *      keeps seeing fresh data while the WS reconnect ladder runs.
 *   2. On successful reconnect → re-send `channel_subscribe`. On the
 *      first `channel_payload` from that channel, cancel the polling
 *      fallback (don't double-deliver).
 *
 * The WS-level exponential backoff (1s → 2s → 4s → ... cap 60s) lives
 * on `@ggui-ai/live-channel`'s `WSTransport` (post-B3b owner of the
 * reconnect ladder). The router only watches status transitions; it
 * doesn't own the reconnect schedule.
 *
 * **Idempotence** — re-subscribing the same `(sessionId, channelName)`
 * pair is server-side idempotent (the server's `ChannelSubscriptionState`
 * replaces in place). Clients can re-send on reconnect without bookkeeping
 * a "did we already subscribe?" gate.
 *
 * **Boundary** — this module produces a `StreamEnvelope` for every payload
 * (both transports) and emits on the supplied bus. It does NOT validate
 * payloads against `streamSpec[ch].schema` — the existing
 * `validateInboundStreamPayload` path in `runtime.ts` does that on the
 * `data` frame side. For WS `channel_payload` frames we route directly
 * to the bus because the SERVER has already validated server-side; for
 * iframe-poll payloads we trust the tool's return value (matches today's
 * un-routed channel posture pre-1c, where any payload that landed on the
 * data frame was treated as authoritative).
 */
import type {
  JsonObject,
  JsonValue,
  StreamEnvelope,
  StreamSpec,
} from '@ggui-ai/protocol';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type {
  ChannelPollDegradedEvent,
  ChannelPollRecoveredEvent,
  ChannelTransportFallbackEvent,
  ChannelTransportPickedEvent,
  ChannelTransportResubscribedEvent,
} from './observability.js';
import { isRelayIncapableError } from './relay-incapability.js';
import type { StreamBus } from './wire-config.js';

/**
 * Default polling cadence for the iframe-polling transport (ms).
 * Mirrors the server-side default (`DEFAULT_CHANNEL_POLL_DEFAULT_MS`
 * in `mcp-server/src/ggui-session-channel/channel-subscriptions.ts`).
 * Conservative: 10s matches a "data is fresh enough" bar without
 * burning the parent host's `tools/call` quota.
 */
export const DEFAULT_IFRAME_POLL_INTERVAL_MS = 10_000;

/**
 * Cadence (ms) a channel falls back to once its `tools/call` has
 * failed STRUCTURALLY — a failure the router knows will repeat
 * identically on the next tick (see {@link ToolsCallInvoker}).
 *
 * Deliberately a slower cadence and NOT a stop. A structural failure
 * is a statement about the host's current capability, not a permanent
 * property of the universe: the relay-incapability latch upstream
 * clears the moment a real call succeeds, and the only thing that can
 * observe that is an attempt. A stopped channel could never recover
 * on its own; a slow one recovers within one probe interval, for
 * ~1/3 the cost of a healthy channel at the 10s default.
 */
export const DEFAULT_IFRAME_PROBE_POLL_INTERVAL_MS = 30_000;

/**
 * One-channel subscription record. Tracks transport state across the
 * render lifecycle and across WS disconnect/reconnect transitions.
 */
interface ChannelState {
  /** GguiSession id the subscription is bound to. */
  readonly sessionId: string;
  /** Channel name (keys into `streamSpec`). */
  readonly channelName: string;
  /** Source tool name (`streamSpec[channelName].source.tool`). */
  readonly toolName: string;
  /** Args merged into every poll / subscribe (verbatim from spec). */
  readonly args?: JsonObject;
  /** Delivery mode declared on `streamSpec[channelName].mode`. */
  readonly mode: StreamEnvelope['mode'];
  /**
   * Whether the channel's tool is in the bootstrap's
   * `streamWebSocketLocalTools` allowlist. Locked at channel-state
   * creation — does NOT mutate when the WS drops (we still want to
   * re-subscribe on reconnect for these channels).
   */
  readonly preferWs: boolean;
  /**
   * Active poll-loop timer, if any. Cleared when:
   *   - the channel is removed (a new render replaces the old),
   *   - the WS reconnects + we receive the first `channel_payload`
   *     for this channel.
   */
  pollTimer: ReturnType<typeof setInterval> | null;
  /**
   * Whether we've ever observed a `channel_payload` for this channel
   * on the current WS lifecycle. Used to gate the
   * "stop the polling fallback on first WS payload" transition. Reset
   * on every WS disconnect.
   */
  hasReceivedWsPayload: boolean;
  /**
   * True iff the server has classified this channel as
   * `CHANNEL_NOT_LOCAL` (or `CHANNEL_UNKNOWN`, etc.) — once flipped,
   * the router stops attempting WS subscribe on reconnect and stays
   * on the polling path. Sticky for the channel's lifetime.
   */
  permanentPollFallback: boolean;
  /**
   * True iff the channel's last poll failed structurally and it is
   * currently ticking at the probe cadence instead of the default.
   * Cleared by the first successful poll. Survives stop/start cycles
   * (a WS-disconnect fallback re-arms at the probe cadence, not the
   * default) — the underlying condition is a property of the host,
   * not of one timer.
   */
  pollDegraded: boolean;
}

/**
 * Sender for outbound WS frames. Any structurally-fitting send fn
 * works — post-B3b the registry wires the `@ggui-ai/live-channel`
 * transport's send here.
 */
export type WsSender = (msg: WebSocketMessage) => void;

/**
 * Iframe → parent `tools/call` invoker. Resolves with the tool's
 * structured-content output (parsed `JsonValue`) or rejects on
 * failure.
 *
 * **Rejection contract.** The router classifies every rejection into
 * exactly two kinds, and the invoker chooses which by the TYPE of the
 * value it throws:
 *
 *   - **Structural** — reject with `RelayIncapableError` (see
 *     `relay-incapability.ts`). Says: this failed for a reason that
 *     will repeat identically on the next tick, so polling at full
 *     cadence buys nothing. The router drops the channel to
 *     {@link ChannelTransportRouterOptions.probePollIntervalMs} and
 *     emits `channel-poll-degraded` once.
 *   - **Transient** — reject with anything else. Says: the next tick
 *     may well succeed. The router stays quiet and keeps the current
 *     cadence; per-tick network jitter must not turn into bus noise
 *     or a cadence change.
 *
 * Classification is by type only. An invoker cannot signal structural
 * failure through an error MESSAGE, and re-wording a message cannot
 * change how a channel is treated.
 *
 * Neither kind ever stops the loop — see
 * {@link DEFAULT_IFRAME_PROBE_POLL_INTERVAL_MS}.
 */
export type ToolsCallInvoker = (args: {
  readonly toolName: string;
  readonly args: JsonObject;
}) => Promise<JsonValue>;

/**
 * Options for {@link createChannelTransportRouter}.
 */
export interface ChannelTransportRouterOptions {
  /** GguiSession id the router scopes channel_subscribe frames against. */
  readonly sessionId: string;
  /** App (tenant) id paired with sessionId on the subscribe frame. */
  readonly appId: string;
  /**
   * Allowlist of `source.tool` names this server can subscribe-for
   * over WS. From `bootstrap.streamWebSocketLocalTools`. Absent or
   * empty ⇒ every channel routes through the iframe-poll fallback.
   */
  readonly streamWebSocketLocalTools?: readonly string[];
  /** Outbound WS sender. */
  readonly send: WsSender;
  /** Iframe → parent `tools/call` proxy. */
  readonly toolsCall: ToolsCallInvoker;
  /** StreamBus the router emits envelopes onto. */
  readonly streamBus: StreamBus;
  /**
   * Poll cadence (ms) shared by EVERY iframe-polled channel on this
   * router. Uniform by construction: `StreamChannelEntry.source`
   * declares `tool` + `args` only, so a contract author has no way to
   * ask one channel to poll faster than another. Giving channels
   * individual cadences would be a protocol change (a new contract
   * field plus server-side clamping — placement, on the channel entry
   * or on `source`, is still open), not a router option — the
   * per-subscription `pollIntervalMs` that does exist belongs to the
   * WS transport's `channel_subscribe` payload, which this polling
   * fallback never sends.
   *
   * Falls back to {@link DEFAULT_IFRAME_POLL_INTERVAL_MS} when
   * omitted. The only cadence that varies between channels at runtime
   * is the degraded probe cadence ({@link
   * ChannelTransportRouterOptions.probePollIntervalMs}), which follows
   * observed poll health rather than authored config.
   */
  readonly defaultPollIntervalMs?: number;
  /**
   * Cadence (ms) a channel probes at after a structural poll failure.
   * Falls back to {@link DEFAULT_IFRAME_PROBE_POLL_INTERVAL_MS}.
   *
   * Clamped UP to the channel's normal cadence: degrading must never
   * make a channel poll MORE often than it did while healthy, which a
   * naive value would do for any deployment whose normal cadence is
   * already slower than the probe default.
   */
  readonly probePollIntervalMs?: number;
  /**
   * Observability sink — fires once per transport pick, once per
   * disconnect/reconnect-fallback transition, and once per
   * poll-health transition in each direction. Optional; absent ⇒
   * silent.
   */
  readonly onObserve?: (event: ChannelTransportEvent) => void;
}

/**
 * Observability events the router emits. Hosts that wire `onObserve`
 * see these alongside the renderer's other observability events
 * (`subscribe-failed`, `schema-version-mismatch`, …). The arm
 * interfaces live in `observability.ts` (they are members of the
 * exported `ObservabilityEvent` union); this alias is the
 * router-scoped subset, so the two surfaces cannot drift.
 */
export type ChannelTransportEvent =
  | ChannelTransportPickedEvent
  | ChannelTransportFallbackEvent
  | ChannelTransportResubscribedEvent
  | ChannelPollDegradedEvent
  | ChannelPollRecoveredEvent;

/**
 * Router handle returned by {@link createChannelTransportRouter}.
 */
export interface ChannelTransportRouter {
  /**
   * Apply a new render's `streamSpec`. Idempotent against re-applying
   * the same shape (no churn). Channels added/removed across renders
   * fire transport pick / teardown accordingly.
   *
   * The legacy `data` frame path on `streamSpec[ch]` entries
   * WITHOUT `source.tool` is unaffected — the router only manages
   * the source-fed subset.
   */
  readonly applyRender: (render: {
    readonly sessionId: string;
    readonly streamSpec?: StreamSpec;
  }) => void;

  /**
   * Forward a single inbound WS frame. The router consumes
   * `channel_payload` + `channel_error` types and ignores everything
   * else. Returns `true` iff the frame was consumed (so the caller
   * can short-circuit), `false` otherwise.
   */
  readonly handleWsFrame: (msg: WebSocketMessage) => boolean;

  /**
   * Notify the router of a WS connection status transition. Used to:
   *   - On `'disconnected'` / `'reconnecting'`: start polling fallback
   *     for every WS-bound channel (no delay).
   *   - On `'connected'` AFTER a prior disconnect: re-send
   *     `channel_subscribe` for every WS-bound channel.
   */
  readonly onWsStatusChange: (
    status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting',
  ) => void;

  /**
   * Tear down every active subscription + timer. Called on
   * `renderer.teardown`.
   */
  readonly dispose: () => void;
}

/**
 * Factory.
 *
 * Per-channel transport routing — owns the `(sessionId, channelName)`
 * registry, the WS-vs-poll decision per channel, and the cross-state
 * transitions (disconnect → poll fallback, reconnect → re-subscribe).
 */
export function createChannelTransportRouter(
  opts: ChannelTransportRouterOptions,
): ChannelTransportRouter {
  /**
   * Registry keyed by `${sessionId}:${channelName}`. The composite
   * key matches the server-side `channelSubs` map shape exactly, so
   * test snapshots line up.
   */
  const channels = new Map<string, ChannelState>();
  const allowlist = new Set(opts.streamWebSocketLocalTools ?? []);
  const defaultPollMs =
    opts.defaultPollIntervalMs ?? DEFAULT_IFRAME_POLL_INTERVAL_MS;
  // Clamped up — a degraded channel must never poll more eagerly than
  // a healthy one. See `probePollIntervalMs`.
  const probePollMs = Math.max(
    defaultPollMs,
    opts.probePollIntervalMs ?? DEFAULT_IFRAME_PROBE_POLL_INTERVAL_MS,
  );
  /**
   * WS lifecycle flag. We start in `'connected'` because the router
   * is created AFTER the subscribe ack — the runtime's bootSequence
   * resolves `subscribeFn(...)` before threading the manager into
   * renderer's `attachManager` (where the router is constructed).
   * Status transitions update this; the router uses it to decide
   * whether to start WS subscribes or skip straight to polling.
   */
  let wsStatus: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' =
    'connected';
  let disposed = false;

  const observe = opts.onObserve ?? ((): void => {});

  function keyOf(sessionId: string, channelName: string): string {
    return `${sessionId}:${channelName}`;
  }

  function stopPolling(state: ChannelState): void {
    if (state.pollTimer !== null) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function emitToBus(
    state: ChannelState,
    payload: JsonValue,
    complete?: boolean,
  ): void {
    const envelope: StreamEnvelope = {
      sessionId: state.sessionId,
      channel: state.channelName,
      mode: state.mode,
      payload,
      ...(complete === true ? { complete: true } : {}),
    };
    opts.streamBus.emit(envelope);
  }

  /**
   * (Re-)arm a channel's recurring timer at `intervalMs`. Only ever
   * called for a channel that is already polling — never resurrects a
   * stopped loop.
   */
  function armTimer(state: ChannelState, intervalMs: number): void {
    if (state.pollTimer !== null) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      void tick(state);
    }, intervalMs);
  }

  /**
   * Healthy → degraded. Slows the channel to the probe cadence and
   * announces the transition ONCE.
   *
   * No-ops when the channel isn't polling: an in-flight call can
   * resolve after `stopPolling` (WS payload arrived, channel removed,
   * router disposed), and a degraded channel with no loop to slow
   * down is not a transition worth announcing.
   */
  function degradePolling(state: ChannelState): void {
    if (state.pollDegraded) return;
    if (state.pollTimer === null) return;
    state.pollDegraded = true;
    armTimer(state, probePollMs);
    observe({
      kind: 'channel-poll-degraded',
      sessionId: state.sessionId,
      channelName: state.channelName,
      reason: 'relay-incapable',
      probeIntervalMs: probePollMs,
    });
  }

  /**
   * Degraded → healthy. Any successful poll proves the structural
   * condition has lifted, so the channel returns to its normal
   * cadence. Announced ONCE per recovery, not per subsequent success.
   */
  function restorePolling(state: ChannelState): void {
    if (!state.pollDegraded) return;
    state.pollDegraded = false;
    if (state.pollTimer !== null) armTimer(state, defaultPollMs);
    observe({
      kind: 'channel-poll-recovered',
      sessionId: state.sessionId,
      channelName: state.channelName,
      pollIntervalMs: defaultPollMs,
    });
  }

  /**
   * One poll of one channel: call the tool, classify the outcome,
   * emit the payload.
   *
   * The two failure kinds are the `ToolsCallInvoker` rejection
   * contract, classified by TYPE (never by message text):
   *
   *   - Structural (`RelayIncapableError`) — the next tick would fail
   *     identically, so slow to the probe cadence and say so once.
   *   - Transient (anything else) — stay quiet and keep the cadence.
   *     The renderer's observability path already surfaces transport
   *     failures via the WS error route; per-tool poll failures do
   *     not also become bus noise during a passing outage.
   *
   * Neither kind stops the loop. That is the fail-safe: a channel
   * whose host regains the ability to relay recovers on its own,
   * within one probe interval, with no external nudge.
   */
  const tick = async (state: ChannelState): Promise<void> => {
    if (disposed) return;
    try {
      const payload = await opts.toolsCall({
        toolName: state.toolName,
        args: { ...(state.args ?? {}) },
      });
      if (disposed) return;
      // Restore BEFORE emitting: a throwing bus subscriber must not
      // be mistaken for a failed poll (it would land in the catch
      // below and read as transient), and it must not cost this
      // channel its recovery.
      restorePolling(state);
      emitToBus(state, payload);
    } catch (err) {
      if (disposed) return;
      if (isRelayIncapableError(err)) degradePolling(state);
    }
  };

  /**
   * Start an iframe-polling loop for one channel. Idempotent — if a
   * timer is already running we leave it alone. Fires the first poll
   * IMMEDIATELY (no `setInterval` lead-in delay) so the first
   * `useStream` render isn't blocked on a 10-second wait.
   *
   * A channel that was already degraded when its loop last stopped
   * re-arms at the probe cadence — the condition that degraded it
   * belongs to the host, and a WS reconnect cycle is no evidence it
   * has lifted. Only a successful poll is.
   */
  function startPolling(state: ChannelState): void {
    if (state.pollTimer !== null) return;
    // Arm BEFORE firing the leading tick. `ToolsCallInvoker` is
    // declared to return a promise, but a non-async implementation
    // that throws satisfies that type, and its failure reaches the
    // tick's catch during THIS function's own synchronous execution.
    // Arming second would leave `pollTimer` null at that moment, and
    // `degradePolling`'s stopped-channel guard would (correctly, for
    // what it can see) ignore it — costing the channel a full degrade
    // cycle. Order here is the only thing that closes that window.
    state.pollTimer = setInterval(
      () => {
        void tick(state);
      },
      state.pollDegraded ? probePollMs : defaultPollMs,
    );
    // Fire-and-forget the leading tick. Wrapped in the `disposed`
    // guard above.
    void tick(state);
  }

  /**
   * Send a `channel_subscribe` WS frame. Server-side bookkeeping is
   * idempotent on `(sessionId, channelName)`, so re-sends on reconnect
   * are safe.
   */
  function sendSubscribe(state: ChannelState): void {
    opts.send({
      type: 'channel_subscribe',
      payload: {
        sessionId: state.sessionId,
        appId: opts.appId,
        channelName: state.channelName,
        ...(state.args !== undefined ? { args: { ...state.args } } : {}),
      },
    });
  }

  /**
   * Send a `channel_unsubscribe` WS frame for a removed channel.
   * Server-side is also idempotent on unknown pairs.
   */
  function sendUnsubscribe(state: ChannelState): void {
    if (wsStatus !== 'connected') return;
    opts.send({
      type: 'channel_unsubscribe',
      payload: {
        sessionId: state.sessionId,
        appId: opts.appId,
        channelName: state.channelName,
      },
    });
  }

  /**
   * Bootstrap a channel onto its preferred transport.
   *
   *   - `preferWs && wsStatus === 'connected'` → send subscribe,
   *     observe `'ws'` pick.
   *   - `preferWs && wsStatus !== 'connected'` → start polling
   *     fallback NOW so the user sees data while the WS reconnects,
   *     observe `'poll'` pick. When the WS comes up, we'll attempt
   *     `sendSubscribe` from `onWsStatusChange`.
   *   - `!preferWs` → polling, observe `'poll'`.
   */
  function activate(state: ChannelState): void {
    if (state.preferWs && !state.permanentPollFallback) {
      if (wsStatus === 'connected') {
        sendSubscribe(state);
        observe({
          kind: 'channel-transport-picked',
          sessionId: state.sessionId,
          channelName: state.channelName,
          transport: 'ws',
        });
        return;
      }
      // WS not ready yet — fall through to polling. We'll re-attempt
      // the subscribe on the next 'connected' transition.
      startPolling(state);
      observe({
        kind: 'channel-transport-picked',
        sessionId: state.sessionId,
        channelName: state.channelName,
        transport: 'poll',
      });
      return;
    }
    startPolling(state);
    observe({
      kind: 'channel-transport-picked',
      sessionId: state.sessionId,
      channelName: state.channelName,
      transport: 'poll',
    });
  }

  return {
    applyRender: (render) => {
      if (disposed) return;
      const seenKeys = new Set<string>();
      const spec = render.streamSpec ?? {};

      for (const [channelName, entry] of Object.entries(spec)) {
        const source = entry.source;
        // Channels without a `source.tool` declaration stay on the
        // legacy `data` frame path — agent → server → fan-out. The
        // router only manages the source-fed subset (1c scope).
        if (
          source === undefined ||
          source === null ||
          typeof source !== 'object' ||
          typeof source.tool !== 'string' ||
          source.tool.length === 0
        ) {
          continue;
        }
        const toolName = source.tool;
        const channelArgs =
          source.args !== undefined && source.args !== null
            ? (source.args as JsonObject)
            : undefined;
        const k = keyOf(render.sessionId, channelName);
        seenKeys.add(k);

        const existing = channels.get(k);
        if (existing !== undefined) {
          // Same (sessionId, channelName) — leave the transport
          // bookkeeping alone. Spec changes that flip preferWs
          // mid-render are out of 1c scope (would require
          // re-handshake).
          continue;
        }

        const state: ChannelState = {
          sessionId: render.sessionId,
          channelName,
          toolName,
          ...(channelArgs !== undefined ? { args: channelArgs } : {}),
          mode: entry.mode ?? 'append',
          preferWs: allowlist.has(toolName),
          pollTimer: null,
          hasReceivedWsPayload: false,
          permanentPollFallback: false,
          pollDegraded: false,
        };
        channels.set(k, state);
        activate(state);
      }

      // Tear down any channel for THIS render that's no longer in the
      // spec. Channels for OTHER renders stay — they belong to other
      // mounts that haven't been re-applied yet. Close-render paths
      // call `dispose()` for the wholesale teardown.
      for (const [k, state] of channels) {
        if (
          state.sessionId === render.sessionId &&
          !seenKeys.has(k)
        ) {
          stopPolling(state);
          sendUnsubscribe(state);
          channels.delete(k);
        }
      }
    },

    handleWsFrame: (msg) => {
      if (disposed) return false;
      if (msg.type === 'channel_payload') {
        const p = msg.payload;
        const k = keyOf(p.sessionId, p.channelName);
        const state = channels.get(k);
        if (state === undefined) return false;
        // First WS payload after a disconnect-fallback → cancel the
        // polling loop. Server has demonstrably resumed fan-out, so
        // we don't need the redundant iframe-poll source for this
        // channel any more (on this lifecycle).
        if (!state.hasReceivedWsPayload && state.pollTimer !== null) {
          stopPolling(state);
        }
        state.hasReceivedWsPayload = true;
        emitToBus(state, p.payload, p.complete);
        return true;
      }
      if (msg.type === 'channel_error') {
        const p = msg.payload;
        // Locate by `channelName` only — the error payload doesn't
        // carry `sessionId`. We match by channel-name across active
        // items and apply the permanent-fallback flag to the matching
        // entries. Same channel name across renders is rare; the
        // policy is conservative (fall back ALL matches rather than
        // miss one).
        for (const state of channels.values()) {
          if (state.channelName !== p.channelName) continue;
          if (
            p.code === 'CHANNEL_NOT_LOCAL' ||
            p.code === 'CHANNEL_UNKNOWN' ||
            p.code === 'SESSION_NOT_FOUND'
          ) {
            state.permanentPollFallback = true;
            startPolling(state);
            observe({
              kind: 'channel-transport-fallback',
              sessionId: state.sessionId,
              channelName: state.channelName,
              reason: 'channel-not-local',
            });
          }
          // POLL_FAILED / SUBSCRIBE_UNAUTHORIZED are transient — the
          // server may recover. Don't flip the permanent fallback;
          // leave the WS path active. (UNAUTHORIZED would normally
          // imply the bootstrap token expired, in which case the
          // outer subscribe-fail path tears down the whole socket;
          // we don't need to special-case it here.)
        }
        return true;
      }
      return false;
    },

    onWsStatusChange: (status) => {
      if (disposed) return;
      const prevStatus = wsStatus;
      wsStatus = status;
      if (status === 'disconnected' || status === 'reconnecting') {
        // Every WS-preferring channel falls back to polling
        // IMMEDIATELY. The user sees fresh data while the reconnect
        // ladder runs. Reset the `hasReceivedWsPayload` flag so the
        // first post-reconnect payload re-triggers the
        // "stop the polling fallback" transition.
        for (const state of channels.values()) {
          if (!state.preferWs) continue;
          if (state.permanentPollFallback) continue;
          if (state.hasReceivedWsPayload) {
            state.hasReceivedWsPayload = false;
          }
          if (state.pollTimer === null) {
            startPolling(state);
            observe({
              kind: 'channel-transport-fallback',
              sessionId: state.sessionId,
              channelName: state.channelName,
              reason: 'ws-disconnect',
            });
          }
        }
        return;
      }
      if (
        status === 'connected' &&
        (prevStatus === 'disconnected' || prevStatus === 'reconnecting')
      ) {
        // Reconnected. Re-send `channel_subscribe` for every
        // WS-preferring channel. Server is idempotent on the
        // (render, channel) tuple, so duplicates are safe. We
        // intentionally LEAVE the polling fallback running until the
        // first `channel_payload` lands — bridges the gap where the
        // server's first post-reconnect poll cycle hasn't fired yet.
        for (const state of channels.values()) {
          if (!state.preferWs) continue;
          if (state.permanentPollFallback) continue;
          sendSubscribe(state);
          observe({
            kind: 'channel-transport-resubscribed',
            sessionId: state.sessionId,
            channelName: state.channelName,
          });
        }
      }
    },

    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const state of channels.values()) {
        stopPolling(state);
      }
      channels.clear();
    },
  };
}
