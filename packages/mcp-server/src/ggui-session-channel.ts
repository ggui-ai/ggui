/**
 * OSS live channel — live render plane over WebSocket.
 *
 * The live channel is where the typed-channel contract is enforced on
 * live traffic between the server and the user. It co-hosts on the
 * same Express server as `/mcp` and reuses the
 * `@ggui-ai/mcp-server-handlers/renders` helpers, so every
 * deployment of this server family enforces the same contracts.
 *
 * Scope:
 *
 *   - `subscribe` → auth, resolve-or-create render, register subscriber,
 *     reply `ack` with the render's current snapshot + sequence.
 *   - `action` → inbound user action carried as an {@link ActionEnvelope}.
 *     Gated through `assertActionContract` (payload, for data:submit).
 *     Persisted to GguiSessionStore as a typed render event.
 *   - `ping`/`pong` → heartbeat parity with hosted.
 *   - `close`/socket-close → clean subscriber teardown.
 *   - `sendToGguiSession(sessionId, data)` → outbound fan-out API for
 *     mutation handlers (ggui_emit / connector `ctx.send`). Validated
 *     through `assertStreamContract` before delivery.
 *
 * `props_update`: the agent-driven `ggui_update` handler calls
 * `channel.sendPropsUpdate(sessionId, props)` (wired as its
 * `propsUpdateNotifier`) to fan a `{type:'props_update'}` frame to
 * live subscribers. Reaches the renderer's existing `props_update`
 * branch in `iframe-runtime` and applies new props in-place.
 *
 * Not handled here:
 *
 *   - Pattern-B daemon-agent notification stream (GET /mcp SSE).
 *   - Short-lived render-token mint/consume — that's ggui_render-gated.
 *     Dev-mode auth (any bearer via existing AuthAdapter) matches the
 *     `/mcp` endpoint's shape and is operator-replaceable.
 *
 * Module layout: this file owns the public surface (options, server
 * interface, composer). The handler families live in
 * `./ggui-session-channel/` as factories taking explicit typed deps:
 *
 *   - `outbound.ts` — send/fan-out primitives + the public fan-out
 *     surfaces (`sendToGguiSession`, `sendPropsUpdate`, …).
 *   - `subscriber-lifecycle.ts` — register / live-tail pump /
 *     unregister + the 0↔1 subscriber-count hooks.
 *   - `subscribe.ts` — upgrade-time identity resolution (bearer /
 *     bootstrap / console cookie) + the `subscribe` handler.
 *   - `action-ingress.ts` — `action` contract gate + ledger/pipe
 *     dual-write + ack.
 *   - `channel-subscriptions.ts` — `channel_subscribe` source-tool
 *     polling loops.
 *   - `socket-router.ts` — `connection` wiring with the per-socket
 *     inbound ordering chain + the message-type dispatcher.
 */

import type {
  AuthAdapter,
  AuthResult,
  PendingEventConsumer,
  GguiSessionStore,
  GguiSessionStreamBuffer,
  StreamEnvelopeInput,
  StreamFanout,
  TelemetrySink,
} from "@ggui-ai/mcp-server-core";
import {
  InMemoryGguiSessionStreamBuffer,
  InProcessStreamFanout,
} from "@ggui-ai/mcp-server-core/in-memory";
import type { JsonObject, GguiSession, ReservedChannelValidator } from "@ggui-ai/protocol";
import type { WebSocketMessage } from "@ggui-ai/protocol/transport/websocket";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { UnauthenticatedError } from "./auth.js";
import { createActionIngress } from "./ggui-session-channel/action-ingress.js";
import {
  createChannelSubscriptions,
  type GguiSessionChannelLocalToolsOptions,
} from "./ggui-session-channel/channel-subscriptions.js";
import type { Subscriber, UpgradeBindings } from "./ggui-session-channel/internal-types.js";
import { createOutbound } from "./ggui-session-channel/outbound.js";
import { attachSocketRouter } from "./ggui-session-channel/socket-router.js";
import {
  createSubscribeHandlers,
  type GguiSessionChannelBootstrap,
  type GguiSessionChannelCookieAuth,
} from "./ggui-session-channel/subscribe.js";
import { createSubscriberLifecycle } from "./ggui-session-channel/subscriber-lifecycle.js";
import type { Logger } from "./logger.js";

