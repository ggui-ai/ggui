/**
 * Shared `WireConfig` construction — the ONE envelope-build → validate
 * → emit pipeline plus the bus-backed `subscribe` seam that BOTH
 * first-party renderers compose:
 *
 *   - `@ggui-ai/iframe-runtime`'s `buildRootWireConfig` (the MCP-Apps
 *     iframe boot) injects its CSP-precompiled outbound validator and
 *     routes `emitEnvelope` through the host `tools/call` relay.
 *   - `@ggui-ai/mcp-apps-react`'s `<GguiRender>` uses the default validator and
 *     routes `emitEnvelope` over its live-channel WebSocket.
 *
 * Per the MCP Apps Compliance principle, drift across transports is
 * structurally impossible only when every transport flows from one
 * implementation — this module is that implementation for the
 * client-side dispatch/subscribe halves. Renderer-specific policy
 * (violation sinks, transport, actionSpec resolution) stays injected.
 */
import type {
  ActionEnvelope,
  ActionSpec,
  JsonValue,
  StreamEnvelope,
  ValidationResult,
} from '@ggui-ai/protocol/wire';
import { RESERVED_CHANNEL_PREFIX } from '@ggui-ai/protocol/wire';
import {
  buildActionEnvelope,
  ClientContractViolationError,
  validateOutboundActionEnvelope,
} from './contract';
import type { DispatchSuppressedInfo, WireConfig } from './context';
import { payloadSignature } from './dispatch-dedup';

/**
 * Per-channel ring cap for late-subscriber replay on reserved channels.
 * Mirrors the server-side `DEFAULT_SESSION_STREAM_BUFFER_MAX` posture:
 * bounded so a long-lived surface can't grow memory unbounded if a
 * reserved channel emits in a hot loop.
 *
 * 256 is enough headroom for the deterministic A2UI emitter (one frame
 * per fragment, ~5–15 frames per render) plus several refresh cycles,
 * and still fits comfortably in memory.
 */
export const RESERVED_CHANNEL_REPLAY_MAX = 256;

/**
 * Tiny fan-out bus keyed by channel name. The renderer's inbound
 * frame handler pushes validated `data` envelopes here; wire's
 * `useStream(channel)` subscribes per-component via the config's
 * `subscribe()` method.
 *
 * Late-subscriber replay for reserved channels:
 *
 *   Both first-party renderers boot in a strict ordering: subscribe →
 *   first `ack` → fold the render → mount the provisional surface → it
 *   then subscribes to `_ggui:preview`. Server-side replay frames for
 *   `_ggui:preview` (the provisional A2UI preamble fired during the
 *   agent's `ggui_render` BEFORE the user's surface attached) arrive
 *   in the window between ack-resolve and the provisional mount — they
 *   hit `emit()` before any listener has subscribed. Without a bounded
 *   reserved-channel ring, those frames vanish and the preview surface
 *   stays stuck on the spinner.
 *
 *   Server-owned `_ggui:*` channels are buffered in a per-channel ring
 *   capped at {@link RESERVED_CHANNEL_REPLAY_MAX}. New subscribers
 *   receive the buffered envelopes synchronously before the
 *   unsubscribe handle returns — same mental model as the server-side
 *   `GguiSessionStreamBuffer.replay(...)` walk over reserved channels
 *   at ack time, but mirrored at the inner bus boundary so the host
 *   transport stays portable (Claude Desktop / ChatGPT / Cursor /
 *   `<McpAppIframe>` / `<GguiRender>` all behave the same).
 *
 *   Agent-declared (non-reserved) channels are NOT buffered here. Their
 *   replay is the server's job — the renderer's `subscribe()` handshake
 *   pulls history per `streamSpec.replay` policy when reconnecting with
 *   `fromSeq`. Buffering them at this layer would double-count and
 *   change the semantics of agent contracts.
 *
 * No observable mutation outside the renderer boundary — the bus is
 * internal plumbing.
 */
export class StreamBus {
  private listeners = new Map<string, Set<(env: StreamEnvelope) => void>>();
  /**
   * Per-channel bounded ring of envelopes for reserved (`_ggui:*`)
   * channels only. FIFO eviction at `RESERVED_CHANNEL_REPLAY_MAX`.
   * Replayed to every new subscriber for that channel.
   */
  private reservedReplay = new Map<string, StreamEnvelope[]>();

