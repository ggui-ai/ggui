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
 */

import type {
  AuthAdapter,
  AuthResult,
  BufferedStreamEnvelope,
  PendingEventConsumer,
  GguiSessionPatch,
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
import { assertActionContract, assertStreamContract } from "@ggui-ai/mcp-server-handlers/renders";
import type {
  AckPayload,
  ActionEnvelope,
  ConsumeEventEntry,
  ErrorPayload,
  JsonObject,
  GguiSession,
  ReservedChannelValidator,
  StreamSpec,
  SubscribePayload,
} from "@ggui-ai/protocol";
import {
  ContractViolationError,
  sanitizeCausedBy,
  PROTOCOL_SCHEMA_VERSION,
  UPGRADE_REQUIRED,
} from "@ggui-ai/protocol";
import type { WebSocketMessage } from "@ggui-ai/protocol/transport/websocket";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  defaultAppIdFromIdentity,
  resolveIdentityFromHeaders,
  UnauthenticatedError,
} from "./auth.js";
import type { Logger } from "./logger.js";

/** Default URL path for the channel endpoint. Operators can override. */
export const DEFAULT_RENDER_CHANNEL_PATH = "/ws";

/**
 * A single connected subscriber (one client, one render). Held live in
 * the per-channel subscriber map; torn down on socket close or explicit
 * `close` message.
 */
interface Subscriber {
  readonly ws: WebSocket;
  readonly sessionId: string;
  readonly appId: string;
  readonly identity: AuthResult;
  readonly connectedAt: number;
  /**
   * Largest outbound `seq` the initial replay (or subscribe snapshot)
   * covered for this subscriber. Live fan-out skips envelopes with
   * `seq <= replayCompletedSeq` to prevent double delivery — those
   * were (or will be) delivered via the replay phase.
   *
   * For fresh subscribers (no `fromSeq`), this is the stream cursor
   * at subscribe time; they never see the pre-existing buffer, only
   * new deliveries.
   */
  readonly replayCompletedSeq: number;
  /**
   * Per-subscriber live-tail iterator from `streamFanout.subscribe`.
   * Owned by the subscriber for its full lifetime; ending it (via
   * `iter.return()`) terminates the pump loop AND unregisters from
   * the StreamFanout. `unregister(ws)` is the single point that
   * does this teardown.
   */
  readonly iter: AsyncIterator<BufferedStreamEnvelope>;
  /**
   * Active `channel_subscribe` polling loops for this subscriber.
   * Keyed by `${sessionId}:${channelName}` so a reconnect that
   * re-subscribes to the same (render, channel) pair replaces the
   * existing timer rather than minting a duplicate (idempotent
   * semantics on the wire). Torn down en masse by `unregister(ws)` on
   * WS close.
   *
   * Populated by the `channel_subscribe` handler when the composing
   * host wired a `streamWebSocketLocalTools` allowlist; empty
   * otherwise.
   */
  readonly channelSubs: Map<string, ChannelSubscriptionState>;
}

/**
 * Per-(subscriber, sessionId, channelName) polling-loop state.
 * Created on `channel_subscribe` accept, torn down on `channel_unsubscribe`
 * / WS close / re-subscribe-replace.
 *
 * Server-side polling of `streamSpec[ch].source.tool` for the
 * subset of tools the operator listed on `streamWebSocketLocalTools`.
 * Channels whose `source.tool` isn't in the allowlist are rejected
 * with `CHANNEL_NOT_LOCAL` so the iframe falls back to direct polling
 * over the MCP host proxy.
 */
interface ChannelSubscriptionState {
  /** Server-clamped poll cadence in ms (within configured floor/ceiling). */
  readonly pollIntervalMs: number;
  /** Source tool name resolved from `streamSpec[channelName].source.tool`. */
  readonly toolName: string;
  /** GguiSession this subscription is bound to (for fan-out scoping). */
  readonly sessionId: string;
  /** Channel name (key into `streamSpec`). */
  readonly channelName: string;
  /**
   * Merged args used on each poll call. Layered as `{...source.args,
   * ...client.args}` so client wins on key collisions — matches the
   * docstring on `ChannelSubscribePayload.args`.
   */
  readonly args: JsonObject;
  /**
   * Channel-scoped monotonic counter stamped into every
   * `channel_payload` frame's `seq`. Starts at 1 and advances per
   * successful poll for client-side gap detection.
   */
  seq: number;
  /** Active `setInterval` handle — cleared on teardown. */
  readonly timer: ReturnType<typeof setInterval>;
}

/**
 * Default + boundary cadence for the channel-subscribe polling loop.
 * Server-authoritative: clients propose `pollIntervalMs` on
 * `channel_subscribe`, server clamps to [floorMs, ceilingMs] and
 * defaults to `defaultMs` when absent. Conservative defaults — operators
 * tune via {@link GguiSessionChannelLocalToolsOptions.pollCadence}.
 */
const DEFAULT_CHANNEL_POLL_FLOOR_MS = 1_000;
const DEFAULT_CHANNEL_POLL_CEILING_MS = 60_000;
const DEFAULT_CHANNEL_POLL_DEFAULT_MS = 10_000;

/**
 * Opt-in plumbing for the `channel_subscribe` polling loop. When this
 * field is set on {@link GguiSessionChannelOptions}, channel subscribes
 * whose `source.tool` is in {@link allowlist} are accepted and the
 * server begins polling. When absent, every `channel_subscribe`
 * returns `CHANNEL_NOT_LOCAL` so the iframe falls back to direct
 * polling via the MCP host proxy.
 */
export interface GguiSessionChannelLocalToolsOptions {
  /**
   * Whitelist of `source.tool` names this channel can poll. Must mirror
   * the value the host advertises on
   * `handshake.serverCapabilities.streamWebSocketLocalTools` so the
   * iframe + server agree on which channels use the WS fan-out path.
   * Tools NOT in this list are rejected with `CHANNEL_NOT_LOCAL` (the
   * iframe falls back to direct polling).
   */
  readonly allowlist: readonly string[];
  /**
   * Synchronous resolver invoked at poll time. Returns the tool's
   * structured output (validated against `streamSpec[ch].schema`
   * client-side; server-side schema validation is deferred to the
   * future `validateContract` slice). Implementations typically
   * delegate to the same in-process tool registry that backs `/mcp`.
   *
   * Throwing surfaces `POLL_FAILED` on the subscriber's
   * `channel_error` channel without canceling the poll loop —
   * transient tool failures are recoverable.
   */
  invoke(name: string, input: unknown): Promise<unknown>;
  /**
   * Optional poll cadence policy. `defaultMs` applies when the client
   * doesn't supply a `pollIntervalMs`; `floorMs`/`ceilingMs` clamp
   * client-supplied values. Defaults:
   * `{floorMs: 1000, ceilingMs: 60000, defaultMs: 10000}`.
   */
  readonly pollCadence?: {
    readonly floorMs?: number;
    readonly ceilingMs?: number;
    readonly defaultMs?: number;
  };
}

/**
 * Bootstrap-auth plumbing for the live-channel endpoint.
 *
 * The channel accepts a bootstrap credential on the `subscribe`
 * message (`SubscribePayload.wsToken`). When present:
 *
 *   1. `verify(token)` is called. Must return the bound
 *      `{sessionId, appId}` on success, or `null` on any failure
 *      (invalid sig, expired, wrong kind, replayed, etc.).
 *   2. The bound `sessionId` MUST match the one on the subscribe
 *      payload. Mismatches are rejected with a clean error.
 *   3. On success, the server mints a reconnect credential via
 *      `issueSessionToken(sessionId, appId)` and returns it in
 *      `AckPayload.sessionToken`. The iframe stores this for WS
 *      reconnects via the normal bearer path.
 *
 * Bootstrap auth is MUTUALLY EXCLUSIVE with the upstream `AuthAdapter`
 * bearer path at subscribe time — when a bootstrap token is present,
 * the identity resolved at the HTTP upgrade is IGNORED in favor of
 * the bootstrap-derived identity. This is intentional: MCP Apps
 * iframes don't have a long-lived bearer; the bootstrap IS the auth.
 */
/**
 * Verify failure shape — distinguished so the channel server can map
 * `'expired'` to `BOOTSTRAP_EXPIRED` (client SHOULD refresh) vs
 * `'invalid'` to `BOOTSTRAP_INVALID` (client MUST re-handshake).
 *
 * G14 (2026-05-23): bootstrap envelopes are no longer single-use. A
 * signature-valid + unexpired token authenticates EVERY subscribe
 * within the TTL window; transient WS drops reconnect without a fresh
 * handshake. Past expiry, the iframe MAY refresh via the
 * {@link refresh} surface; past the refresh window, fresh handshake.
 */
export type GguiSessionChannelBootstrapVerifyResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly appId: string;
    }
  | { readonly ok: false; readonly reason: "expired" | "invalid" };