/** Default URL path for the channel endpoint. Operators can override. */
export const DEFAULT_RENDER_CHANNEL_PATH = "/ws";

// Channel-subscribe / source-poll family — the public options type
// lives with its handler module and is re-exported here so the
// package surface is unchanged.
export type { GguiSessionChannelLocalToolsOptions } from "./ggui-session-channel/channel-subscriptions.js";

// Subscribe / credential-path family — the bootstrap + cookie auth
// types live with their handler module and are re-exported here so
// the package surface is unchanged.
export type {
  GguiSessionChannelBootstrap,
  GguiSessionChannelBootstrapRefreshResult,
  GguiSessionChannelBootstrapVerifyResult,
  GguiSessionChannelCookieAuth,
} from "./ggui-session-channel/subscribe.js";

export interface GguiSessionChannelOptions {
  /** Required — the render backing store (typically `InMemoryGguiSessionStore`). */
  readonly renderStore: GguiSessionStore;
  /**
   * Optional pending-events pipe — the SAME `PendingEventConsumer`
   * instance the `ggui_consume` handler drains and the
   * `ggui_runtime_submit_action` relay appends to. When wired, the WS
   * `action` ingress dual-writes every accepted `data:submit` envelope:
   *
   *   1. `renderStore.appendEvent({type:'user.submitted', …})` — the
   *      append-only retained ledger (load-bearing for the ack `seq`
   *      and reconnect resume, exactly as before).
   *   2. `pendingEventConsumer.append(sessionId, {id, envelope,
   *      createdAt})` — the queue that wakes the agent's `ggui_consume`
   *      long-poll. The entry mirrors the relay's consume-entry shape
   *      (`ConsumeEventEntry`), so WS-originated gestures and
   *      tools/call-relayed gestures drain identically.
   *
   * A failed pipe append (e.g. the pipe was never opened because the
   * render didn't come from `ggui_render`) degrades to ledger-only with
   * a `render_channel_consume_append_failed` warn — ack semantics are
   * unchanged either way.
   *
   * Absent → ledger-only ingress (audit-only deployments, conformance
   * harnesses, and composers that registered no `ggui_consume`).
   * `createGguiServer` threads its shared instance here whenever it
   * composed the default handler set.
   */
  readonly pendingEventConsumer?: PendingEventConsumer;
  /**
   * Required — the same `AuthAdapter` the `/mcp` endpoint uses. Any
   * failure during `subscribe` rejects the upgrade with HTTP 401.
   */
  readonly auth: AuthAdapter;
  /**
   * Maps resolved identity → tenant appId for subscribes that omit
   * `payload.appId` (SPEC §12.2 identity-default resolution). Defaults
   * to `defaultAppIdFromIdentity` — same mapping the `/mcp` endpoint
   * uses. Token-bound subscribes (wsToken / console cookie) never
   * consult this seam: their credential already binds the appId.
   */
  readonly appIdFromIdentity?: (result: AuthResult) => string;
  /** Structured logger. */
  readonly logger: Logger;
  /** URL path to mount on. Defaults to `/ws`. */
  readonly path?: string;
  /**
   * Outbound stream replay buffer. Defaults to a fresh
   * `InMemoryGguiSessionStreamBuffer` when omitted — fine for OSS
   * zero-config / dev. Persistent adapters bind via the same
   * `GguiSessionStreamBuffer` interface when they land.
   *
   * Each channel instance owns its own seq cursor space; sharing a
   * buffer across two channels in the same process would couple their
   * sequences in confusing ways.
   */
  readonly streamBuffer?: GguiSessionStreamBuffer;
  /**
   * Live-tail pub/sub for outbound live-channel frames. Defaults to a
   * fresh `InProcessStreamFanout` (in-memory, single-process).
   * Multi-process deployments bind a pubsub-backed `StreamFanout`
   * implementation (e.g. Redis) behind this seam for cross-process
   * fan-out.
   *
   * The channel server uses the seam to publish every fanout-eligible
   * envelope and to subscribe one async iterator per WebSocket
   * subscriber — no in-process Map walk; the seam owns routing.
   */
  readonly streamFanout?: StreamFanout;
  /**
   * Optional bootstrap-auth plumbing. When present, the channel
   * accepts `SubscribePayload.wsToken` and issues reconnect
   * credentials in `AckPayload.sessionToken`. When absent, bootstrap
   * tokens are rejected with `BOOTSTRAP_NOT_SUPPORTED`.
   */
  readonly bootstrap?: GguiSessionChannelBootstrap;

