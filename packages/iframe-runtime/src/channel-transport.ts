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
 *     the parent MCP host (Pattern α — direct, no bridge). Works
 *     for any tool the agent has access to, including third-party
 *     MCP servers the local pod can't subscribe-for.
 *
 * The dispatch decision is per-channel + per-render (each new push
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
 * on the {@link RendererWebSocketManager}. The router only watches
 * status transitions; it doesn't own the reconnect schedule.
 *
 * **Idempotence** — re-subscribing the same `(stackItemId, channelName)`
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
import type { StreamBus } from './wire-config.js';

/**
 * Default polling cadence for the iframe-polling transport (ms).
 * Mirrors the server-side default on
 * {@link DEFAULT_CHANNEL_POLL_DEFAULT_MS} in
 * `packages/mcp-server/src/session-channel.ts`. Conservative: 10s
 * matches a "data is fresh enough" bar without burning the parent
 * host's `tools/call` quota.
 */
export const DEFAULT_IFRAME_POLL_INTERVAL_MS = 10_000;

/**
 * One-channel subscription record. Tracks transport state across the
 * stack-item lifecycle and across WS disconnect/reconnect transitions.
 */
interface ChannelState {
  /** Stack item id the subscription is bound to. */
  readonly stackItemId: string;
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
   *   - the channel is removed (stack pop / new push),
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
}

/**
 * Sender for outbound WS frames. The renderer's
 * {@link RendererWebSocketManager.send} fits structurally — pass
 * `manager.send.bind(manager)` or the buffered manager shim.
 */
export type WsSender = (msg: WebSocketMessage) => void;

/**
 * Iframe → parent `tools/call` invoker. Resolves with the tool's
 * structured-content output (parsed `JsonValue`) or rejects on
 * transport-level failure. The router will swallow the failure +
 * keep the poll loop running (next tick may succeed).
 */
export type ToolsCallInvoker = (args: {
  readonly toolName: string;
  readonly args: JsonObject;
}) => Promise<JsonValue>;

/**
 * Options for {@link createChannelTransportRouter}.
 */
export interface ChannelTransportRouterOptions {
  /** Session id the router scopes channel_subscribe frames against. */
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
   * Default poll cadence (ms) for the iframe-polling transport.
   * Overridden per-channel via `streamSpec[name].source.pollIntervalMs`
   * when authored. Falls back to {@link DEFAULT_IFRAME_POLL_INTERVAL_MS}
   * when neither the spec nor the option supplies one.
   */
  readonly defaultPollIntervalMs?: number;
  /**
   * Observability sink — fires once per transport pick + once per
   * disconnect/reconnect-fallback transition. Optional; absent ⇒
   * silent.
   */
  readonly onObserve?: (event: ChannelTransportEvent) => void;
}

/**
 * Observability events the router emits. Hosts that wire `onObserve`
 * see these alongside the renderer's other observability events
 * (`subscribe-failed`, `wired-tool-invoked`, …). The shape stays
 * narrow + non-breaking so future events can extend the union.
 */
export type ChannelTransportEvent =
  | {
      readonly kind: 'channel-transport-picked';
      readonly stackItemId: string;
      readonly channelName: string;
      readonly transport: 'ws' | 'poll';
    }
  | {
      readonly kind: 'channel-transport-fallback';
      readonly stackItemId: string;
      readonly channelName: string;
      readonly reason: 'ws-disconnect' | 'channel-not-local';
    }
  | {
      readonly kind: 'channel-transport-resubscribed';
      readonly stackItemId: string;
      readonly channelName: string;
    };

/**
 * Router handle returned by {@link createChannelTransportRouter}.
 */
export interface ChannelTransportRouter {
  /**
   * Apply a new stack item's `streamSpec`. Idempotent against
   * re-applying the same shape (no churn). Channels added/removed
   * across renders fire transport pick / teardown accordingly.
   *
   * The legacy `data` frame path on `streamSpec[ch]` entries
   * WITHOUT `source.tool` is unaffected — the router only manages
   * the source-fed subset.
   */
  readonly applyStackItem: (item: {
    readonly stackItemId: string;
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
 * Per-channel transport routing — owns the `(stackItemId, channelName)`
 * registry, the WS-vs-poll decision per channel, and the cross-state
 * transitions (disconnect → poll fallback, reconnect → re-subscribe).
 */
export function createChannelTransportRouter(
  opts: ChannelTransportRouterOptions,
): ChannelTransportRouter {
  /**
   * Registry keyed by `${stackItemId}:${channelName}`. The composite
   * key matches the server-side `channelSubs` map shape exactly, so
   * test snapshots line up.
   */
  const channels = new Map<string, ChannelState>();
  const allowlist = new Set(opts.streamWebSocketLocalTools ?? []);
  const defaultPollMs =
    opts.defaultPollIntervalMs ?? DEFAULT_IFRAME_POLL_INTERVAL_MS;
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

  function keyOf(stackItemId: string, channelName: string): string {
    return `${stackItemId}:${channelName}`;
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
      sessionId: opts.sessionId,
      channel: state.channelName,
      mode: state.mode,
      payload,
      ...(complete === true ? { complete: true } : {}),
    };
    opts.streamBus.emit(envelope);
  }

  /**
   * Start an iframe-polling loop for one channel. Idempotent — if a
   * timer is already running we leave it alone. Fires the first poll
   * IMMEDIATELY (no `setInterval` lead-in delay) so the first
   * `useStream` render isn't blocked on a 10-second wait.
   */
  function startPolling(state: ChannelState): void {
    if (state.pollTimer !== null) return;
    const tick = async (): Promise<void> => {
      if (disposed) return;
      try {
        const payload = await opts.toolsCall({
          toolName: state.toolName,
          args: { ...(state.args ?? {}) },
        });
        if (disposed) return;
        emitToBus(state, payload);
      } catch {
        // Swallow — next tick may succeed. The renderer's
        // observability path already surfaces transport failures
        // via the WS error route; per-tool poll failures stay quiet
        // to avoid a noisy bus during transient outages.
      }
    };
    // Fire-and-forget the leading tick + schedule the recurring
    // ticks. Both are wrapped in the `disposed` guard above.
    void tick();
    state.pollTimer = setInterval(() => {
      void tick();
    }, defaultPollMs);
  }

  /**
   * Send a `channel_subscribe` WS frame. Server-side bookkeeping is
   * idempotent on `(sessionId, stackItemId, channelName)`, so re-sends
   * on reconnect are safe.
   */
  function sendSubscribe(state: ChannelState): void {
    opts.send({
      type: 'channel_subscribe',
      payload: {
        sessionId: opts.sessionId,
        appId: opts.appId,
        stackItemId: state.stackItemId,
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
        sessionId: opts.sessionId,
        appId: opts.appId,
        stackItemId: state.stackItemId,
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
          stackItemId: state.stackItemId,
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
        stackItemId: state.stackItemId,
        channelName: state.channelName,
        transport: 'poll',
      });
      return;
    }
    startPolling(state);
    observe({
      kind: 'channel-transport-picked',
      stackItemId: state.stackItemId,
      channelName: state.channelName,
      transport: 'poll',
    });
  }

  return {
    applyStackItem: (item) => {
      if (disposed) return;
      const seenKeys = new Set<string>();
      const spec = item.streamSpec ?? {};

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
        const k = keyOf(item.stackItemId, channelName);
        seenKeys.add(k);

        const existing = channels.get(k);
        if (existing !== undefined) {
          // Same (stackItemId, channelName) — leave the transport
          // bookkeeping alone. Spec changes that flip preferWs
          // mid-session are out of 1c scope (would require
          // re-handshake).
          continue;
        }

        const state: ChannelState = {
          stackItemId: item.stackItemId,
          channelName,
          toolName,
          ...(channelArgs !== undefined ? { args: channelArgs } : {}),
          mode: entry.mode ?? 'append',
          preferWs: allowlist.has(toolName),
          pollTimer: null,
          hasReceivedWsPayload: false,
          permanentPollFallback: false,
        };
        channels.set(k, state);
        activate(state);
      }

      // Tear down any channel for THIS stack item that's no longer in
      // the spec. Channels for OTHER stack items stay — they belong
      // to other items that haven't been re-applied yet. Stack-pop /
      // close-session paths call `dispose()` for the wholesale
      // teardown.
      for (const [k, state] of channels) {
        if (
          state.stackItemId === item.stackItemId &&
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
        const k = keyOf(p.stackItemId, p.channelName);
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
        // carry `stackItemId`. We match by channel-name across active
        // items and apply the permanent-fallback flag to the matching
        // entries. Same channel name across stack items is rare; the
        // policy is conservative (fall back ALL matches rather than
        // miss one).
        for (const state of channels.values()) {
          if (state.channelName !== p.channelName) continue;
          if (
            p.code === 'CHANNEL_NOT_LOCAL' ||
            p.code === 'CHANNEL_UNKNOWN' ||
            p.code === 'STACK_ITEM_NOT_FOUND'
          ) {
            state.permanentPollFallback = true;
            startPolling(state);
            observe({
              kind: 'channel-transport-fallback',
              stackItemId: state.stackItemId,
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
              stackItemId: state.stackItemId,
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
        // WS-preferring channel. Server is idempotent on the (session,
        // stackItem, channel) triple, so duplicates are safe. We
        // intentionally LEAVE the polling fallback running until the
        // first `channel_payload` lands — bridges the gap where the
        // server's first post-reconnect poll cycle hasn't fired yet.
        for (const state of channels.values()) {
          if (!state.preferWs) continue;
          if (state.permanentPollFallback) continue;
          sendSubscribe(state);
          observe({
            kind: 'channel-transport-resubscribed',
            stackItemId: state.stackItemId,
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