  subscribe(channel: string, listener: (env: StreamEnvelope) => void): () => void {
    let bucket = this.listeners.get(channel);
    if (bucket === undefined) {
      bucket = new Set();
      this.listeners.set(channel, bucket);
    }
    bucket.add(listener);
    // Replay buffered reserved-channel envelopes BEFORE returning the
    // unsubscribe handle so the new listener is fully caught up by the
    // time `subscribe()` returns. Order matches arrival order at
    // `emit()` (FIFO ring).
    if (channel.startsWith(RESERVED_CHANNEL_PREFIX)) {
      const ring = this.reservedReplay.get(channel);
      if (ring !== undefined) {
        for (const env of ring) {
          listener(env);
        }
      }
    }
    return () => {
      const current = this.listeners.get(channel);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(channel);
    };
  }

  emit(envelope: StreamEnvelope): void {
    if (envelope.channel.startsWith(RESERVED_CHANNEL_PREFIX)) {
      let ring = this.reservedReplay.get(envelope.channel);
      if (ring === undefined) {
        ring = [];
        this.reservedReplay.set(envelope.channel, ring);
      }
      ring.push(envelope);
      if (ring.length > RESERVED_CHANNEL_REPLAY_MAX) {
        // FIFO drop — keeps the most recent
        // `RESERVED_CHANNEL_REPLAY_MAX` frames. Late subscribers may
        // miss the createSurface fragment if the ring overflows (would
        // render as Spinner-stuck), but that's an upper-bound contract
        // on a bounded buffer, not a silent failure mode in practice.
        ring.shift();
      }
    }
    const bucket = this.listeners.get(envelope.channel);
    if (bucket === undefined) return;
    for (const listener of bucket) {
      listener(envelope);
    }
  }
}

/**
 * Options for {@link buildWireConfig}. The static `app` / `render` /
 * `auth` blocks pass through verbatim; the four seams parameterize
 * everything renderer-specific.
 */
export interface BuildWireConfigOptions {
  readonly app: WireConfig['app'];
  readonly render: WireConfig['render'];
  readonly auth: WireConfig['auth'];
  /**
   * Resolve the active render's `actionSpec` at dispatch time. A thunk
   * — not a snapshot — so the outbound validator stays coherent across
   * `props_update` patches (which replace the render reference)
   * without rebuilding the config.
   */
  readonly getActiveActionSpec: () => ActionSpec | undefined;
  /**
   * Validate the built envelope before emission. Defaults to wire's
   * own {@link validateOutboundActionEnvelope}. The iframe runtime
   * injects its precompiled-validator variant so the dispatch never
   * trips the iframe's no-`unsafe-eval` CSP.
   */
  readonly validateEnvelope?: (
    actionSpec: ActionSpec | undefined,
    envelope: ActionEnvelope,
  ) => ValidationResult;
  /**
   * Violation sink — receives the typed
   * {@link ClientContractViolationError} when outbound validation
   * fails (the envelope is NOT emitted). Each renderer wires its own
   * surfacing policy (`onError` callback, ProtocolError emitter,
   * console fallback).
   */
  readonly onViolation: (err: ClientContractViolationError) => void;
  /**
   * Transport seam — receives the VALIDATED envelope. The iframe
   * runtime routes via the MCP-Apps host `tools/call` relay (spec
   * §401); `<GguiRender>` sends the live-channel WS `action` frame.
   * Both ingresses land the gesture on the server's pending-events
   * pipe, so `ggui_consume` drains it either way.
   */
  readonly emitEnvelope: (envelope: ActionEnvelope) => void;
  /** Inbound delivery bus the config's `subscribe()` reads from. */
  readonly streamBus: StreamBus;
  /**
   * Client-monotonic `clientSeq` source. Defaults to an internal
   * counter whose first emission carries `clientSeq: 1`. Renderers
   * that ALSO emit envelopes outside this config (e.g. `<GguiRender>`'s
   * imperative `api.action`) share their counter here so per-session
   * sequencing stays monotonic across emission sites.
   */
  readonly nextClientSeq?: () => number;
  /**
   * Optional structured sink for BOTH suppression invariants — the
   * render-lifetime one-shot guard fired by this config's `dispatch`
   * (`reason: 'one-shot-spent'`, ggui#1108) and, when set on the returned
   * config, `useAction`'s task-scoped duplicate backstop
   * (`reason: 'duplicate-dispatch'`). Omitted on the first-party render
   * paths — there the always-on `console.warn` is the trace, which is the
   * minimum the `oneShot` contract requires.
   */
  readonly onDispatchSuppressed?: (info: DispatchSuppressedInfo) => void;
}