  /**
   * Optional console cookie-auth plumbing. When present, the
   * channel upgrade looks for the configured cookie on the incoming
   * request. A valid cookie binds the identity as a `builder` and
   * scopes the subscriber to the cookie's `sessionId` — any
   * `subscribe.sessionId` mismatch is rejected with
   * `DEVTOOL_COOKIE_SESSION_MISMATCH`.
   *
   * Absent = cookie auth disabled on this channel. Cookies are never
   * auto-enabled; the server's console composition decides.
   *
   * Design boundary: this auth plane is MUTUALLY EXCLUSIVE with
   * bootstrap auth at upgrade time. When both are configured, the
   * bootstrap path (via `?bootstrap=` query) wins; cookie is only
   * consulted for standard upgrades.
   */
  readonly cookieAuth?: GguiSessionChannelCookieAuth;
  /**
   * Reserved-channel payload validators for channels whose shape is
   * NOT protocol-owned (Item 4 injection pattern). The primary
   * consumer is `_ggui:preview` — the server composes a
   * {@link ReservedChannelValidator} adapting
   * `@ggui-ai/preview-a2ui::parseServerMessage` so malformed A2UI
   * frames emitted on the preview channel reject at the fan-out
   * boundary instead of landing in the subscriber's renderer.
   *
   * Lookup inside {@link validateStreamData} consults this map FIRST,
   * then the protocol-shipped `BUILTIN_RESERVED_VALIDATORS` (which
   * validates `_ggui:lifecycle`), then falls through to
   * `{valid: true}` when a known reserved channel has no validator.
   *
   * Absent = no `_ggui:preview` validation (documented degradation for
   * implementations without the preview package); `_ggui:lifecycle`
   * is always validated via the built-in.
   */
  readonly extraReservedValidators?: ReadonlyMap<string, ReservedChannelValidator>;
  /**
   * Optional {@link TelemetrySink} for live-channel operational
   * signals (C12) — operational counts + durations for OTLP /
   * CloudWatch / Datadog forwarders. Reserved seam: the channel
   * defines the binding point but emits no signals of its own today;
   * future operational counts (e.g. subscribe / poll failure rates)
   * bind here so operator sink wiring composes uniformly with the
   * server's `server.composed` signal.
   *
   * Deliberately separate from the renderer's client-side
   * `ObservabilityEvent` surface — two independent consumers (backend
   * metrics vs host inspector UI). See the TelemetrySink docstring
   * for the sync/lossy contract.
   */
  readonly telemetry?: TelemetrySink;
  /**
   * Opt-in `channel_subscribe` plumbing for `streamSpec[*].source.tool`
   * fan-out. When present, channel subscribes whose
   * `source.tool` is in `allowlist` are accepted and the server begins
   * polling. When absent, every `channel_subscribe` returns
   * `CHANNEL_NOT_LOCAL` so the iframe falls back to direct polling via
   * the MCP host proxy.
   *
   * Same `allowlist` MUST be advertised on
   * `handshake.serverCapabilities.streamWebSocketLocalTools` so iframe
   * + server agree on which channels use the WS fan-out path.
   */
  readonly streamWebSocketLocalTools?: GguiSessionChannelLocalToolsOptions;
  /**
   * Protocol-version handshake policy. Governs server behavior when a
   * subscribe declares a `supportedVersions` list that does NOT
   * contain this server's {@link PROTOCOL_SCHEMA_VERSION}.
   *
   *   - `'reject'` (default): server emits
   *     `{type:'error', payload.code: 'UPGRADE_REQUIRED'}` AND closes
   *     the underlying WebSocket. The caller cannot accidentally
   *     proceed against a version-mismatched render. This is the
   *     canonical posture for first-party servers.
   *   - `'advisory'` (opt-out): server emits `UPGRADE_REQUIRED`
   *     but keeps the connection open — the subscribe stops (no ack,
   *     no snapshot, no replay). Existing clients that ignore the error
   *     code continue to interoperate exactly as pre-handshake.
   *     Use only for controlled migration windows during which
   *     legacy-version clients must remain attached.
   *
   * Absent `payload.supportedVersions` always passes through — the
   * handshake is fully opt-in on the client side. `serverVersion` is
   * stamped into every successful ack regardless of policy.
   *
   * Switching between `'advisory'` and `'reject'` is a config change,
   * not a schema change — the wire fields and error code ship
   * identically in both modes.
   */
  readonly versionPolicy?: "advisory" | "reject";
  /**
   * Optional hook fired synchronously when the local subscriber count
   * for `sessionId` transitions 0 → 1 (the first subscriber for that
   * render connects to this server instance).
   *
   * Hosted deployments use this to lazily SUBSCRIBE to the per-render
   * cross-pod broadcast channel (e.g. Redis pub/sub); OSS has no use
   * for it (in-process broadcasts already route via
   * {@link GguiSessionChannelServer.sendPropsUpdate}). Bounding pubsub
   * fan-in to only renders a pod actually holds connections for is a
   * correctness requirement, not an optimization — without it every
   * pod receives every other pod's broadcast for every active render.
   *
   * Best-effort: a thrown callback is logged and swallowed.
   * `register()` MUST NOT fail because of a hook error or the
   * `wsSubscribers` set would drift out of sync with the real socket
   * lifecycle.
   *
   * Concurrent register/unregister for the same sessionId are serialized
   * by the channel's single-threaded WS event loop; hook implementations
   * do not need their own mutex for the 0↔1 transition.
   */
  readonly onFirstSubscriber?: (sessionId: string) => void;
  /**
   * Optional hook fired synchronously when the local subscriber count
   * for `sessionId` transitions 1 → 0 (the last subscriber for that
   * render disconnects).
   *
   * Symmetric with {@link onFirstSubscriber}; same best-effort posture
   * and single-threaded serialization guarantee.
   */
  readonly onLastSubscriberGone?: (sessionId: string) => void;
}