/**
 * Result of {@link GguiSessionChannelBootstrap.refresh}.
 *
 *   - `ok: true`: caller swaps the old envelope for `token` and resumes.
 *   - `ok: false`: caller MUST re-handshake (refresh window closed,
 *     tampered envelope, etc.).
 */
export type GguiSessionChannelBootstrapRefreshResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt: string;
    }
  | { readonly ok: false; readonly reason: "window_closed" | "invalid" };

export interface GguiSessionChannelBootstrap {
  /**
   * Verify a `SubscribePayload.wsToken` token.
   *
   * Returns the bound identity on success, or a discriminated failure.
   * The channel server maps `'expired'` to `BOOTSTRAP_EXPIRED` so the
   * iframe can branch on refresh-vs-rehandshake, and `'invalid'` to
   * `BOOTSTRAP_INVALID` for tamper / format / kind failures (no
   * refresh on those).
   */
  verify(token: string): GguiSessionChannelBootstrapVerifyResult;
  /**
   * Mint a longer-lived reconnect credential to return in
   * `AckPayload.sessionToken`. Called only after a successful
   * `verify()` on a bootstrap subscribe.
   */
  issueSessionToken(sessionId: string, appId: string): string;
  /**
   * Refresh a (possibly-expired-but-signature-valid) bootstrap envelope
   * into a new envelope with a fresh TTL. Used by the
   * `ggui_runtime_refresh_ws_token` MCP tool — iframes that see their
   * bootstrap drift out of the TTL window swap in the refreshed
   * envelope without going back through `ggui_render`.
   *
   * Stateless: verifies HMAC against the same secret used at mint,
   * checks the refresh window against the ORIGINAL `iat`, and mints
   * a fresh bootstrap envelope bound to the SAME `(sessionId, appId)`.
   * Past the refresh window the result is `{ok:false, reason:
   * 'window_closed'}`; tampered envelopes are `{ok:false, reason:
   * 'invalid'}`.
   */
  refresh(token: string): GguiSessionChannelBootstrapRefreshResult;
}

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

/**
 * Cookie-based authentication for the live-channel upgrade. Used
 * exclusively by the same-origin console viewer; see
 * `console-auth.ts` for the single consumer today.
 */