/**
 * Build a `WireConfig` over the shared dispatch/subscribe pipeline.
 *
 * Dispatch: resolve the active actionSpec through the thunk → build
 * the canonical `data:submit` {@link ActionEnvelope} (the envelope
 * carries `action` + `data` only; the operator-facing `tool` hint on
 * the retained ledger event is derived SERVER-side from
 * `actionSpec[name].nextStep` at ingress) → validate → on violation,
 * surface through the sink and SKIP the emit → otherwise hand the
 * envelope to the transport seam.
 *
 * Subscribe: delegate to the {@link StreamBus}, unwrapping each
 * envelope to the `StreamDelivery` shape (`payload` / `mode` /
 * `complete`) wire hooks consume. Reserved-channel late subscribers
 * are caught up synchronously from the bus's bounded replay ring.
 */
export function buildWireConfig(opts: BuildWireConfigOptions): WireConfig {
  let internalSeq = 0;
  const nextClientSeq =
    opts.nextClientSeq ??
    (() => {
      internalSeq += 1;
      return internalSeq;
    });
  const validateEnvelope = opts.validateEnvelope ?? validateOutboundActionEnvelope;

  // ggui#1108 — the one-shot guard. This config is built ONCE per render
  // (the iframe's boot; `props_update` reuses it, a new card is a new iframe
  // and a new config), so a closure-local set of already-fired one-shot
  // actions is exactly the RENDER's lifetime. `useAction`'s task-scoped
  // dedup catches a double-fire from ONE gesture; this catches a SECOND
  // gesture on an action the contract declared `oneShot` — the founder's
  // "the submitted form still reads as a live request". The marker is the
  // contract's flag, resolved through the same `getActiveActionSpec` thunk
  // the validator uses; the guard NEVER infers one-shot from a name.
  const spentOneShots = new Set<string>();

  return {
    app: opts.app,
    render: opts.render,
    auth: opts.auth,
    ...(opts.onDispatchSuppressed !== undefined
      ? { onDispatchSuppressed: opts.onDispatchSuppressed }
      : {}),
    dispatch: (actionName, data) => {
      const actionSpec = opts.getActiveActionSpec();
      const isOneShot = actionSpec?.[actionName]?.oneShot === true;
      if (isOneShot && spentOneShots.has(actionName)) {
        // NEVER SILENT — the runtime's diagnostic channel (`console.warn`)
        // carries the actionId and `oneShot` as the reason, and the dispatch
        // does NOT reach the agent (no `emitEnvelope`). The structured sink
        // fires alongside when a host provided one.
        // eslint-disable-next-line no-console
        console.warn(
          `[ggui] dispatch('${actionName}') suppressed: this action is declared ` +
            `oneShot and already fired for this render. A second gesture is NOT ` +
            `sent to the agent — the submitted control is spent for the render's ` +
            `lifetime. If the action is meant to repeat, remove \`oneShot\` from ` +
            `its contract entry.`,
        );
        opts.onDispatchSuppressed?.({
          reason: 'one-shot-spent',
          actionName,
          payloadSignature: payloadSignature(actionName, data),
          payload: data,
          suppressedAt: Date.now(),
        });
        return;
      }
      const envelope = buildActionEnvelope({
        sessionId: opts.render.sessionId,
        type: 'data:submit',
        payload: {
          action: actionName,
          data: data as JsonValue,
        },
        clientSeq: nextClientSeq(),
      });
      const result = validateEnvelope(actionSpec, envelope);
      if (!result.valid) {
        // Not spent: a rejected envelope never reached the agent, so a
        // corrected retry of a one-shot action must still be allowed to fire.
        opts.onViolation(
          new ClientContractViolationError('outbound-action', result.violations),
        );
        return;
      }
      // Spend only on a committed fire — the marker records that the agent
      // WILL receive this gesture, so the next one is the suppressible repeat.
      if (isOneShot) spentOneShots.add(actionName);
      opts.emitEnvelope(envelope);
    },
    subscribe: (channelName, handler) => {
      return opts.streamBus.subscribe(channelName, (env) => {
        // `WireConfig<DataContract>.subscribe`'s handler expects a
        // `StreamDelivery<unknown>`; the bus ships the raw envelope
        // payload unmodified. The type-level narrowing lives on the
        // caller's generic boundary (useStream / useContract).
        handler({
          payload: env.payload,
          mode: env.mode,
          ...(env.complete !== undefined ? { complete: env.complete } : {}),
        });
      });
    },
  };
}