export interface GguiSessionChannelServer {
  /** The URL path the channel accepts upgrade requests on. */
  readonly path: string;
  /**
   * Wire this into the HTTP server's `upgrade` event. Rejects with 401
   * on auth failure; otherwise completes the WS handshake and wires
   * the subscriber.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * Deliver a stream envelope to every subscriber of `delivery.sessionId`.
   *
   * Outbound fan-out enforcement point — the delivery's `payload` is
   * validated against the active render's streamSpec via
   * `assertStreamContract` before any subscriber receives it.
   *
   * Sequencing + replay behavior:
   *   1. Payload validated against the active render's streamSpec.
   *   2. The replay buffer assigns a render-scoped monotonic `seq` and
   *      (conditionally) stores the stamped envelope per the channel's
   *      replay policy (`'none'` skip / `'latest'` single-slot /
   *      `'all'` FIFO ring).
   *   3. The stamped envelope fans out to every subscriber for the
   *      render, skipping any whose initial replay already covered
   *      this seq (prevents double delivery on reconnect).
   *
   * The caller supplies `StreamEnvelopeInput` (no seq); the server
   * stamps. Returns the stamped `seq` for callers that need to thread
   * ordering back to their own response (e.g., `ggui_emit`'s wire
   * output). When the channel's replay policy was `'none'`, seq is
   * still assigned (so fan-out has a stable cursor) but nothing is
   * stored — the seq still surfaces here so the caller has the same
   * shape regardless of replay policy.
   *
   * Throws `ContractViolationError` on payload mismatch; transport
   * errors are logged but not propagated (per-subscriber best-effort).
   */
  sendToGguiSession(delivery: StreamEnvelopeInput): Promise<{ seq: number }>;
  /**
   * Fan a `{type:'render', payload:{render, matchType?}}` wire frame
   * to every subscriber currently bound to `sessionId`. Use this to
   * notify already-subscribed clients about a render-commit that
   * happened AFTER they subscribed — the initial `ack.render` snapshot
   * covers state at subscribe time only, so without an explicit notify
   * a second-turn `commit` is invisible to the live client.
   *
   * The `B1` regression context (2026-04-22 QA pass): the chat surface
   * in `/chat` reuses one render across turns. The first turn's render
   * subscribed AFTER `commit` ran, so the ack carried the
   * entry. The second turn's commit landed on the live render — the
   * subscriber never heard about the new entry, the inline UI slot
   * stayed in "Waiting for render channel replay…" indefinitely.
   * `notifyGguiSessionCommit` closes that gap. Best-effort: per-subscriber
   * send failures are swallowed (same posture as `sendToGguiSession`).
   *
   * NOT durable. Frames are not stamped through the replay buffer —
   * fresh subscribers still get the current render via `ack.render` on
   * subscribe. A new tab opening mid-render reads the latest render
   * from the snapshot; live tabs read the delta from this notify.
   *
   * Subscribers received via `register()` are tracked in
   * `subscribersByRender`; this helper iterates the bound set and
   * skips closed sockets via the `send()` helper's existing guard.
   * Callers ARE responsible for ordering — call after the underlying
   * `renderStore.commit` resolves so the snapshot a
   * concurrent fresh subscriber observes still includes the entry.
   */
  notifyGguiSessionCommit(sessionId: string, render: GguiSession, matchType?: string): void;
  /**
   * Fan a `{type:'props_update', payload:{sessionId, props}}` wire frame
   * to every subscriber currently bound to `sessionId`. The agent-driven
   * `ggui_update` handler calls this (wired as its `propsUpdateNotifier`)
   * so a props patch replaces renderer props in-place on live
   * subscribers without waiting for a resubscribe.
   *
   * Validation posture (mirrors `notifyGguiSessionCommit`'s "best-effort orphan
   * no-op"):
   *   1. Look up the render via `renderStore.get`. Absent → log
   *      `render_channel_props_update_orphan` and return — the wire
   *      validator on the renderer side would reject a frame for an
   *      unknown render anyway.
   *   2. Iterate the flat WS-subscriber set, filter to subscribers
   *      whose `sessionId` matches, and `send()` the frame. Closed
   *      sockets are skipped silently by `send()`.
   *
   * NOT routed through StreamFanout — `type: 'props_update'` is a
   * distinct WebSocket message type, not a stream envelope. Stream
   * envelopes flow on `data` frames and have a `seq` cursor; props
   * updates are ephemeral and follow `notifyGguiSessionCommit`'s pattern
   * (live-only, no replay-buffer stamping). A new subscriber that
   * connects mid-render reads current `props` from the render
   * snapshot delivered in `ack.render`.
   *
   * Schema validation against `propsSpec`: NOT enforced server-side
   * here. The `ggui_update` handler validates the patch against the
   * render's `propsSpec` BEFORE persisting and notifying, and the
   * renderer re-validates inbound props via
   * `validateInboundPropsPayload` against the cached
   * `render.propsSpec` before applying — defense-in-depth at the
   * receiving boundary.
   */
  sendPropsUpdate(sessionId: string, props: JsonObject): Promise<void>;
  /**
   * Fan a `{type:'drain_ack', payload:{sessionId, appId,
   * eventId, drainedAt}}` wire frame to every subscriber currently
   * bound to `sessionId`.
   *
   * Fired by `createGguiConsumeHandler` once per drained
   * `PendingEvent` so the iframe-runtime can cancel the matching
   * per-action 10s claim timer + resolve the toast as `consumed`.
   * Implements the `DrainAckNotifier` contract from
   * `@ggui-ai/mcp-server-handlers`.
   *
   * Same posture as `notifyGguiSessionCommit` / `sendPropsUpdate` — live-only,
   * no replay-buffer stamping. Subscribers that connect AFTER the
   * drain see the next consume's snapshot rather than the missed
   * frame; the iframe's claim timer + atomic-pop primitive backstop
   * any frame loss.
   */
  sendDrainAck(args: {
    readonly sessionId: string;
    readonly appId: string;
    readonly eventId: string;
    readonly drainedAt: string;
  }): void;
  /**
   * Fan a server-frame to every local WS subscriber bound to
   * `sessionId`. Skips replay-buffer stamping, GguiSessionStore lookups,
   * and contract validation — the caller is the one that originally
   * validated + persisted the underlying mutation. This surface is the
   * delivery path for already-validated frames that arrived via an
   * external pubsub layer (e.g. Redis from another process of a
   * multi-process deployment).
   *
   * Internal adapter use only. NOT part of the published ggui
   * protocol, NOT stable across versions, NOT exposed to MCP / wire
   * callers. The publisher is responsible for ensuring `frame` is
   * wire-valid; this method does not re-validate.
   *
   * No-op when no local subscriber is bound to `sessionId`. Closed
   * sockets are skipped silently by the underlying `send()` helper —
   * same posture as `sendPropsUpdate` / `notifyGguiSessionCommit`. Per-
   * subscriber send failures are logged but never propagated.
   */
  externalBroadcast(sessionId: string, frame: WebSocketMessage): void;
  /** Number of live subscribers. Useful for health / debug introspection. */
  readonly subscriberCount: number;
  /** Number of distinct renders with at least one subscriber. */
  readonly renderCount: number;
  /**
   * Close every live subscriber + the underlying ws server. Idempotent.
   */
  close(): Promise<void>;
}