export interface GguiSessionChannelCookieAuth {
  /**
   * Read the raw cookie value for THIS server's console cookie
   * from the incoming request headers. Returns `null` when the
   * cookie is absent or malformed.
   */
  readCookie(headers: import("node:http").IncomingHttpHeaders): string | null;
  /**
   * Verify a cookie value and return the bound render/app. Returns
   * `null` on any failure (signature, expiry, wrong kind). Never
   * throws.
   */
  verify(cookieValue: string): { sessionId: string; appId: string } | null;
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
export function createGguiSessionChannelServer(opts: GguiSessionChannelOptions): GguiSessionChannelServer {
  const path = opts.path ?? DEFAULT_RENDER_CHANNEL_PATH;
  // Outbound stream buffer — owns seq assignment + bounded replay
  // storage. Default is in-memory; operators swap via `opts.streamBuffer`.
  const streamBuffer: GguiSessionStreamBuffer = opts.streamBuffer ?? new InMemoryGguiSessionStreamBuffer();
  // Live-tail pub/sub. Default in-process; multi-process deployments
  // bind a pubsub-backed StreamFanout via `opts.streamFanout`.
  const streamFanout: StreamFanout = opts.streamFanout ?? new InProcessStreamFanout();
  // Channel-subscribe local-tool poll plumbing. Resolved once
  // at composition so the `channel_subscribe` handler doesn't pay the
  // option-spread cost per request. Absent ⇒ all channel subscribes
  // reject with `CHANNEL_NOT_LOCAL`.
  const localTools: GguiSessionChannelLocalToolsOptions | undefined = opts.streamWebSocketLocalTools;
  const localToolsAllowlist: ReadonlySet<string> = localTools
    ? new Set(localTools.allowlist)
    : new Set();
  const pollFloorMs = localTools?.pollCadence?.floorMs ?? DEFAULT_CHANNEL_POLL_FLOOR_MS;
  const pollCeilingMs = localTools?.pollCadence?.ceilingMs ?? DEFAULT_CHANNEL_POLL_CEILING_MS;
  const pollDefaultMs = localTools?.pollCadence?.defaultMs ?? DEFAULT_CHANNEL_POLL_DEFAULT_MS;

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
  /**
   * Per-render local subscriber count. Drives the {@link
   * GguiSessionChannelOptions.onFirstSubscriber} / `onLastSubscriberGone`
   * 0↔1 transition hooks multi-process deployments use for per-render
   * cross-process pub/sub channel scoping. Distinct from the
   * `renderCount` getter — that walks `wsSubscribers` on demand;
   * this map is the registration-time counter the hooks key off.
   */
  const renderCountById = new Map<string, number>();

  /**
   * Pump live frames from the StreamFanout iterator out to this
   * subscriber's WS. Started fire-and-forget by `register`; ends when
   * the iterator yields done (close() on the seam) OR `unregister`
   * calls `iter.return()`. Per-subscriber seq filter applied here:
   * frames with `seq <= replayCompletedSeq` were (or will be)
   * delivered via the replay path on subscribe.
   *
   * The pump's first action is `await iter.next()`, which yields
   * control back to the event loop. This is what preserves the
   * subscribe-handler ordering invariant: ack → replay frames →
   * live frames. The replay-frame send loop completes synchronously
   * before the pump can ever send anything, regardless of fanout
   * timing.
   */
  async function pumpSubscriber(sub: Subscriber): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await sub.iter.next();
        if (done) return;
        if (value.seq <= sub.replayCompletedSeq) continue;
        if (sub.ws.readyState !== sub.ws.OPEN) {
          await sub.iter.return?.();
          return;
        }
        send(sub.ws, { type: "data", payload: value });
      }
    } catch (err) {
      opts.logger.warn("render_channel_pump_failed", {
        sessionId: sub.sessionId,
        error: String(err),
      });
    }
  }

  function register(sub: Subscriber): void {
    wsSubscribers.add(sub);
    subscribersByWs.set(sub.ws, sub);
    // Per-render count bookkeeping + 0→1 hook for cloud pubsub
    // adapter scoping. Increment FIRST so the hook sees the up-to-date
    // state; hook fires only on the transition (prevCount === 0).
    const prevCount = renderCountById.get(sub.sessionId) ?? 0;
    renderCountById.set(sub.sessionId, prevCount + 1);
    if (prevCount === 0 && opts.onFirstSubscriber) {
      try {
        opts.onFirstSubscriber(sub.sessionId);
      } catch (err) {
        // Best-effort: a thrown hook MUST NOT corrupt the
        // wsSubscribers set vs the real socket lifecycle.
        opts.logger.warn("render_channel_on_first_subscriber_threw", {
          sessionId: sub.sessionId,
          error: String(err),
        });
      }
    }
    // Start the pump loop. Fire-and-forget — pump errors are logged
    // inside pumpSubscriber, never propagated.
    void pumpSubscriber(sub);
  }

  function unregister(ws: WebSocket): void {
    const sub = subscribersByWs.get(ws);
    if (!sub) return;
    subscribersByWs.delete(ws);
    wsSubscribers.delete(sub);
    // Per-render count bookkeeping + 1→0 hook (symmetric with register).
    const prevCount = renderCountById.get(sub.sessionId) ?? 0;
    if (prevCount <= 1) {
      renderCountById.delete(sub.sessionId);
      if (prevCount === 1 && opts.onLastSubscriberGone) {
        try {
          opts.onLastSubscriberGone(sub.sessionId);
        } catch (err) {
          opts.logger.warn("render_channel_on_last_subscriber_gone_threw", {
            sessionId: sub.sessionId,
            error: String(err),
          });
        }
      }
    } else {
      renderCountById.set(sub.sessionId, prevCount - 1);
    }
    // Ending the iter terminates pumpSubscriber AND unregisters this
    // subscriber from the StreamFanout. Idempotent on the seam side
    // (close-after-return is a no-op).
    void sub.iter.return?.();
    // Tear down every `channel_subscribe` polling loop owned
    // by this subscriber. Symmetric with stream-iterator teardown
    // above. clearInterval is idempotent on already-cleared handles,
    // so a concurrent channel_unsubscribe + WS close is safe.
    for (const state of sub.channelSubs.values()) {
      clearInterval(state.timer);
    }
    sub.channelSubs.clear();
  }

  function send(ws: WebSocket, msg: WebSocketMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      opts.logger.warn("render_channel_send_failed", { error: String(err) });
    }
  }

  function sendError(
    ws: WebSocket,
    code: string,
    message: string,
    requestId?: string,
    details?: ErrorPayload["details"]
  ): void {
    send(ws, {
      type: "error",
      payload: { code, message, ...(details !== undefined ? { details } : {}) },
      ...(requestId ? { requestId } : {}),
    });
  }

  /**
   * Tenancy guard for client-emitted observation messages
   * (`host_context_observed` today). Returns `false`
   * AND emits the appropriate error frame when:
   *
   *   - the socket has no bound subscriber (NOT_SUBSCRIBED)
   *   - payload.sessionId doesn't match the subscriber binding
   *     (SESSION_MISMATCH)
   *
   * Subscriber binding is the authoritative tenancy scope. The wire
   * payload's sessionId is belt-and-suspenders so the error message
   * can be specific; appId narrows transparently via the binding.
   */
  function checkSubscriberTenancy(
    ws: WebSocket,
    sub: Subscriber | undefined,
    payload: { readonly sessionId?: string },
    messageType: string,
    requestId?: string
  ): sub is Subscriber {
    if (!sub) {
      sendError(
        ws,
        "NOT_SUBSCRIBED",
        `Send a 'subscribe' message first before '${messageType}'`,
        requestId
      );
      return false;
    }
    if (payload.sessionId !== sub.sessionId) {
      sendError(
        ws,
        "SESSION_MISMATCH",
        `${messageType} payload id '${payload.sessionId ?? "<missing>"}' does not match subscriber render '${sub.sessionId}'`,
        requestId
      );
      return false;
    }
    return true;
  }

  /**
   * Persist an observation-message-driven render patch. Fire-and-
   * forget at the wire layer (no response frame); warn-logs persistence
   * errors so transient store failures stay observable without
   * disrupting the iframe. The iframe's local state is already in the
   * new shape; the next round-trip re-emits whatever the persistence
   * layer lost.
   */
  async function applyGguiSessionPatch(
    sessionId: string,
    appId: string,
    messageType: string,
    patch: GguiSessionPatch
  ): Promise<void> {
    try {
      await opts.renderStore.update(sessionId, patch);
    } catch (err) {
      opts.logger.warn("render_channel_observation_persist_failed", {
        messageType,
        sessionId,
        appId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Emit a `channel_error` frame to a specific subscriber. Used by the
   * `channel_subscribe` handler for both subscribe-time rejections
   * (`CHANNEL_UNKNOWN`, `CHANNEL_NOT_LOCAL`, `SESSION_NOT_FOUND`,
   * `SUBSCRIBE_UNAUTHORIZED`) AND poll-time failures (`POLL_FAILED`).
   *
   * Direct-to-WS, not via fanOut — channel_error frames are
   * per-subscriber and not stored in the replay buffer. A new
   * subscriber on the same render will re-subscribe and discover the
   * same error itself.
   */
  function sendChannelError(
    ws: WebSocket,
    sessionId: string,
    channelName: string,
    code:
      | "CHANNEL_UNKNOWN"
      | "CHANNEL_NOT_LOCAL"
      | "SESSION_NOT_FOUND"
      | "SUBSCRIBE_UNAUTHORIZED"
      | "POLL_FAILED",
    message: string,
    requestId?: string,
    details?: ErrorPayload["details"]
  ): void {
    send(ws, {
      type: "channel_error",
      payload: {
        sessionId,
        channelName,
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
      ...(requestId ? { requestId } : {}),
    });
  }

  /**
   * Clamp a client-supplied `pollIntervalMs` against the configured
   * floor / ceiling. Absent (or non-finite) ⇒ default. Server is
   * authoritative per the `ChannelSubscribePayload.pollIntervalMs`
   * docstring — clients propose, server clamps.
   */
  function clampPollInterval(supplied: number | undefined): number {
    if (typeof supplied !== "number" || !Number.isFinite(supplied)) {
      return pollDefaultMs;
    }
    if (supplied < pollFloorMs) return pollFloorMs;
    if (supplied > pollCeilingMs) return pollCeilingMs;
    return supplied;
  }

  /**
   * Run one poll of `state.toolName` and fan its result onto the
   * subscriber's WS as a `channel_payload`. Throws never escape — a
   * thrown invocation surfaces as a `channel_error{code:'POLL_FAILED'}`
   * but the polling loop keeps running so transient tool failures are
   * recoverable.
   *
   * Tool registry is guaranteed-present by the caller — channel
   * subscribes whose `source.tool` isn't in `localTools.allowlist`
   * never reach this function.
   */
  async function pollChannelOnce(sub: Subscriber, state: ChannelSubscriptionState): Promise<void> {
    if (!localTools) return;
    if (sub.ws.readyState !== sub.ws.OPEN) return;
    try {
      const output = await localTools.invoke(state.toolName, state.args);
      // Skip emission if the socket closed during the poll — closing-
      // raced timers fire at most once, and emitting onto a closing
      // socket is a `send_failed` warning at best.
      if (sub.ws.readyState !== sub.ws.OPEN) return;
      state.seq += 1;
      send(sub.ws, {
        type: "channel_payload",
        payload: {
          sessionId: sub.sessionId,
          appId: sub.appId,
          channelName: state.channelName,
          seq: state.seq,
          ts: new Date().toISOString(),
          // Default mode for source-fed channels is `replace` — each
          // poll is a fresh snapshot, not a delta. Channels that need
          // append semantics declare `mode: 'append'` on streamSpec;
          // honoring that is the iframe-runtime's concern at fold
          // time. See `ChannelPayloadFrame.mode`.
          mode: "replace",
          payload: output as JsonObject,
        },
      });
    } catch (err) {
      if (sub.ws.readyState !== sub.ws.OPEN) return;
      sendChannelError(
        sub.ws,
        sub.sessionId,
        state.channelName,
        "POLL_FAILED",
        err instanceof Error ? err.message : String(err),
        undefined,
        // causedBy slot — the raw stack is redacted (Bearer tokens,
        // query-param secrets, env-var dumps, 2 KB truncation) before
        // it reaches the wire; raw `err.stack` verbatim is a
        // credential-leak footgun.
        sanitizeCausedBy(err instanceof Error ? (err.stack ?? err.message) : String(err))
      );
      opts.logger.warn("render_channel_channel_poll_failed", {
        sessionId: sub.sessionId,
        appId: sub.appId,
        channelName: state.channelName,
        toolName: state.toolName,
        error: String(err),
      });
    }
  }

  /**
   * Handle a `channel_subscribe` message. Validates the request,
   * resolves the channel's `source.tool` against the configured
   * allowlist, and schedules a polling loop. Idempotent on
   * `${sessionId}:${channelName}` — a re-subscribe replaces any
   * existing interval rather than running two in parallel.
   */
  async function handleChannelSubscribe(
    ws: WebSocket,
    sub: Subscriber,
    message: WebSocketMessage & { type: "channel_subscribe" }
  ): Promise<void> {
    const payload = message.payload;
    // sessionId match — the spoof guard at every wire-input boundary.
    // A subscriber bound to render A can't drive a subscribe for
    // render B even if they crafted the inbound payload.
    if (payload.sessionId !== sub.sessionId) {
      sendChannelError(
        ws,
        payload.sessionId,
        payload.channelName,
        "SUBSCRIBE_UNAUTHORIZED",
        `Subscriber is bound to render '${sub.sessionId}' but channel_subscribe targets '${payload.sessionId}'`,
        message.requestId
      );
      return;
    }
    // Without an `streamWebSocketLocalTools` allowlist, no channel
    // can be subscribed locally. The iframe must fall back to direct
    // polling via the MCP host proxy.
    if (!localTools) {
      sendChannelError(
        ws,
        payload.sessionId,
        payload.channelName,
        "CHANNEL_NOT_LOCAL",
        "This server has no streamWebSocketLocalTools allowlist; iframe must poll the source tool directly.",
        message.requestId
      );
      return;
    }

    // Phase B: a render IS the addressable unit. The prior
    // reverse-index lookup collapses — `renderStore.get` resolves
    // the render directly.
    const stored = await opts.renderStore.get(payload.sessionId);
    if (!stored || stored.id !== sub.sessionId) {
      sendChannelError(
        ws,
        payload.sessionId,
        payload.channelName,
        "SESSION_NOT_FOUND",
        `GguiSession '${payload.sessionId}' not found on subscriber '${sub.sessionId}'`,
        message.requestId
      );
      return;
    }
    const render = stored.render;
    // Channel entry resolution. mcpApps / system variants have no
    // streamSpec so the field reads back as undefined — same code
    // path as a component variant without the channel declared.
    const streamSpec: StreamSpec | undefined =
      render.type === "mcpApps" || render.type === "system"
        ? undefined
        : render.streamSpec;
    const channelEntry = streamSpec?.[payload.channelName];
    if (!channelEntry || !channelEntry.source) {
      sendChannelError(
        ws,
        payload.sessionId,
        payload.channelName,
        "CHANNEL_UNKNOWN",
        `streamSpec['${payload.channelName}'] not declared OR has no source.tool on render '${payload.sessionId}'`,
        message.requestId
      );
      return;
    }
    const sourceTool = channelEntry.source.tool;
    if (!localToolsAllowlist.has(sourceTool)) {
      sendChannelError(
        ws,
        payload.sessionId,
        payload.channelName,
        "CHANNEL_NOT_LOCAL",
        `source.tool '${sourceTool}' is not in streamWebSocketLocalTools; iframe must poll directly`,
        message.requestId
      );
      return;
    }

    // Validation passed — schedule (or re-schedule) the polling loop.
    const channelKey = `${payload.sessionId}:${payload.channelName}`;
    // Idempotent replace: a reconnect that re-subscribes the same
    // (render, channel) pair gets a fresh timer + zeroed seq. The
    // client's gap-detection treats it as a new stream from the
    // server's perspective; client-side reconnect logic owns
    // continuity if the channel was declared `mode: 'append'`.
    const existing = sub.channelSubs.get(channelKey);
    if (existing) {
      clearInterval(existing.timer);
      sub.channelSubs.delete(channelKey);
    }

    const pollIntervalMs = clampPollInterval(payload.pollIntervalMs);
    // Layered args: source.args defines defaults; client args override
    // per ChannelSubscribePayload.args docstring.
    const mergedArgs: JsonObject = {
      ...(channelEntry.source.args ?? {}),
      ...(payload.args ?? {}),
    };

    // Resolve the channelKey lookup at callback fire-time. The
    // timer callback reads `sub.channelSubs.get(channelKey)` so
    // `state` doesn't have to be referenced through a closure
    // before it's actually inserted into the tracker. Also self-
    // cleans on the zombie-timer path: if the subscription was
    // already torn down (channel_unsubscribe / WS close / replace),
    // the lookup returns undefined and we clearInterval ourselves.
    const timer = setInterval(() => {
      const live = sub.channelSubs.get(channelKey);
      if (!live || !subscribersByWs.has(sub.ws)) {
        clearInterval(timer);
        return;
      }
      void pollChannelOnce(sub, live);
    }, pollIntervalMs);

    const state: ChannelSubscriptionState = {
      pollIntervalMs,
      toolName: sourceTool,
      sessionId: payload.sessionId,
      channelName: payload.channelName,
      args: mergedArgs,
      seq: 0,
      timer,
    };
    sub.channelSubs.set(channelKey, state);
    opts.logger.info("render_channel_channel_subscribe", {
      sessionId: sub.sessionId,
      appId: sub.appId,
      channelName: payload.channelName,
      toolName: sourceTool,
      pollIntervalMs,
    });
    // Eager-poll — fire one invocation immediately so the iframe sees
    // an initial value without waiting `pollIntervalMs`. Matches the
    // user-expected "subscribe then see data" cadence; the interval
    // takes over from there.
    void pollChannelOnce(sub, state);
  }

  /**
   * Handle a `channel_unsubscribe` message. Idempotent: a no-op
   * unsubscribe on an unknown channelKey returns silently. WS close
   * implicitly unsubscribes every channel; this message is for
   * mid-session cancellation.
   */
  function handleChannelUnsubscribe(
    _ws: WebSocket,
    sub: Subscriber,
    message: WebSocketMessage & { type: "channel_unsubscribe" }
  ): void {
    const payload = message.payload;
    if (payload.sessionId !== sub.sessionId) {
      // No-op silently — the canonical "spoof guard" code path is in
      // channel_subscribe; unsubscribe gets no error frame to avoid
      // leaking cross-render existence.
      return;
    }
    const channelKey = `${payload.sessionId}:${payload.channelName}`;
    const existing = sub.channelSubs.get(channelKey);
    if (!existing) return;
    clearInterval(existing.timer);
    sub.channelSubs.delete(channelKey);
    opts.logger.info("render_channel_channel_unsubscribe", {
      sessionId: sub.sessionId,
      appId: sub.appId,
      channelName: payload.channelName,
    });
  }

  /**
   * Stamp a delivery through the replay buffer and fan it out to every
   * subscriber of the render, honoring the per-subscriber replay
   * cursor. Backs the public `sendToGguiSession` entry point.
   *
   * Caller is responsible for validating `delivery.payload` against
   * the active streamSpec BEFORE calling — the fan-out here trusts
   * its input. Reserved-channel deliveries (e.g. `_ggui:lifecycle`)
   * bypass the streamSpec check upstream via
   * `assertStreamContract`.
   */
  async function fanOut(
    delivery: StreamEnvelopeInput,
    activeStreamSpec: StreamSpec | undefined
  ): Promise<{ seq: number }> {
    const { envelope } = await streamBuffer.record(delivery, activeStreamSpec);
    // Publish to the seam — InProcessStreamFanout walks its subscriber
    // queues synchronously inside publish(), so no real async hop. The
    // pump loop on each WS subscriber yields the envelope, applies the
    // per-sub replay-cursor filter, and sends to the WS. Fire-and-forget
    // because publish() never throws on the in-process impl, and an
    // external pubsub-fanout failure here would already be persisted to
    // the GguiSessionStreamBuffer for replay-recovery on reconnect.
    void streamFanout.publish({ sessionId: envelope.sessionId, envelope });
    return { seq: envelope.seq };
  }

  /**
   * Internal impl behind the public {@link GguiSessionChannelServer.sendPropsUpdate}.
   * Closure-level so it can be referenced without forward-referencing
   * the returned object. Best-effort + orphan-tolerant per the
   * docstring on the public method.
   */
  async function sendPropsUpdateImpl(sessionId: string, props: JsonObject): Promise<void> {
    let stored;
    try {
      stored = await opts.renderStore.get(sessionId);
    } catch (err) {
      opts.logger.warn("render_channel_props_update_lookup_failed", {
        sessionId,
        error: String(err),
      });
      return;
    }
    if (!stored) {
      opts.logger.warn("render_channel_props_update_orphan", {
        sessionId,
      });
      return;
    }
    // Filter the flat WS-subscriber set by sessionId; same posture as
    // `notifyGguiSessionCommit`. `send()` already silently skips closed sockets
    // and logs (but doesn't throw on) per-subscriber send failures, so
    // the calling handler can't be made to fail by a dead WebSocket.
    for (const sub of wsSubscribers) {
      if (sub.sessionId !== sessionId) continue;
      send(sub.ws, {
        type: "props_update",
        payload: { sessionId, props },
      });
    }
  }

  async function resolveIdentityFromUpgrade(req: IncomingMessage): Promise<AuthResult> {
    const url = new URL(req.url ?? "/", "http://localhost");

    // WS-token gate: when `?wsToken=` is present AND the channel is
    // configured with ws-token-auth plumbing, skip the AuthAdapter
    // entirely at upgrade. The real identity is established in
    // handleSubscribe when the subscribe payload's `wsToken` is
    // verified. This is how MCP Apps iframes connect — they can't set
    // Authorization headers, and the token model is subscribe-scoped
    // anyway.
    //
    // URL-gate here is NOT verification — it's a "don't reject the
    // upgrade for missing bearer" signal. The real verify runs at
    // subscribe time; an invalid token reaches that point and is
    // rejected with BOOTSTRAP_INVALID.
    if (opts.bootstrap && url.searchParams.has("wsToken")) {
      return {
        identity: {
          kind: "user",
          userId: "__bootstrap_pending__",
          workspaceId: "__bootstrap_pending__",
          roles: [],
        },
        source: "apikey",
      };
    }

    // Embedded-ui cookie gate. Consulted ONLY when the channel is
    // configured with cookie-auth plumbing AND no bootstrap is in
    // play. Unlike bootstrap, cookies ARE verified here: the single
    // consumer (console SPA) sets the cookie out-of-band via
    // `POST /ggui/console/session-cookie` and we do want to
    // reject the upgrade cleanly (HTTP 401 → browser WS error) when
    // the cookie is stale/missing, not carry a doomed handshake into
    // subscribe where the error surface is worse.
    //
    // On success, we stash the bound `{sessionId, appId}` on the
    // request so `handleSubscribe` can enforce that the subscribe
    // payload targets exactly those values. No synthesis from the
    // AuthAdapter — cookies ARE the auth signal.
    if (opts.cookieAuth) {
      const raw = opts.cookieAuth.readCookie(req.headers);
      if (raw) {
        const bound = opts.cookieAuth.verify(raw);
        if (bound) {
          (
            req as IncomingMessage & {
              __gguiCookieBound?: { sessionId: string; appId: string };
            }
          ).__gguiCookieBound = bound;
          return {
            identity: { kind: "builder" },
            source: "apikey",
          };
        }
        // Cookie present but invalid — do NOT fall through to the
        // bearer path. An invalid cookie is a same-origin user error,
        // not a pass-through condition.
        throw new UnauthenticatedError("console cookie invalid");
      }
      // No cookie present → fall through to bearer path below. Mixed
      // deployments (pairing-token bearer + same-origin cookie for
      // viewer) are legal.
    }

    // Browsers can't set Authorization on native WebSocket. Fall back
    // to `?token=<jwt>` for web clients, matching the convention most
    // render-channel endpoints ship with. Server-side clients (Node
    // `ws`, tests) continue to set the header directly.
    if (!req.headers["authorization"]) {
      const token = url.searchParams.get("token");
      if (token) {
        req.headers["authorization"] = `Bearer ${token}`;
      }
    }
    return resolveIdentityFromHeaders(
      opts.auth,
      req.headers,
      req.socket?.remoteAddress ?? undefined
    );
  }

  /**
   * Resolve the active render variant for contract enforcement. Phase
   * B collapsed the prior (stack, currentStackIndex) lookup — a render
   * IS the addressable unit, so the active render is the stored render
   * itself. MCP Apps / system variants narrow to `undefined` so
   * upstream enforcement skips (allowlist + actionSpec checks are
   * no-ops when no `ComponentGguiSession` is active).
   */
  function resolveActiveGguiSession(render: GguiSession | undefined): GguiSession | undefined {
    if (!render) return undefined;
    if (render.type === "mcpApps" || render.type === "system") return undefined;
    return render;
  }

  /**
   * Stamp the `tool` hint onto a `data:submit` envelope's
   * `ActionEventValue` payload before it persists onto the retained
   * event ledger (`user.submitted`).
   *
   * The hint derives server-side from the active render's
   * `actionSpec[action].nextStep` — the single authoritative source —
   * and only fills the gap when the inbound payload carries no `tool`
   * of its own. It rides the LEDGER copy only (operator surfaces —
   * console timeline, inspector feeds — read it); the consume-pipe
   * entry is the relay-identical {@link ConsumeEventEntry}, which
   * carries no tool slot — the agent reads `nextStep` from the
   * contract it authored.
   *
   * Pass-through (returns the envelope unchanged) when:
   *   - the envelope is not `data:submit`,
   *   - no `ComponentGguiSession` is active (mcpApps / system),
   *   - the payload lacks a string `action` or already carries a
   *     non-empty `tool`,
   *   - the named action declares no `nextStep`.
   */
  function withDerivedToolHint(
    envelope: ActionEnvelope,
    activeItem: GguiSession | undefined
  ): ActionEnvelope {
    if (envelope.type !== "data:submit" || !activeItem) return envelope;
    if (activeItem.type === "mcpApps" || activeItem.type === "system") return envelope;
    const payload = envelope.payload;
    if (
      payload === null ||
      payload === undefined ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return envelope;
    }
    if (typeof payload.action !== "string" || payload.action.length === 0) return envelope;
    if (typeof payload.tool === "string" && payload.tool.length > 0) return envelope;
    const nextStep = activeItem.actionSpec?.[payload.action]?.nextStep;
    if (typeof nextStep !== "string" || nextStep.length === 0) return envelope;
    return { ...envelope, payload: { ...payload, tool: nextStep } };
  }

  /**
   * Project an accepted `data:submit` {@link ActionEnvelope} onto the
   * canonical {@link ConsumeEventEntry} shape the pending-events pipe
   * stores — the SAME shape `ggui_runtime_submit_action`'s dispatch
   * branch appends, so `ggui_consume` drains WS-originated gestures
   * and tools/call-relayed gestures identically.
   *
   * Field mapping:
   *   - `intent`     ← `payload.action` (the actionSpec key).
   *   - `actionData` ← `payload.data ?? null` (already validated by
   *     {@link assertActionContract} when a spec is declared).
   *   - `uiContext`  ← `{}` — WS clients don't mirror a contextSpec
   *     snapshot (that's the iframe-runtime observer's job); the empty
   *     object is the type's canonical "no slots mirrored" value.
   *   - `actionId`   ← server-minted 8-hex correlation id. The WS wire
   *     envelope carries none (only the iframe-runtime computes a
   *     gesture-side FNV-1a hash); minting here keeps the pipe entry's
   *     `drain_ack` keying well-formed.
   *   - `firedAt`    ← server clock — the WS envelope deliberately
   *     carries no client timestamp (see {@link ActionEnvelope}).
   *
   * Returns `null` when the payload lacks a non-empty string `action`
   * (possible only on spec-less renders, where the contract gate is
   * permissive) — there is no intent to key the entry on, so the
   * gesture stays ledger-only.
   */
  function toConsumeEventEntry(
    envelope: ActionEnvelope,
    sessionId: string
  ): ConsumeEventEntry | null {
    const payload = envelope.payload;
    if (
      payload === null ||
      payload === undefined ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return null;
    }
    const action = payload.action;
    if (typeof action !== "string" || action.length === 0) return null;
    return {
      type: "action",
      sessionId,
      intent: action,
      actionData: payload.data ?? null,
      uiContext: {},
      actionId: randomBytes(4).toString("hex"),
      firedAt: new Date().toISOString(),
    };
  }

  /**
   * Handle an inbound `action` message — the canonical flat
   * {@link ActionEnvelope} shape.
   *
   * Inbound actions are gated by {@link assertActionContract} only —
   * the actionSpec payload check for `data:submit` types. (The
   * pre-Phase-B `subscription.events` allowlist gate was deleted with
   * the session-stack collapse; per-render event policy needs a new
   * wire shape before any second gate can exist.)
   *
   * Accepted envelopes dual-write, mirroring the
   * `ggui_runtime_submit_action` relay's posture:
   *
   *   1. The retained event ledger (`renderStore.appendEvent`) — the
   *      ack's `seq` source; failure is the load-bearing
   *      `APPEND_FAILED` path.
   *   2. For `data:submit` only, the pending-events pipe
   *      ({@link GguiSessionChannelOptions.pendingEventConsumer}) — the
   *      queue `ggui_consume` drains, so the agent receives the gesture
   *      mid-turn. Pipe failure degrades to ledger-only with a warn;
   *      it never changes the ack.
   */
  async function handleInboundAction(
    ws: WebSocket,
    sub: Subscriber,
    message: WebSocketMessage & { type: "action" }
  ): Promise<void> {
    const envelope: ActionEnvelope = message.payload;

    // Spoof guard — envelope.sessionId is REQUIRED on the wire and
    // MUST match the subscriber's bound render.
    if (envelope.sessionId !== sub.sessionId) {
      sendError(
        ws,
        "SESSION_MISMATCH",
        `Action targets render '${envelope.sessionId}' but this socket is subscribed to '${sub.sessionId}'`,
        message.requestId
      );
      return;
    }

    const stored = await opts.renderStore.get(sub.sessionId);
    if (!stored) {
      sendError(
        ws,
        "SESSION_NOT_FOUND",
        `GguiSession ${sub.sessionId} no longer exists`,
        message.requestId
      );
      return;
    }

    // Phase B: a render IS the addressable unit. The prior stack
    // routing (stackIndex / cross-stack pickIds) collapses — the
    // resolved render itself is the active item.
    const activeItem = resolveActiveGguiSession(stored.render);

    // Contract enforcement: actionSpec payload check via
    // assertActionContract (data:submit only). Envelope.payload for
    // data:submit carries the ActionEventValue shape
    // (`{action, data?, tool?}`).
    if (envelope.type === "data:submit") {
      try {
        const activeActionSpec =
          activeItem && activeItem.type !== "mcpApps" && activeItem.type !== "system"
            ? activeItem.actionSpec
            : undefined;
        assertActionContract(activeActionSpec, envelope.payload);
      } catch (err) {
        if (err instanceof ContractViolationError) {
          opts.logger.warn("render_channel_contract_violation", {
            sessionId: sub.sessionId,
            violations: err.violations,
            envelope: "action",
          });
          sendError(ws, "CONTRACT_VIOLATION", err.message, message.requestId, err.toErrorData());
          return;
        }
        throw err;
      }
    }

    // Dual-write, mirroring `ggui_runtime_submit_action`'s dispatch
    // branch (`createGguiSubmitActionHandler`):
    //
    //   1. Ledger — `GguiSessionStore.appendEvent` assigns a monotonic
    //      seq the client acks back with so reconnects can resume via
    //      `fromSeq`. This retained copy is also the single build site
    //      for the operator-facing `tool` hint — see
    //      {@link withDerivedToolHint}.
    //   2. Pipe — for `data:submit` envelopes, the consume-entry
    //      projection ({@link toConsumeEventEntry}) lands on the
    //      pending-events pipe so the agent's `ggui_consume` long-poll
    //      drains it mid-turn. The ledger and the pipe are two
    //      different streams (queue vs append-only retained — see
    //      `pending-event-consumer.ts`); without this write a WS
    //      gesture would never reach the agent.
    //
    // Both writes fire concurrently via `Promise.allSettled` so each
    // outcome is inspected independently: a ledger rejection is the
    // load-bearing `APPEND_FAILED` error path (unchanged ack
    // semantics); a pipe rejection (pipe never opened / already
    // reaped) degrades to ledger-only with a warn — the WS client has
    // no `ui/message` fallback to branch on, so a new error frame
    // would be vocabulary without a consumer.
    const consumeWrite: Promise<void> = (() => {
      if (opts.pendingEventConsumer === undefined || envelope.type !== "data:submit") {
        return Promise.resolve();
      }
      const entry = toConsumeEventEntry(envelope, sub.sessionId);
      if (entry === null) return Promise.resolve();
      return opts.pendingEventConsumer.append(sub.sessionId, {
        // The pipe entry's stable id doubles as the `drain_ack` key —
        // same convention as the relay path's iframe-supplied id.
        id: entry.actionId,
        envelope: entry,
        createdAt: entry.firedAt,
      });
    })();
    const [ledgerResult, pipeResult] = await Promise.allSettled([
      opts.renderStore.appendEvent({
        sessionId: sub.sessionId,
        type: "user.submitted",
        data: withDerivedToolHint(envelope, activeItem),
      }),
      consumeWrite,
    ]);
    if (pipeResult.status === "rejected") {
      opts.logger.warn("render_channel_consume_append_failed", {
        sessionId: sub.sessionId,
        error:
          pipeResult.reason instanceof Error
            ? pipeResult.reason.message
            : String(pipeResult.reason),
      });
    }
    if (ledgerResult.status === "rejected") {
      const err = ledgerResult.reason;
      opts.logger.error("render_channel_append_failed", {
        sessionId: sub.sessionId,
        error: String(err),
      });
      sendError(
        ws,
        "APPEND_FAILED",
        err instanceof Error ? err.message : String(err),
        message.requestId
      );
      return;
    }
    const seq: number = ledgerResult.value;

    send(ws, {
      type: "ack",
      payload: { sequence: seq, timestamp: Date.now() },
      ...(message.requestId ? { requestId: message.requestId } : {}),
    });
  }

  async function handleSubscribe(
    ws: WebSocket,
    identity: AuthResult,
    message: WebSocketMessage & { type: "subscribe" },
    cookieBound?: { readonly sessionId: string; readonly appId: string }
  ): Promise<void> {
    const payload: SubscribePayload = message.payload;

    // Protocol-version handshake. Opt-in on the client side: absent
    // `supportedVersions` is legacy-pass-through. When present,
    // require the server's PROTOCOL_SCHEMA_VERSION to be in the
    // declared set — otherwise emit UPGRADE_REQUIRED.
    //
    //   - 'reject' (default): emit + close the connection. Canonical
    //     posture for first-party servers.
    //   - 'advisory' (opt-out): emit + keep the connection
    //     open (but stop the subscribe; no ack, no render work).
    //     Clients that ignore the code continue exactly as
    //     pre-handshake.
    //
    // Placed FIRST — before bootstrap verify (which consumes the
    // single-use bootstrap token per the GguiSessionChannelBootstrap
    // docstring) and before render lookup/creation (DB work).
    // Bootstrap iframes with a version mismatch must retry with a
    // fresh bootstrap token; burning the token on a mismatch the
    // client could detect by reading the version-negotiation spec
    // would be a footgun.
    if (
      Array.isArray(payload.supportedVersions) &&
      payload.supportedVersions.length > 0 &&
      !payload.supportedVersions.includes(PROTOCOL_SCHEMA_VERSION)
    ) {
      const policy: "advisory" | "reject" = opts.versionPolicy ?? "reject";
      sendError(
        ws,
        UPGRADE_REQUIRED,
        `Server speaks ${PROTOCOL_SCHEMA_VERSION}; client declared ` +
          `supportedVersions=[${payload.supportedVersions.join(", ")}].`,
        message.requestId,
        {
          serverVersion: PROTOCOL_SCHEMA_VERSION,
          clientSupportedVersions: payload.supportedVersions,
          policy,
        }
      );
      opts.logger.warn("render_channel_version_mismatch", {
        sessionId: payload.sessionId,
        appId: payload.appId,
        serverVersion: PROTOCOL_SCHEMA_VERSION,
        clientSupportedVersions: payload.supportedVersions,
        policy,
      });
      if (policy === "reject") {
        try {
          ws.close();
        } catch {
          // best-effort — socket may already be closing
        }
      }
      return;
    }

    // WS-token-auth path. When `payload.wsToken` is present, the MCP
    // Apps iframe is asking us to authenticate it via the short-lived
    // token minted by `ggui_render`. This REPLACES the upgrade-time
    // AuthAdapter identity — iframes don't carry bearer tokens.
    // Mutually-exclusive on purpose.
    let effectiveIdentity: AuthResult = identity;
    let mintedSessionToken: string | undefined;
    let tokenBoundAppId: string | undefined;
    if (typeof payload.wsToken === "string" && payload.wsToken.length > 0) {
      if (!opts.bootstrap) {
        sendError(
          ws,
          "BOOTSTRAP_NOT_SUPPORTED",
          "This server was not configured with ws-token-auth plumbing",
          message.requestId
        );
        return;
      }
      const verifyResult = opts.bootstrap.verify(payload.wsToken);
      if (!verifyResult.ok) {
        opts.logger.warn("render_channel_bootstrap_rejected", {
          sessionId: payload.sessionId,
          appId: payload.appId,
          reason: verifyResult.reason,
        });
        // G14 (2026-05-23): distinguish `expired` from `invalid` so the
        // iframe-side handler can branch on refresh-vs-rehandshake.
        // Tamper / format / kind failures collapse into BOOTSTRAP_INVALID
        // (no refresh path); expired-but-signed envelopes emit the
        // dedicated BOOTSTRAP_EXPIRED so the client knows to call
        // `ggui_runtime_refresh_ws_token`.
        if (verifyResult.reason === "expired") {
          sendError(
            ws,
            "BOOTSTRAP_EXPIRED",
            "Bootstrap token expired — call ggui_runtime_refresh_ws_token or re-handshake",
            message.requestId
          );
        } else {
          sendError(
            ws,
            "BOOTSTRAP_INVALID",
            "Bootstrap token invalid (bad signature, malformed, or wrong kind)",
            message.requestId
          );
        }
        return;
      }
      const bound = { sessionId: verifyResult.sessionId, appId: verifyResult.appId };
      if (bound.sessionId !== payload.sessionId) {
        sendError(
          ws,
          "BOOTSTRAP_SESSION_MISMATCH",
          `Bootstrap token is bound to render '${bound.sessionId}' but subscribe targets '${payload.sessionId}'`,
          message.requestId
        );
        return;
      }
      // `payload.appId` is OPTIONAL on the wire (SPEC §12.2): under a
      // bound token, absence resolves to the token's bound appId — the
      // token binding IS the identity-default. Only a PRESENT value
      // that contradicts the binding is a mismatch.
      if (payload.appId !== undefined && payload.appId !== bound.appId) {
        sendError(
          ws,
          "BOOTSTRAP_APP_MISMATCH",
          `Bootstrap token is bound to app '${bound.appId}' but subscribe targets '${payload.appId}'`,
          message.requestId
        );
        return;
      }
      tokenBoundAppId = bound.appId;
      // Synthesize a minimal AuthResult from the bootstrap claims.
      // The subscriber row needs an identity for logging and roster
      // inspection; the bootstrap-derived identity is a first-class
      // citizen for the lifetime of this subscription.
      effectiveIdentity = {
        identity: {
          kind: "user",
          userId: bound.sessionId,
          workspaceId: bound.appId,
          roles: [],
        },
        source: "apikey",
      };
      // Mint the reconnect credential now — before create/observe
      // work — so a downstream failure doesn't leave the client with
      // no way to resume.
      mintedSessionToken = opts.bootstrap.issueSessionToken(bound.sessionId, bound.appId);
      opts.logger.info("render_channel_bootstrap_accepted", {
        sessionId: bound.sessionId,
        appId: bound.appId,
      });
    }

    // Identity-default appId resolution (SPEC §12.2): `payload.appId`
    // is optional on the wire. Absent ⇒ resolve it from the
    // connection's authenticated identity BEFORE any store work —
    // exactly the rule the `/mcp` endpoint applies: a credential
    // binding wins (wsToken binds `(sessionId, appId)`; the console
    // cookie binds the same pair), else the deployment's identity →
    // appId mapping (`appIdFromIdentity`, defaulting to
    // `defaultAppIdFromIdentity`). The resolved value then flows
    // through the EXISTING tenancy gate + provisioning below — never
    // an `undefined` tenant on a stored row.
    const effectiveAppId: string =
      payload.appId ??
      tokenBoundAppId ??
      cookieBound?.appId ??
      (opts.appIdFromIdentity ?? defaultAppIdFromIdentity)(effectiveIdentity);

    // Dev-mode render provisioning: look up first; if not present,
    // create with the client-provided id via the widened
    // CreateGguiSessionInput.id seam. Matches the hosted model's shape
    // (agent creates via ggui_render → client subscribes) in a single
    // step — production deployments tighten this by supplying an
    // AuthAdapter that mints render-scoped tokens on render.
    let stored = await opts.renderStore.get(payload.sessionId);
    if (stored) {
      if (stored.appId !== effectiveAppId) {
        sendError(
          ws,
          "APP_MISMATCH",
          `GguiSession ${payload.sessionId} belongs to a different app`,
          message.requestId
        );
        return;
      }
    } else {
      try {
        stored = await opts.renderStore.create({
          id: payload.sessionId,
          appId: effectiveAppId,
        });
      } catch (err) {
        sendError(
          ws,
          "SESSION_CREATE_FAILED",
          err instanceof Error ? err.message : String(err),
          message.requestId
        );
        return;
      }
    }

    // Snapshot the outbound-stream cursor BEFORE registering the
    // subscriber. Any concurrent producer that calls sendToGguiSession
    // between here and registration gets seq > snapshotSeq, so the
    // subscriber will receive it via live fan-out (not via replay).
    //
    // This is race-safe in single-threaded JS: the next few lines run
    // synchronously up to `register(sub)`, and fan-out's per-subscriber
    // `seq <= replayCompletedSeq` guard takes care of the window.
    const snapshotSeq = await streamBuffer.currentSeq(stored.id);

    // Phase B: a render IS the addressable unit, so the active item
    // is the resolved render's visible-bits surface itself.
    const activeItem = stored.render;

    // Reconnect: `fromSeq` present → replay per policy on declared
    // AND reserved channels. Fresh subscribe: `fromSeq` absent →
    // call with `fromSeq=0` + NO spec, so the buffer's spec-channel
    // walk contributes nothing (preserving the "initial state comes
    // from ack.render.props; stream channels are for updates after"
    // doctrine for agent-declared channels) but the reserved-channel
    // walk still surfaces server-pushed state that landed before the
    // subscriber attached.
    const activeStreamSpec =
      activeItem.type !== "mcpApps" && activeItem.type !== "system"
        ? activeItem.streamSpec
        : undefined;
    const replay =
      payload.fromSeq !== undefined
        ? await streamBuffer.replay(stored.id, payload.fromSeq, activeStreamSpec)
        : await streamBuffer.replay(stored.id, 0, undefined);

    // Subscribe to the StreamFanout BEFORE constructing the Subscriber:
    // the seam returns an AsyncIterable whose iterator we hand off; the
    // pump loop in `register` consumes it. Eager registration on the
    // seam side means any concurrent `streamFanout.publish` from this
    // point onward queues into our iterator — paired with the
    // replayCompletedSeq cursor below, that's race-free.
    const fanoutIter = streamFanout.subscribe(stored.id)[Symbol.asyncIterator]();
    const sub: Subscriber = {
      ws,
      sessionId: stored.id,
      appId: stored.appId,
      identity: effectiveIdentity,
      connectedAt: Date.now(),
      replayCompletedSeq: snapshotSeq,
      iter: fanoutIter,
      // Per-subscriber channel-subscribe tracker. Populated
      // lazily by the `channel_subscribe` handler when the operator
      // wired `streamWebSocketLocalTools`; stays empty otherwise.
      channelSubs: new Map<string, ChannelSubscriptionState>(),
    };
    register(sub);
    opts.logger.info("render_channel_subscribed", {
      sessionId: stored.id,
      appId: stored.appId,
      identityKind: effectiveIdentity.identity.kind,
      fromSeq: payload.fromSeq,
      snapshotSeq,
      replayCount: replay?.envelopes.length ?? 0,
      replayTruncated: replay?.truncated ?? false,
      bootstrap: mintedSessionToken !== undefined,
    });

    const ackPayload: AckPayload = {
      sequence: stored.eventSequence,
      timestamp: Date.now(),
      session: stored.render,
      streamSeq: snapshotSeq,
      // Advertise the server's protocol version on every successful
      // subscribe ack (SPEC §11.2.2). Clients whose
      // CLIENT_SUPPORTED_VERSIONS doesn't contain this string surface
      // UpgradeRequiredError to their caller; clients that don't wire
      // the handshake ignore the field (legacy-pass-through).
      serverVersion: PROTOCOL_SCHEMA_VERSION,
      ...(replay?.truncated ? { replayTruncated: true } : {}),
      ...(mintedSessionToken !== undefined ? { sessionToken: mintedSessionToken } : {}),
    };
    send(ws, {
      type: "ack",
      payload: ackPayload,
      ...(message.requestId ? { requestId: message.requestId } : {}),
    });

    // R7 — GguiSessionEvent ledger replay. When `payload.sinceSequence` is
    // present, fetch events with `seq > sinceSequence` from the per-
    // render ledger and emit each as a `render_event` wire frame
    // BEFORE the per-channel stream-buffer replay. Consumers dispatch
    // by `event.type` to fold the wire-frame-equivalent handler
    // (render/props_update/etc.) — same cursor model as the HTTP
    // `/api/sessions/:id/events?sinceSequence=N` endpoint.
    //
    // Horizon gate: a cursor below the server's replay horizon OR
    // above `lastSequence` (stale from a different deployment) emits
    // an error frame with `code: 'REPLAY_HORIZON_PASSED'` and skips
    // the replay. Client recovery: re-mount from a fresh /state read.
    if (payload.sinceSequence !== undefined) {
      const sinceSeq = payload.sinceSequence;
      if (sinceSeq < 0 || !Number.isInteger(sinceSeq)) {
        sendError(
          ws,
          "INVALID_SINCE_SEQUENCE",
          "sinceSequence must be a non-negative integer",
          message.requestId
        );
      } else {
        const ledger = await opts.renderStore.listEventsSince(
          stored.id,
          sinceSeq,
          // Server-side cap matches the HTTP route's default (100).
          // Stress + replay-from-zero workloads cap here.
          100
        );
        if (ledger === null) {
          // GguiSession disappeared between resolve and ledger read —
          // already handled by the broader error envelope path; nothing
          // to do here.
        } else if (sinceSeq > ledger.lastSequence || sinceSeq < ledger.horizonSeq) {
          sendError(
            ws,
            "REPLAY_HORIZON_PASSED",
            `cursor ${sinceSeq} is outside replayable range [${ledger.horizonSeq}, ${ledger.lastSequence}]`,
            message.requestId,
            { currentSequence: ledger.lastSequence }
          );
        } else {
          for (const event of ledger.events) {
            // GguiSessionEvent is now the wire-shape ledger primitive
            // (Wave 7 of flatten-render-identity, 2026-05-28); no
            // projection — emit the store's row directly.
            send(ws, {
              type: "render_event",
              payload: event,
            });
          }
        }
      }
    }

    // Send replay frames AFTER the ack. Ordering by `seq` ASC — the
    // buffer returns them pre-sorted. Client sees ack(streamSeq=N) →
    // up to N replay `data` frames → live tail (seq > N). No explicit
    // "replay end" marker is needed; the client uses envelope.seq as
    // the single source of truth for ordering.
    if (replay) {
      for (const env of replay.envelopes) {
        send(ws, { type: "data", payload: env });
      }
    }
  }

  async function onMessage(ws: WebSocket, raw: string): Promise<void> {
    const sub = subscribersByWs.get(ws);
    let message: WebSocketMessage;
    try {
      message = JSON.parse(raw) as WebSocketMessage;
    } catch {
      sendError(ws, "INVALID_JSON", "Message is not valid JSON");
      return;
    }
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      sendError(ws, "INVALID_MESSAGE", "Message is missing a `type` discriminator");
      return;
    }

    switch (message.type) {
      case "subscribe": {
        // `subscribe` is the only message allowed before identity is
        // bound to a render. Identity was already resolved at upgrade
        // time; we just need to register the subscriber.
        const identity = pendingIdentity.get(ws);
        if (!identity) {
          sendError(ws, "UNAUTHENTICATED", "No identity bound to this socket", message.requestId);
          return;
        }
        // Cookie-scope enforcement: when the upgrade was authenticated
        // via an console cookie, the subscribe payload MUST target
        // the render the cookie was issued for. A valid cookie for
        // render A can't be used to open render B.
        const cookieBound = pendingCookieBinding.get(ws);
        if (cookieBound) {
          if (message.payload.sessionId !== cookieBound.sessionId) {
            sendError(
              ws,
              "DEVTOOL_COOKIE_SESSION_MISMATCH",
              `Embedded-ui cookie is bound to render '${cookieBound.sessionId}' but subscribe targets '${message.payload.sessionId}'`,
              message.requestId
            );
            return;
          }
          // `appId` is optional on the wire (SPEC §12.2): absent
          // resolves to the cookie's bound appId inside
          // `handleSubscribe` — only a PRESENT contradicting value is
          // a mismatch.
          if (message.payload.appId !== undefined && message.payload.appId !== cookieBound.appId) {
            sendError(
              ws,
              "DEVTOOL_COOKIE_APP_MISMATCH",
              `Embedded-ui cookie is bound to app '${cookieBound.appId}' but subscribe targets '${message.payload.appId}'`,
              message.requestId
            );
            return;
          }
        }
        await handleSubscribe(ws, identity, message, cookieBound);
        pendingIdentity.delete(ws);
        pendingCookieBinding.delete(ws);
        return;
      }
      case "ping":
        send(ws, {
          type: "pong",
          payload: {},
          ...(message.requestId ? { requestId: message.requestId } : {}),
        });
        return;
      case "close":
        // Explicit close from client — unregister + close the socket.
        if (sub) unregister(ws);
        ws.close(1000, "client_close");
        return;
      case "action":
        if (!sub) {
          sendError(
            ws,
            "NOT_SUBSCRIBED",
            "Send a 'subscribe' message first before 'action'",
            message.requestId
          );
          return;
        }
        await handleInboundAction(ws, sub, message);
        return;
      case "channel_subscribe":
        if (!sub) {
          sendError(
            ws,
            "NOT_SUBSCRIBED",
            "Send a 'subscribe' message first before 'channel_subscribe'",
            message.requestId
          );
          return;
        }
        await handleChannelSubscribe(ws, sub, message);
        return;
      case "channel_unsubscribe":
        if (!sub) {
          // No subscriber → nothing was subscribed → no-op silently.
          // Returning an error would leak "is this socket subscribed"
          // state for unauthenticated clients.
          return;
        }
        handleChannelUnsubscribe(ws, sub, message);
        return;
      case "host_context_observed":
        // The iframe-runtime echoes its captured `McpUiHostContext`
        // after `ui/initialize` resolves and on every
        // `ui/notifications/host-context-changed` notification. Persist
        // on `GguiSession.hostContext` so `ggui_handshake` and
        // `ggui_consume` can surface it to the agent on subsequent
        // turns. Fire-and-forget on the client side; no response.
        if (!checkSubscriberTenancy(ws, sub, message.payload, message.type, message.requestId)) {
          return;
        }
        await applyGguiSessionPatch(sub.sessionId, sub.appId, message.type, {
          hostContext: message.payload.hostContext,
          lastActivityAt: Date.now(),
        });
        return;
      default:
        sendError(
          ws,
          "UNSUPPORTED_MESSAGE",
          `Unsupported message type: ${String((message as WebSocketMessage).type)}`,
          message.requestId
        );
    }
  }

  /**
   * During the pre-subscribe window, a ws has a resolved identity but
   * no render-bound subscriber yet. We hold the identity here until
   * the first `subscribe` lands; once it does, the subscriber record
   * owns the identity and this entry is cleared.
   */
  const pendingIdentity = new WeakMap<WebSocket, AuthResult>();
  /**
   * Embedded-ui cookie binding established at upgrade. When present,
   * `handleSubscribe` enforces `subscribe.sessionId === bound.sessionId`
   * so a valid cookie can't be used to open a render it wasn't
   * issued for. Parallel to {@link pendingIdentity} — same lifetime,
   * same WeakMap rationale.
   */
  const pendingCookieBinding = new WeakMap<WebSocket, { sessionId: string; appId: string }>();

  wss.on("connection", (ws, req) => {
    // Bind the resolved identity from the upgrade phase. It was
    // attached to the request object in handleUpgrade.
    const identity = (req as IncomingMessage & { __gguiIdentity?: AuthResult }).__gguiIdentity;
    if (identity) pendingIdentity.set(ws, identity);
    // Likewise for any cookie binding.
    const cookieBound = (
      req as IncomingMessage & {
        __gguiCookieBound?: { sessionId: string; appId: string };
      }
    ).__gguiCookieBound;
    if (cookieBound) pendingCookieBinding.set(ws, cookieBound);

    // Per-socket inbound processing chain. The WebSocket wire is an
    // ORDERED frame stream, so inbound handling must observe arrival
    // order even though the handlers are async: without the chain, a
    // client that pipelines `subscribe` + `action` in one TCP segment
    // (both `message` events fire in the same macrotask) gets the
    // action handled while `handleSubscribe` is parked at its first
    // `await` — the socket has no bound subscriber yet, and a
    // correctly-ordered client is rejected with NOT_SUBSCRIBED.
    // Serializing per socket restores the wire's ordering on the
    // processing side; distinct sockets stay fully concurrent.
    let inboundChain: Promise<void> = Promise.resolve();
    ws.on("message", (raw) => {
      // `ws.on('message')` delivers Buffer/ArrayBuffer/Buffer[] depending
      // on frame type; normalize to string.
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      inboundChain = inboundChain.then(() =>
        onMessage(ws, text).catch((err) => {
          // Catch INSIDE the chain link so one failed message never
          // poisons the chain for subsequent frames.
          opts.logger.error("render_channel_message_failed", {
            error: String(err),
          });
        })
      );
    });

    ws.on("close", () => {
      unregister(ws);
      pendingIdentity.delete(ws);
    });

    ws.on("error", (err) => {
      opts.logger.warn("render_channel_socket_error", { error: String(err) });
    });
  });

  return {
    path,
    handleUpgrade(req, socket, head) {
      resolveIdentityFromUpgrade(req)
        .then((identity) => {
          // Stash identity on the request so the 'connection' handler
          // can wire it onto the socket. This is the standard ws
          // per-request piggyback pattern.
          (req as IncomingMessage & { __gguiIdentity?: AuthResult }).__gguiIdentity = identity;
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
    async sendToGguiSession(delivery) {
      // Outbound fan-out enforcement (defense-in-depth parity with
      // hosted `handle-data.ts`). Re-validates the delivery's payload
      // against the render's streamSpec BEFORE delivery — so a future
      // OSS mutation handler that bypasses the emit-side check can't
      // fan out malformed data to subscribers. Throws
      // ContractViolationError{tool:'ggui_emit'} on violation;
      // caller decides what to do (log, rethrow, wrap).
      const stored = await opts.renderStore.get(delivery.sessionId);
      const activeEntry = stored?.render;
      const streamSpec =
        activeEntry !== undefined && activeEntry.type !== "mcpApps" && activeEntry.type !== "system"
          ? activeEntry.streamSpec
          : undefined;
      assertStreamContract(
        streamSpec,
        delivery.channel,
        delivery.payload,
        opts.extraReservedValidators
      );
      return fanOut(delivery, streamSpec);
    },
    notifyGguiSessionCommit(sessionId, render, matchType) {
      // Best-effort fan-out to every live subscriber bound to this
      // render. NOT routed through the replay buffer — see the
      // `notifyGguiSessionCommit` JSDoc on the interface for why fresh
      // subscribers rely on `ack.render` instead of a replay frame.
      // NOT routed through StreamFanout either — `type: 'render'` is a
      // distinct WebSocket message type. Filter the flat WS-subscriber
      // set by sessionId; N is typically 1-2 (multi-tab render sharing).
      const payload = matchType !== undefined ? { session: render, matchType } : { session: render };
      for (const sub of wsSubscribers) {
        if (sub.sessionId !== sessionId) continue;
        send(sub.ws, { type: "render", payload });
      }
    },
    sendPropsUpdate(sessionId, props) {
      // Public entry point — delegates to the closure-level impl.
      // Returns the impl's promise so the caller can await store-lookup
      // completion if desired.
      return sendPropsUpdateImpl(sessionId, props);
    },
    sendDrainAck({ sessionId, appId, eventId, drainedAt }) {
      // Server-side fan-out for the action-drain ack.
      // Filter the flat WS-subscriber set by sessionId (same posture
      // as `sendPropsUpdate`). No persistence; subscribers that
      // missed the frame fall back to their 10s claim timer, which
      // the atomic pop resolves cleanly.
      for (const sub of wsSubscribers) {
        if (sub.sessionId !== sessionId) continue;
        send(sub.ws, {
          type: "drain_ack",
          payload: { sessionId, appId, eventId, drainedAt },
        });
      }
    },
    externalBroadcast(sessionId, frame) {
      // Walk the flat subscriber set; filter to matching sessionId.
      // `send()` already guards closed sockets and logs (but doesn't
      // throw on) per-subscriber failures, so the caller (an external
      // pubsub on-message handler) can't be made to fail by a dead
      // WebSocket. No GguiSessionStore lookup — the publisher already
      // validated; this seam is the cross-process delivery path, not
      // the re-validation point.
      for (const sub of wsSubscribers) {
        if (sub.sessionId !== sessionId) continue;
        send(sub.ws, frame);
      }
    },
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