/**
 * Build an OSS live-channel server. The returned object is designed to be
 * composed into `createGguiServer` — see `server.ts` for the wire-up.
 */
export function createGguiSessionChannelServer(
  opts: GguiSessionChannelOptions
): GguiSessionChannelServer {
  const path = opts.path ?? DEFAULT_RENDER_CHANNEL_PATH;
  // Outbound stream buffer — owns seq assignment + bounded replay
  // storage. Default is in-memory; operators swap via `opts.streamBuffer`.
  const streamBuffer: GguiSessionStreamBuffer =
    opts.streamBuffer ?? new InMemoryGguiSessionStreamBuffer();
  // Live-tail pub/sub. Default in-process; multi-process deployments
  // bind a pubsub-backed StreamFanout via `opts.streamFanout`.
  const streamFanout: StreamFanout = opts.streamFanout ?? new InProcessStreamFanout();
  // `noServer: true` means we own the upgrade wiring (see handleUpgrade);
  // ws won't try to bind its own port.
  const wss = new WebSocketServer({ noServer: true });

  /**
   * Flat set of all live WS subscribers. Replaces the per-render
   * `subscribersByRender` Map — routing is now StreamFanout's job;
   * this set tracks WS-specific bookkeeping (stats, shutdown-broadcast)
   * that the seam can't see (and shouldn't).
   */
  const wsSubscribers = new Set<Subscriber>();
  /** ws → subscriber reverse index so socket-close can look up cheaply. */
  const subscribersByWs = new WeakMap<WebSocket, Subscriber>();

  // Send / fan-out family — wire-write primitives shared by every
  // handler module plus the public fan-out surfaces the returned
  // object delegates to. See `ggui-session-channel/outbound.ts`.
  const outbound = createOutbound({
    logger: opts.logger,
    renderStore: opts.renderStore,
    streamBuffer,
    streamFanout,
    wsSubscribers,
    extraReservedValidators: opts.extraReservedValidators,
  });
  const { send, sendError, sendChannelError } = outbound;

  // Subscriber lifecycle family — registration, the live-tail pump
  // loop, and symmetric teardown. Owns the per-render counter behind
  // the onFirstSubscriber / onLastSubscriberGone hooks. See
  // `ggui-session-channel/subscriber-lifecycle.ts`.
  const { register, unregister } = createSubscriberLifecycle({
    logger: opts.logger,
    wsSubscribers,
    subscribersByWs,
    send,
    onFirstSubscriber: opts.onFirstSubscriber,
    onLastSubscriberGone: opts.onLastSubscriberGone,
  });

  // Channel-subscribe / source-poll family — `channel_subscribe`
  // validation + the server-side polling loops. Resolves the
  // streamWebSocketLocalTools allowlist + cadence once at composition.
  // See `ggui-session-channel/channel-subscriptions.ts`.
  const { handleChannelSubscribe, handleChannelUnsubscribe } = createChannelSubscriptions({
    logger: opts.logger,
    renderStore: opts.renderStore,
    localTools: opts.streamWebSocketLocalTools,
    subscribersByWs,
    send,
    sendChannelError,
  });

  // Action ingress + consume bridge — contract gate, ledger + pipe
  // dual-write, ack. See `ggui-session-channel/action-ingress.ts`.
  const { handleInboundAction } = createActionIngress({
    logger: opts.logger,
    renderStore: opts.renderStore,
    pendingEventConsumer: opts.pendingEventConsumer,
    send,
    sendError,
  });

  // Subscribe / credential-path family — upgrade-time identity
  // resolution (bearer / bootstrap / console cookie) + the
  // `subscribe` handler. See `ggui-session-channel/subscribe.ts`.
  const { resolveIdentityFromUpgrade, handleSubscribe } = createSubscribeHandlers({
    logger: opts.logger,
    auth: opts.auth,
    renderStore: opts.renderStore,
    streamBuffer,
    streamFanout,
    bootstrap: opts.bootstrap,
    cookieAuth: opts.cookieAuth,
    appIdFromIdentity: opts.appIdFromIdentity,
    versionPolicy: opts.versionPolicy,
    send,
    sendError,
    register,
  });

  // WS lifecycle / message routing — the `connection` handler with
  // the per-socket inbound ordering chain, pre-subscribe identity +
  // cookie bindings, and the type dispatcher routing frames to the
  // handler families above. See `ggui-session-channel/socket-router.ts`.
  attachSocketRouter(wss, {
    logger: opts.logger,
    renderStore: opts.renderStore,
    subscribersByWs,
    send,
    sendError,
    unregister,
    handleSubscribe,
    handleInboundAction,
    handleChannelSubscribe,
    handleChannelUnsubscribe,
  });

  return {
    path,
    handleUpgrade(req, socket, head) {
      resolveIdentityFromUpgrade(req)
        .then((identity) => {
          // Stash identity on the request so the 'connection' handler
          // can wire it onto the socket. This is the standard ws
          // per-request piggyback pattern.
          (req as IncomingMessage & UpgradeBindings).__gguiIdentity = identity;
          wss.handleUpgrade(req, socket, head, (ws) => {
            // Expose `upgradeReq` for the connection handler.
            wss.emit("connection", ws, req);
          });
        })
        .catch((err) => {
          if (err instanceof UnauthenticatedError) {
            opts.logger.warn("render_channel_auth_failed", {
              reason: err.message,
            });
            socket.write(
              "HTTP/1.1 401 Unauthorized\r\n" +
                "Connection: close\r\n" +
                "Content-Type: text/plain\r\n\r\n" +
                "Unauthorized: " +
                err.message +
                "\r\n"
            );
          } else {
            opts.logger.error("render_channel_upgrade_failed", {
              error: String(err),
            });
            socket.write("HTTP/1.1 500 Internal Server Error\r\n" + "Connection: close\r\n\r\n");
          }
          socket.destroy();
        });
    },
    // The five fan-out surfaces delegate to the outbound module —
    // contracts documented on the interface above, impl decisions in
    // `ggui-session-channel/outbound.ts`.
    sendToGguiSession: outbound.sendToGguiSession,
    notifyGguiSessionCommit: outbound.notifyGguiSessionCommit,
    sendPropsUpdate: outbound.sendPropsUpdate,
    sendDrainAck: outbound.sendDrainAck,
    externalBroadcast: outbound.externalBroadcast,
    get subscriberCount() {
      return wsSubscribers.size;
    },
    get renderCount() {
      // Distinct render count across live WS subscribers. With
      // multi-tab clients, two subscribers may share a sessionId —
      // dedupe before counting.
      const renders = new Set<string>();
      for (const sub of wsSubscribers) renders.add(sub.sessionId);
      return renders.size;
    },
    async close() {
      // Close every open socket + drain its StreamFanout subscription.
      // `wss.close` terminates the server but not in-flight sockets,
      // so walk them explicitly. Each `iter.return()` unregisters
      // the subscriber from the seam (idempotent on the in-process impl).
      //
      // Close code 1012 ("Service Restart", RFC 6455 + IANA registry)
      // signals to clients that the server is restarting and they
      // should reconnect immediately rather than treat the close as
      // permanent. The pod's K8s rolling update fits this exactly:
      // a new pod is already accepting connections behind the same
      // load balancer; iframe-runtime + console viewer should
      // reconnect on next message instead of blinking "disconnected".
      // Code 1001 (used previously) means "endpoint going away" with
      // no reconnect hint — semantically inaccurate for the pod-roll
      // case and the wrong signal for client reconnect logic.
      const sessionIds = new Set<string>();
      for (const sub of wsSubscribers) {
        sessionIds.add(sub.sessionId);
        try {
          sub.ws.close(1012, "service_restart");
        } catch {
          /* best-effort */
        }
        void sub.iter.return?.();
      }
      wsSubscribers.clear();
      // Defensive: also close any renders on the seam that no longer
      // have local WS subscribers (e.g. orphaned renders from a partial
      // unregister race). For InProcessStreamFanout this is a no-op
      // when there are no subscribers; for hosted bindings it ensures
      // the per-render pub/sub channel teardown fires.
      await Promise.all(
        Array.from(sessionIds, (sessionId) =>
          streamFanout.close(sessionId).catch(() => {
            /* best-effort */
          })
        )
      );
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
