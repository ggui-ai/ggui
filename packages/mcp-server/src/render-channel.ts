/**
 * OSS live channel — live render plane over WebSocket.
 *
 * The live channel is where the typed-channel contract is enforced on
 * live traffic between the server and the user. It co-hosts on the
 * same Express server as `/mcp` and reuses the same
 * `@ggui-ai/mcp-server-handlers/renders` helpers that the
 * closed hosted server consumes.
 *
 * Scope:
 *
 *   - `subscribe` → auth, resolve-or-create render, register subscriber,
 *     reply `ack` with the render's current snapshot + sequence.
 *   - `action` → inbound user action carried as an {@link ActionEnvelope}.
 *     Gated through `assertEventAllowed` (allowlist) +
 *     `assertActionContract` (payload, for data:submit). Persisted to
 *     RenderStore as a typed render event.
 *   - `ping`/`pong` → heartbeat parity with hosted.
 *   - `close`/socket-close → clean subscriber teardown.
 *   - `sendToRender(renderId, data)` → outbound fan-out API for
 *     mutation handlers (ggui_emit / connector `ctx.send`). Validated
 *     through `assertStreamContract` before delivery.
 *
 * `props_update`: mount handlers dispatched through the wired-action
 * router can call `ctx.sendPropsUpdate(renderId, props)` to fan a
 * `{type:'props_update'}` frame to live subscribers without going
 * through a refresh-stream path. Reaches the renderer's existing
 * `props_update` branch in `iframe-runtime` and applies new props
 * in-place. This seam is scoped to mount tools; the agent-driven
 * `ggui_update` path is handled separately.
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
  RenderPatch,
  RenderStore,
  SessionStreamBuffer,
  StreamEnvelopeInput,
  StreamFanout,
  TelemetrySink,
} from "@ggui-ai/mcp-server-core";
import {
  InMemorySessionStreamBuffer,
  InProcessStreamFanout,
  NoopTelemetrySink,
} from "@ggui-ai/mcp-server-core/in-memory";
import { assertActionContract, assertStreamContract } from "@ggui-ai/mcp-server-handlers/renders";
import type {
  AckPayload,
  ActionEnvelope,
  ActionEventValue,
  ContractErrorCode,
  ContractErrorPayload,
  ErrorPayload,
  JsonObject,
  RefreshInput,
  Render,
  ReservedChannelValidator,
  SanitizeCausedBy,
  StreamSpec,
  SubscribePayload,
} from "@ggui-ai/protocol";
import {
  CONTRACT_ERROR_CHANNEL,
  ContractViolationError,
  sanitizeCausedBy as defaultSanitizeCausedBy,
  EMPTY_REFRESH_INPUT,
  makeContractErrorPayload,
  PROTOCOL_SCHEMA_VERSION,
  UPGRADE_REQUIRED,
} from "@ggui-ai/protocol";
import type { WebSocketMessage } from "@ggui-ai/protocol/transport/websocket";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { resolveIdentityFromHeaders, UnauthenticatedError } from "./auth.js";
import type { Logger } from "./logger.js";

// `assertEventAllowed` + `EventNotAllowedError` were removed from
// `@ggui-ai/mcp-server-handlers/renders` in Phase B alongside
// the session-stack collapse — the event-allowlist concept on a
// `StackItem.subscription` no longer has a wire shape to bind to.
// Local stand-ins keep the inbound-action allowlist call sites
// compiling until the event-allowlist semantics are re-thought in a
// follow-up slice (see "B.2d render-channel inbound-action allowlist
// deferred" in the report).
class EventNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventNotAllowedError";
  }
}
function assertEventAllowed(_subscription: unknown, _type: string): void {
  // No-op: pre-Phase-B this read `StackItem.subscription` and rejected
  // event types not on the allowlist. Post-collapse there's no
  // subscription field on `Render`; the gate is deferred to a follow-up
  // slice that defines per-render event policy on the new wire shape.
}

/** Default URL path for the channel endpoint. Operators can override. */
export const DEFAULT_RENDER_CHANNEL_PATH = "/ws";

/**
 * A single connected subscriber (one client, one render). Held live in
 * the per-channel subscriber map; torn down on socket close or explicit
 * `close` message.
 */
interface Subscriber {
  readonly ws: WebSocket;
  readonly renderId: string;
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
   * Keyed by `${renderId}:${channelName}` so a reconnect that
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
 * Per-(subscriber, renderId, channelName) polling-loop state.
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
  /** Render this subscription is bound to (for fan-out scoping). */
  readonly renderId: string;
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
 * tune via {@link RenderChannelLocalToolsOptions.pollCadence}.
 */
const DEFAULT_CHANNEL_POLL_FLOOR_MS = 1_000;
const DEFAULT_CHANNEL_POLL_CEILING_MS = 60_000;
const DEFAULT_CHANNEL_POLL_DEFAULT_MS = 10_000;

/**
 * Opt-in plumbing for the `channel_subscribe` polling loop. When this
 * field is set on {@link RenderChannelOptions}, channel subscribes
 * whose `source.tool` is in {@link allowlist} are accepted and the
 * server begins polling. When absent, every `channel_subscribe`
 * returns `CHANNEL_NOT_LOCAL` so the iframe falls back to direct
 * polling via the MCP host proxy.
 */
export interface RenderChannelLocalToolsOptions {
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
 * message (`SubscribePayload.bootstrap`). When present:
 *
 *   1. `verify(token)` is called. Must return the bound
 *      `{renderId, appId}` on success, or `null` on any failure
 *      (invalid sig, expired, wrong kind, replayed, etc.).
 *   2. The bound `renderId` MUST match the one on the subscribe
 *      payload. Mismatches are rejected with a clean error.
 *   3. On success, the server mints a reconnect credential via
 *      `issueRenderToken(renderId, appId)` and returns it in
 *      `AckPayload.renderToken`. The iframe stores this for WS
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
export type RenderChannelBootstrapVerifyResult =
  | {
      readonly ok: true;
      readonly renderId: string;
      readonly appId: string;
    }
  | { readonly ok: false; readonly reason: "expired" | "invalid" };

/**
 * Result of {@link RenderChannelBootstrap.refresh}.
 *
 *   - `ok: true`: caller swaps the old envelope for `token` and resumes.
 *   - `ok: false`: caller MUST re-handshake (refresh window closed,
 *     tampered envelope, etc.).
 */
export type RenderChannelBootstrapRefreshResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt: string;
    }
  | { readonly ok: false; readonly reason: "window_closed" | "invalid" };

export interface RenderChannelBootstrap {
  /**
   * Verify a `SubscribePayload.bootstrap` token.
   *
   * Returns the bound identity on success, or a discriminated failure.
   * The channel server maps `'expired'` to `BOOTSTRAP_EXPIRED` so the
   * iframe can branch on refresh-vs-rehandshake, and `'invalid'` to
   * `BOOTSTRAP_INVALID` for tamper / format / kind failures (no
   * refresh on those).
   */
  verify(token: string): RenderChannelBootstrapVerifyResult;
  /**
   * Mint a longer-lived reconnect credential to return in
   * `AckPayload.renderToken`. Called only after a successful
   * `verify()` on a bootstrap subscribe.
   */
  issueRenderToken(renderId: string, appId: string): string;
  /**
   * Refresh a (possibly-expired-but-signature-valid) bootstrap envelope
   * into a new envelope with a fresh TTL. Used by the
   * `ggui_runtime_refresh_bootstrap` MCP tool — iframes that see their
   * bootstrap drift out of the TTL window swap in the refreshed
   * envelope without going back through `ggui_render`.
   *
   * Stateless: verifies HMAC against the same secret used at mint,
   * checks the refresh window against the ORIGINAL `iat`, and mints
   * a fresh bootstrap envelope bound to the SAME `(renderId, appId)`.
   * Past the refresh window the result is `{ok:false, reason:
   * 'window_closed'}`; tampered envelopes are `{ok:false, reason:
   * 'invalid'}`.
   */
  refresh(token: string): RenderChannelBootstrapRefreshResult;
}

/**
 * Default timeout for a single wired-tool invocation, in ms. Operators
 * override via {@link RenderChannelOptions.wiredActionTimeoutMs}; the
 * 30 s ceiling is a honest non-promise: long-running tools MUST design
 * their own completion path (streaming, polling).
 */
export const DEFAULT_WIRED_TOOL_TIMEOUT_MS = 30_000;

/**
 * Opt-in wired-action dispatch surface. When present on a render
 * channel, `data:submit` envelopes whose declared `actionSpec
 * [name].tool` resolves against this router fire the named tool
 * in-process after validation, and the router's return value flows
 * back onto the render through a refresh-stream emission (see the
 * {@link import('@ggui-ai/protocol').StreamChannelEntry.tool} field).
 *
 * This is the agent-free contract-execution path — "zero agent code"
 * lands here. In OSS `ggui serve`, the CLI composes a router that
 * delegates to the same handler bundle `/mcp` uses (ggui-native +
 * mounts). Hosted deployments that want the same behavior compose
 * their own.
 *
 * Intentionally minimal surface:
 *   - `has(name)` separates "tool absent" (TOOL_NOT_FOUND envelope,
 *     recoverable) from "tool handler threw" (TOOL_THREW envelope,
 *     isolated). The channel server uses the split to pick the error
 *     code BEFORE invoking.
 *   - `invoke(name, input)` returns `unknown` — the router doesn't
 *     impose a shape, the refresh emission validates against the
 *     declared `streamSpec[*].schema`.
 *
 * Thread-safety: implementations MUST tolerate concurrent invocations
 * for the same or different tools. The render channel fires no retry;
 * the router's handler is the sole execution.
 */
/**
 * Per-invocation context the wired-action dispatcher hands the router.
 * The render-channel server constructs this at dispatch time from
 * the active render, then closes
 * `sendPropsUpdate` over the channel's outbound fan-out so the mount
 * handler can push a `props_update` frame to live subscribers without
 * routing through a refresh-stream tool.
 *
 * Why this is its own type, not threaded through `HandlerContext`:
 * `HandlerContext` (in `@ggui-ai/mcp-server-handlers`) is the canonical
 * shape every shared handler — ggui-native AND mounted — accepts. It
 * stays narrow on purpose (`appId`, `requestId`, optional `apiKeyHash`)
 * so the surface a host implements is stable. Wired-action runtime
 * fields (`renderId`, `renderId`, `sendPropsUpdate`) are dispatcher-
 * specific — only mount tools invoked through the wired-action router
 * see them, only at dispatch time. Passing them as a third arg to
 * `invoke` keeps the canonical handler shape untouched and makes
 * "this code reaches a wired dispatch path" syntactically obvious.
 *
 * The composer in `mcp-mounts.ts::composeWiredActionRouterFromMounts`
 * synthesizes a runtime ctx for the mount handler that satisfies
 * `HandlerContext` AND structurally carries these wired fields, so a
 * mount fixture can read `ctx.sendPropsUpdate` / `ctx.renderId` from the
 * same `ctx` argument the canonical `HandlerContext` sig types — no
 * cast, no widening of the static type.
 */
export interface WiredActionContext {
  /** The render this dispatch is bound to. Sourced from the live
   * subscriber + the action envelope's spoof-guarded `renderId`. */
  readonly renderId: string;
  /**
   * Push a `{type:'props_update', payload:{renderId, props}}` frame to
   * every live subscriber bound to this dispatcher's `renderId`. The
   * call closes over the `RenderChannelServer.sendPropsUpdate` method,
   * scoped to the active render for safety.
   *
   * Best-effort: per-subscriber send failures are swallowed; a closed
   * socket is a no-op.
   */
  sendPropsUpdate(props: JsonObject): void;
}

export interface WiredActionRouter {
  /** Returns `true` when the named tool has a registered handler. Used
   * to emit a clean `TOOL_NOT_FOUND` envelope before invoking — an
   * "invoke unknown tool" would throw through router internals, but
   * the error surface would be less specific. */
  has(toolName: string): boolean;
  /**
   * Invoke the named tool with the given input + per-dispatch wired
   * context. The channel server wraps this call in a timeout +
   * try/catch; implementations SHOULD NOT add their own retry or
   * timeout layer on top.
   *
   * `ctx.sendPropsUpdate` is closed over the active render — mounts
   * fire it to push props to live subscribers without an extra refresh
   * round-trip. Refresh-stream invocations (the post-action pass that
   * fires every declared `streamSpec[*].tool`) reuse the SAME ctx —
   * a refresh tool that wants to emit a props_update can do so, though
   * the canonical surface is the action tool itself.
   */
  invoke(
    toolName: string,
    input: Record<string, unknown>,
    ctx: WiredActionContext
  ): Promise<unknown>;
}

export interface RenderChannelOptions {
  /** Required — the render backing store (typically `InMemoryRenderStore`). */
  readonly renderStore: RenderStore;
  /**
   * Required — the same `AuthAdapter` the `/mcp` endpoint uses. Any
   * failure during `subscribe` rejects the upgrade with HTTP 401.
   */
  readonly auth: AuthAdapter;
  /**
   * Maps resolved identity → tenant appId. Defaults to
   * `defaultAppIdFromIdentity` — same mapping the `/mcp` endpoint uses.
   */
  /** Structured logger. */
  readonly logger: Logger;
  /** URL path to mount on. Defaults to `/ws`. */
  readonly path?: string;
  /**
   * Outbound stream replay buffer. Defaults to a fresh
   * `InMemorySessionStreamBuffer` when omitted — fine for OSS
   * zero-config / dev. Persistent adapters bind via the same
   * `SessionStreamBuffer` interface when they land.
   *
   * Each channel instance owns its own seq cursor space; sharing a
   * buffer across two channels in the same process would couple their
   * sequences in confusing ways.
   */
  readonly streamBuffer?: SessionStreamBuffer;
  /**
   * Live-tail pub/sub for outbound live-channel frames. Defaults to a
   * fresh `InProcessStreamFanout` (in-memory, single-process). Hosted
   * deployments bind a `RedisPubSubFanout` here for multi-process
   * fan-out.
   *
   * The channel server uses the seam to publish every fanout-eligible
   * envelope and to subscribe one async iterator per WebSocket
   * subscriber — no in-process Map walk; the seam owns routing.
   */
  readonly streamFanout?: StreamFanout;
  /**
   * Optional bootstrap-auth plumbing. When present, the channel
   * accepts `SubscribePayload.bootstrap` and issues reconnect
   * credentials in `AckPayload.renderToken`. When absent, bootstrap
   * tokens are rejected with `BOOTSTRAP_NOT_SUPPORTED`.
   */
  readonly bootstrap?: RenderChannelBootstrap;

  /**
   * Optional console cookie-auth plumbing. When present, the
   * channel upgrade looks for the configured cookie on the incoming
   * request. A valid cookie binds the identity as a `builder` and
   * scopes the subscriber to the cookie's `renderId` — any
   * `subscribe.renderId` mismatch is rejected with
   * `DEVTOOL_COOKIE_RENDER_MISMATCH`.
   *
   * Absent = cookie auth disabled on this channel. Cookies are never
   * auto-enabled; the server's console composition decides.
   *
   * Design boundary: this auth plane is MUTUALLY EXCLUSIVE with
   * bootstrap auth at upgrade time. When both are configured, the
   * bootstrap path (via `?bootstrap=` query) wins; cookie is only
   * consulted for standard upgrades.
   */
  readonly cookieAuth?: RenderChannelCookieAuth;
  /**
   * Opt-in wired-action dispatch router. When present, validated
   * `data:submit` envelopes whose declared `actionSpec[name]
   * .tool` names a tool the router knows fire the tool in-process and
   * emit any declared refresh on the render. See
   * {@link WiredActionRouter}.
   *
   * Absent (the default) = the server relays inbound actions to the
   * render store for agent pickup and emits no synthetic stream
   * frames. Matches pre-Slice-11.5 behavior — no regression surface.
   */
  readonly wiredActionRouter?: WiredActionRouter;
  /**
   * Per-call timeout for wired-tool invocations, in milliseconds.
   * Defaults to {@link DEFAULT_WIRED_TOOL_TIMEOUT_MS} (30 s). Applied
   * identically to the initial action tool AND to each refresh-stream
   * tool. On timeout, a `TOOL_TIMEOUT` envelope emits on
   * `_ggui:contract-error` and the render channel keeps running.
   */
  readonly wiredActionTimeoutMs?: number;
  /**
   * Override the default sanitizer applied to the stringified original
   * error before it's written to `ContractErrorPayload.error.causedBy`.
   *
   * Defaults to `@ggui-ai/protocol::sanitizeCausedBy` (redacts Bearer
   * tokens, query-param secrets, common env-var patterns, truncates at
   * 2KB). Operators running in locked-down environments can pass a
   * stricter function — e.g., one that returns an empty string to
   * disable `causedBy` entirely, or one that layers additional
   * patterns on top of the defaults.
   *
   * The contract-error envelope flows on `_ggui:contract-error` with
   * `replay: 'all'`, so anything that lands in `causedBy` persists in
   * the render ring buffer and surfaces in RenderInspector. Accepting
   * raw `err.stack` verbatim is a credential-leak footgun; the default
   * sanitizer is load-bearing.
   */
  readonly sanitizeCausedBy?: SanitizeCausedBy;
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
   * validates `_ggui:contract-error`), then falls through to
   * `{valid: true}` when a known reserved channel has no validator.
   *
   * Absent = no `_ggui:preview` validation (documented degradation for
   * implementations without the preview package); `_ggui:contract-
   * error` is always validated via the built-in.
   */
  readonly extraReservedValidators?: ReadonlyMap<string, ReservedChannelValidator>;
  /**
   * Optional {@link TelemetrySink} for live-channel operational signals
   * (C12). When present, the channel emits `wired-tool.invoked` events
   * on successful wired-tool dispatches — operational counts +
   * durations for OTLP / CloudWatch / Datadog forwarders. Defaults
   * to {@link NoopTelemetrySink} (swallow silently).
   *
   * Deliberately separate from the renderer's client-side
   * `ObservabilityEvent` surface: same event name, two independent
   * consumers (backend metrics vs host inspector UI). See C12 plan +
   * the TelemetrySink docstring for the sync/lossy contract.
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
  readonly streamWebSocketLocalTools?: RenderChannelLocalToolsOptions;
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
   * for `renderId` transitions 0 → 1 (the first subscriber for that
   * render connects to this server instance).
   *
   * Hosted deployments use this to lazily SUBSCRIBE to the per-render
   * cross-pod broadcast channel (e.g. Redis pub/sub); OSS has no use
   * for it (in-process broadcasts already route via
   * {@link RenderChannelServer.sendPropsUpdate}). Bounding pubsub
   * fan-in to only renders a pod actually holds connections for is a
   * correctness requirement, not an optimization — without it every
   * pod receives every other pod's broadcast for every active render.
   *
   * Best-effort: a thrown callback is logged and swallowed.
   * `register()` MUST NOT fail because of a hook error or the
   * `wsSubscribers` set would drift out of sync with the real socket
   * lifecycle.
   *
   * Concurrent register/unregister for the same renderId are serialized
   * by the channel's single-threaded WS event loop; hook implementations
   * do not need their own mutex for the 0↔1 transition.
   */
  readonly onFirstSubscriber?: (renderId: string) => void;
  /**
   * Optional hook fired synchronously when the local subscriber count
   * for `renderId` transitions 1 → 0 (the last subscriber for that
   * render disconnects).
   *
   * Symmetric with {@link onFirstSubscriber}; same best-effort posture
   * and single-threaded serialization guarantee.
   */
  readonly onLastSubscriberGone?: (renderId: string) => void;
}

/**
 * Cookie-based authentication for the live-channel upgrade. Used
 * exclusively by the same-origin console viewer; see
 * `console-auth.ts` for the single consumer today.
 */
export interface RenderChannelCookieAuth {
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
  verify(cookieValue: string): { renderId: string; appId: string } | null;
}

export interface RenderChannelServer {
  /** The URL path the channel accepts upgrade requests on. */
  readonly path: string;
  /**
   * Wire this into the HTTP server's `upgrade` event. Rejects with 401
   * on auth failure; otherwise completes the WS handshake and wires
   * the subscriber.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * Deliver a stream envelope to every subscriber of `delivery.renderId`.
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
  sendToRender(delivery: StreamEnvelopeInput): Promise<{ seq: number }>;
  /**
   * Fan a `{type:'render', payload:{render, matchType?}}` wire frame
   * to every subscriber currently bound to `renderId`. Use this to
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
   * `notifyRenderCommit` closes that gap. Best-effort: per-subscriber
   * send failures are swallowed (same posture as `sendToRender`).
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
  notifyRenderCommit(renderId: string, render: Render, matchType?: string): void;
  /**
   * Prime every declared streamSpec channel on `render` that carries a
   * `tool` refresh hint. Invokes each refresh tool via the bound
   * wiredActionRouter with the empty refresh input, validates the result
   * against the channel's schema, and fans it out so subscribers see an
   * initial value instead of `latest = undefined`.
   *
   * Intended for seed-a-render mount paths (console try-live, agent-
   * initiated bootstraps that mint a render without a driving
   * action). Without this, blueprints with `streamSpec[channel].tool`
   * render their empty-state branch because the channel has no live
   * delivery — operators see "waiting for data" UI even when the
   * refresh tool would have produced initial content.
   *
   * Same isolation posture as the action-driven refresh pass: one
   * broken refresh MUST NOT block others; per-channel failures log a
   * warning but don't throw. No-op when no wiredActionRouter is
   * configured, when `render.streamSpec` is absent, or when every
   * channel lacks a `.tool` hint.
   *
   * Ordering: callers should invoke AFTER the render is persisted
   * so `sendToRender`'s active-render lookup resolves. The
   * `try-live` endpoint awaits this before returning the shortCode so
   * the viewer SPA subscribes with the initial envelope already
   * buffered on the render's stream-buffer replay state.
   */
  primeStreams(renderId: string, render: Render): Promise<void>;
  /**
   * Fan a `{type:'props_update', payload:{renderId, props}}` wire frame
   * to every subscriber currently bound to `renderId`. Mount tools
   * dispatched through {@link WiredActionRouter} call this via
   * `WiredActionContext.sendPropsUpdate` so a wired action that
   * mutates server-side state can replace renderer props in-place
   * without going through a refresh-stream tool.
   *
   * Validation posture (mirrors `notifyRenderCommit`'s "best-effort orphan
   * no-op"):
   *   1. Look up the render via `renderStore.get`. Absent → log
   *      `render_channel_props_update_orphan` and return — the wire
   *      validator on the renderer side would reject a frame for an
   *      unknown render anyway.
   *   2. Iterate the flat WS-subscriber set, filter to subscribers
   *      whose `renderId` matches, and `send()` the frame. Closed
   *      sockets are skipped silently by `send()`.
   *
   * NOT routed through StreamFanout — `type: 'props_update'` is a
   * distinct WebSocket message type, not a stream envelope. Stream
   * envelopes flow on `data` frames and have a `seq` cursor; props
   * updates are ephemeral and follow `notifyRenderCommit`'s pattern
   * (live-only, no replay-buffer stamping). A new subscriber that
   * connects mid-render reads current `props` from the render
   * snapshot delivered in `ack.render`.
   *
   * Schema validation against `propsSpec`: NOT enforced server-side
   * here. The renderer validates inbound props via
   * `validateInboundPropsPayload` against the cached
   * `render.propsSpec` before applying — defense-in-depth at the
   * receiving boundary. Server-side enforcement is reserved for the
   * future agent-driven `ggui_update` path; the mount-tool seam is
   * trusted-runtime today (mounts execute in-process, same trust
   * boundary as ggui-native handlers).
   */
  sendPropsUpdate(renderId: string, props: JsonObject): Promise<void>;
  /**
   * Fan a `{type:'drain_ack', payload:{renderId, appId, renderId,
   * eventId, drainedAt}}` wire frame to every subscriber currently
   * bound to `renderId`.
   *
   * Fired by `createGguiConsumeHandler` once per drained
   * `PendingEvent` so the iframe-runtime can cancel the matching
   * per-action 10s claim timer + resolve the toast as `consumed`.
   * Implements the `DrainAckNotifier` contract from
   * `@ggui-ai/mcp-server-handlers`.
   *
   * Same posture as `notifyRenderCommit` / `sendPropsUpdate` — live-only,
   * no replay-buffer stamping. Subscribers that connect AFTER the
   * drain see the next consume's snapshot rather than the missed
   * frame; the iframe's claim timer + atomic-pop primitive backstop
   * any frame loss.
   */
  sendDrainAck(args: {
    readonly renderId: string;
    readonly appId: string;
    readonly eventId: string;
    readonly drainedAt: string;
  }): void;
  /**
   * Fan a server-frame to every local WS subscriber bound to
   * `renderId`. Skips replay-buffer stamping, RenderStore lookups,
   * and contract validation — the caller is the one that originally
   * validated + persisted the underlying mutation. This surface is the
   * cloud adapter's path for delivering already-validated frames that
   * arrived via an external pubsub layer (Redis from another pod).
   *
   * Internal adapter use only. NOT part of the published ggui
   * protocol, NOT stable across versions, NOT exposed to MCP / wire
   * callers. The publisher is responsible for ensuring `frame` is
   * wire-valid; this method does not re-validate.
   *
   * No-op when no local subscriber is bound to `renderId`. Closed
   * sockets are skipped silently by the underlying `send()` helper —
   * same posture as `sendPropsUpdate` / `notifyRenderCommit`. Per-
   * subscriber send failures are logged but never propagated.
   */
  externalBroadcast(renderId: string, frame: WebSocketMessage): void;
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
 * Raised by `invokeWithTimeout` when a wired-tool call exceeds its
 * per-call budget. Internal — surfaces as a `TOOL_TIMEOUT` code on
 * {@link ContractErrorPayload} before the caller sees any channel
 * output.
 */
class WiredToolTimeoutError extends Error {
  readonly toolName: string;
  readonly timeoutMs: number;
  constructor(toolName: string, timeoutMs: number) {
    super(`Wired tool '${toolName}' did not complete within ${timeoutMs}ms`);
    this.name = "WiredToolTimeoutError";
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Build an OSS live-channel server. The returned object is designed to be
 * composed into `createGguiServer` — see `server.ts` for the wire-up.
 */
export function createRenderChannelServer(opts: RenderChannelOptions): RenderChannelServer {
  const path = opts.path ?? DEFAULT_RENDER_CHANNEL_PATH;
  // Outbound stream buffer — owns seq assignment + bounded replay
  // storage. Default is in-memory; operators swap via `opts.streamBuffer`.
  const streamBuffer: SessionStreamBuffer = opts.streamBuffer ?? new InMemorySessionStreamBuffer();
  // Live-tail pub/sub. Default in-process; hosted binds RedisPubSubFanout.
  const streamFanout: StreamFanout = opts.streamFanout ?? new InProcessStreamFanout();
  // `causedBy` sanitizer applied to every contract-error emission.
  // Defaults to the protocol's pattern-based redactor (Bearer tokens,
  // query-param secrets, env-var dumps, 2 KB truncation). Operators
  // pass their own to tighten or broaden coverage.
  const sanitize: SanitizeCausedBy = opts.sanitizeCausedBy ?? defaultSanitizeCausedBy;
  // Operational telemetry — default no-op. Fires `wired-tool.invoked`
  // on every successful wired-action dispatch (C12); future sites
  // (refresh-stream success / failure counts) reuse the same sink.
  const telemetry: TelemetrySink = opts.telemetry ?? new NoopTelemetrySink();

  // Channel-subscribe local-tool poll plumbing. Resolved once
  // at composition so the `channel_subscribe` handler doesn't pay the
  // option-spread cost per request. Absent ⇒ all channel subscribes
  // reject with `CHANNEL_NOT_LOCAL`.
  const localTools: RenderChannelLocalToolsOptions | undefined = opts.streamWebSocketLocalTools;
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
   * RenderChannelOptions.onFirstSubscriber} / `onLastSubscriberGone`
   * 0↔1 transition hooks used by cloud adapters for per-render
   * cross-pod pub/sub channel scoping. Distinct from the
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
        renderId: sub.renderId,
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
    const prevCount = renderCountById.get(sub.renderId) ?? 0;
    renderCountById.set(sub.renderId, prevCount + 1);
    if (prevCount === 0 && opts.onFirstSubscriber) {
      try {
        opts.onFirstSubscriber(sub.renderId);
      } catch (err) {
        // Best-effort: a thrown hook MUST NOT corrupt the
        // wsSubscribers set vs the real socket lifecycle.
        opts.logger.warn("render_channel_on_first_subscriber_threw", {
          renderId: sub.renderId,
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
    const prevCount = renderCountById.get(sub.renderId) ?? 0;
    if (prevCount <= 1) {
      renderCountById.delete(sub.renderId);
      if (prevCount === 1 && opts.onLastSubscriberGone) {
        try {
          opts.onLastSubscriberGone(sub.renderId);
        } catch (err) {
          opts.logger.warn("render_channel_on_last_subscriber_gone_threw", {
            renderId: sub.renderId,
            error: String(err),
          });
        }
      }
    } else {
      renderCountById.set(sub.renderId, prevCount - 1);
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
   * Shared tenancy guard for client-emitted observation messages
   * (`host_context_observed`, `canvas_navigated`). Returns `false`
   * AND emits the appropriate error frame when:
   *
   *   - the socket has no bound subscriber (NOT_SUBSCRIBED)
   *   - payload.renderId doesn't match the subscriber binding
   *     (RENDER_MISMATCH)
   *
   * Subscriber binding is the authoritative tenancy scope. The wire
   * payload's renderId is belt-and-suspenders so the error message
   * can be specific; appId narrows transparently via the binding.
   */
  function checkSubscriberTenancy(
    ws: WebSocket,
    sub: Subscriber | undefined,
    payload: { readonly renderId?: string },
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
    if (payload.renderId !== sub.renderId) {
      sendError(
        ws,
        "RENDER_MISMATCH",
        `${messageType} payload id '${payload.renderId ?? "<missing>"}' does not match subscriber render '${sub.renderId}'`,
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
  async function applyRenderPatch(
    renderId: string,
    appId: string,
    messageType: string,
    patch: RenderPatch
  ): Promise<void> {
    try {
      await opts.renderStore.update(renderId, patch);
    } catch (err) {
      opts.logger.warn("render_channel_observation_persist_failed", {
        messageType,
        renderId,
        appId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Emit a `channel_error` frame to a specific subscriber. Used by the
   * `channel_subscribe` handler for both subscribe-time rejections
   * (`CHANNEL_UNKNOWN`, `CHANNEL_NOT_LOCAL`, `RENDER_NOT_FOUND`,
   * `SUBSCRIBE_UNAUTHORIZED`) AND poll-time failures (`POLL_FAILED`).
   *
   * Direct-to-WS, not via fanOut — channel_error frames are
   * per-subscriber and not stored in the replay buffer. A new
   * subscriber on the same render will re-subscribe and discover the
   * same error itself.
   */
  function sendChannelError(
    ws: WebSocket,
    renderId: string,
    channelName: string,
    code:
      | "CHANNEL_UNKNOWN"
      | "CHANNEL_NOT_LOCAL"
      | "RENDER_NOT_FOUND"
      | "SUBSCRIBE_UNAUTHORIZED"
      | "POLL_FAILED",
    message: string,
    requestId?: string,
    details?: ErrorPayload["details"]
  ): void {
    send(ws, {
      type: "channel_error",
      payload: {
        renderId,
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
          renderId: sub.renderId,
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
        sub.renderId,
        state.channelName,
        "POLL_FAILED",
        err instanceof Error ? err.message : String(err),
        undefined,
        // causedBy slot — sanitized for credential safety in the same
        // posture as wired-tool's TOOL_THREW emission.
        sanitize(err instanceof Error ? (err.stack ?? err.message) : String(err))
      );
      opts.logger.warn("render_channel_channel_poll_failed", {
        renderId: sub.renderId,
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
   * `${renderId}:${channelName}` — a re-subscribe replaces any
   * existing interval rather than running two in parallel.
   */
  async function handleChannelSubscribe(
    ws: WebSocket,
    sub: Subscriber,
    message: WebSocketMessage & { type: "channel_subscribe" }
  ): Promise<void> {
    const payload = message.payload;
    // renderId match — the spoof guard at every wire-input boundary.
    // A subscriber bound to render A can't drive a subscribe for
    // render B even if they crafted the inbound payload.
    if (payload.renderId !== sub.renderId) {
      sendChannelError(
        ws,
        payload.renderId,
        payload.channelName,
        "SUBSCRIBE_UNAUTHORIZED",
        `Subscriber is bound to render '${sub.renderId}' but channel_subscribe targets '${payload.renderId}'`,
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
        payload.renderId,
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
    const stored = await opts.renderStore.get(payload.renderId);
    if (!stored || stored.id !== sub.renderId) {
      sendChannelError(
        ws,
        payload.renderId,
        payload.channelName,
        "RENDER_NOT_FOUND",
        `Render '${payload.renderId}' not found on subscriber '${sub.renderId}'`,
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
        payload.renderId,
        payload.channelName,
        "CHANNEL_UNKNOWN",
        `streamSpec['${payload.channelName}'] not declared OR has no source.tool on render '${payload.renderId}'`,
        message.requestId
      );
      return;
    }
    const sourceTool = channelEntry.source.tool;
    if (!localToolsAllowlist.has(sourceTool)) {
      sendChannelError(
        ws,
        payload.renderId,
        payload.channelName,
        "CHANNEL_NOT_LOCAL",
        `source.tool '${sourceTool}' is not in streamWebSocketLocalTools; iframe must poll directly`,
        message.requestId
      );
      return;
    }

    // Validation passed — schedule (or re-schedule) the polling loop.
    const channelKey = `${payload.renderId}:${payload.channelName}`;
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
      renderId: payload.renderId,
      channelName: payload.channelName,
      args: mergedArgs,
      seq: 0,
      timer,
    };
    sub.channelSubs.set(channelKey, state);
    opts.logger.info("render_channel_channel_subscribe", {
      renderId: sub.renderId,
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
    if (payload.renderId !== sub.renderId) {
      // No-op silently — the canonical "spoof guard" code path is in
      // channel_subscribe; unsubscribe gets no error frame to avoid
      // leaking cross-render existence.
      return;
    }
    const channelKey = `${payload.renderId}:${payload.channelName}`;
    const existing = sub.channelSubs.get(channelKey);
    if (!existing) return;
    clearInterval(existing.timer);
    sub.channelSubs.delete(channelKey);
    opts.logger.info("render_channel_channel_unsubscribe", {
      renderId: sub.renderId,
      appId: sub.appId,
      channelName: payload.channelName,
    });
  }

  /**
   * Stamp a delivery through the replay buffer and fan it out to every
   * subscriber of the render, honoring the per-subscriber replay
   * cursor. Shared by the public `sendToRender` entry point AND by
   * the wiredActionRouter's refresh/error emissions — extracting this
   * avoids duplicating the seq-stamp + subscriber-iteration logic in
   * two places.
   *
   * Caller is responsible for validating `delivery.payload` against
   * the active streamSpec BEFORE calling — the fan-out here trusts
   * its input. Reserved-channel emissions (e.g. `_ggui:contract-
   * error`) bypass the streamSpec check upstream via
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
    // because publish() never throws on the in-process impl, and a hosted
    // RedisPubSubFanout failure here would already be persisted to the
    // SessionStreamBuffer for replay-recovery on reconnect.
    void streamFanout.publish({ renderId: envelope.renderId, envelope });
    return { seq: envelope.seq };
  }

  /**
   * Emit a canonical {@link ContractErrorPayload} on the reserved
   * `_ggui:contract-error` channel. Never throws — the wiredActionRouter
   * dispatch path calls this from `catch` branches; a second failure
   * would be a footgun.
   */
  function emitContractError(
    renderId: string,
    activeStreamSpec: StreamSpec | undefined,
    payload: ContractErrorPayload
  ): void {
    try {
      // Central stamp — re-emit through makeContractErrorPayload so
      // every contract-error envelope carries the current stamped
      // schemaVersion regardless of which dispatch branch produced
      // `payload`. Byte-equivalent to the pre-Item-1 inline stamp
      // (`{...payload, schemaVersion: PROTOCOL_SCHEMA_VERSION}`) which
      // also always clobbered to the current version — the local
      // dispatch paths never forward pre-stamped payloads, so any
      // incoming schemaVersion on `payload` is discarded by design.
      const stamped = makeContractErrorPayload({
        toolName: payload.toolName,
        error: payload.error,
        timestamp: payload.timestamp,
        ...(payload.actionName !== undefined ? { actionName: payload.actionName } : {}),
        ...(payload.sourceAction !== undefined ? { sourceAction: payload.sourceAction } : {}),
      });
      // Fire-and-forget: emitContractError is called from sync `catch`
      // branches and a second async failure here would be a footgun.
      // Promise rejection logs but doesn't propagate; the seam contract
      // says publish never throws on InProcess impl, and a hosted
      // RedisPubSubFanout failure is recoverable via replay-on-reconnect.
      void fanOut(
        {
          renderId,
          channel: CONTRACT_ERROR_CHANNEL,
          mode: "append",
          payload: stamped as unknown as StreamEnvelopeInput["payload"],
        },
        activeStreamSpec
      ).catch((err) => {
        opts.logger.error("render_channel_contract_error_emit_failed", {
          renderId,
          toolName: payload.toolName,
          code: payload.error.code,
          error: String(err),
        });
      });
    } catch (err) {
      opts.logger.error("render_channel_contract_error_emit_failed", {
        renderId,
        toolName: payload.toolName,
        code: payload.error.code,
        error: String(err),
      });
    }
  }

  /**
   * Race a wired-tool invocation against a timeout. On timeout, the
   * underlying promise is abandoned (we do NOT cancel the tool —
   * handlers are trusted to clean up their own resources) but the
   * caller sees a {@link WiredToolTimeoutError} and emits
   * `TOOL_TIMEOUT`.
   */
  async function invokeWithTimeout(
    router: WiredActionRouter,
    toolName: string,
    // Accepts either a validated wired-action payload (Record) OR the
    // typed empty refresh input ({@link RefreshInput} /
    // {@link EMPTY_REFRESH_INPUT}). The two call sites upstream are
    // the only producers; nothing else should widen this.
    input: Record<string, unknown> | RefreshInput,
    ctx: WiredActionContext,
    timeoutMs: number
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        router.invoke(toolName, input, ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new WiredToolTimeoutError(toolName, timeoutMs));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Internal impl behind the public {@link RenderChannelServer.sendPropsUpdate}.
   * Extracted as a closure-level function so the wired-action dispatcher
   * can build a `WiredActionContext.sendPropsUpdate` that closes over the
   * same logic without forward-referencing the returned object. Best-
   * effort + orphan-tolerant per the docstring on the public method.
   */
  async function sendPropsUpdateImpl(renderId: string, props: JsonObject): Promise<void> {
    let stored;
    try {
      stored = await opts.renderStore.get(renderId);
    } catch (err) {
      opts.logger.warn("render_channel_props_update_lookup_failed", {
        renderId,
        error: String(err),
      });
      return;
    }
    if (!stored) {
      opts.logger.warn("render_channel_props_update_orphan", {
        renderId,
      });
      return;
    }
    // Filter the flat WS-subscriber set by renderId; same posture as
    // `notifyRenderCommit`. `send()` already silently skips closed sockets
    // and logs (but doesn't throw on) per-subscriber send failures, so
    // the caller's mount-handler path can't be made to fail by a dead
    // WebSocket.
    for (const sub of wsSubscribers) {
      if (sub.renderId !== renderId) continue;
      send(sub.ws, {
        type: "props_update",
        payload: { renderId, props },
      });
    }
  }

  /**
   * Dispatch a wired action after inbound validation has passed.
   * Called synchronously inside `handleInboundAction` — the caller
   * awaits so the UI's ack arrives AFTER any refresh-stream frames
   * land (honest ordering: "when you see the ack, your action
   * completed + the screen reflects it").
   *
   * No-ops when:
   *   - no wiredActionRouter is configured on this channel
   *   - the action didn't resolve to a tool name (plain agent-routed
   *     action that we persist + forward as-is)
   *   - the resolved tool isn't registered (emits `TOOL_NOT_FOUND`)
   *
   * On successful tool invocation, every declared channel on the
   * active render's streamSpec with a `tool` refresh hint fires
   * that tool + emits its return value on the channel. Refresh tools
   * are invoked with an empty argument object (`{}`); authors who
   * need filter args should inline the action + refresh into a single
   * tool that returns the new state.
   */
  async function dispatchWiredAction(
    stored: { id: string },
    activeItem: Render | undefined,
    envelope: ActionEnvelope,
    dispatchedAt: string
  ): Promise<void> {
    const render = stored;
    const router = opts.wiredActionRouter;
    if (!router || !activeItem || envelope.type !== "data:submit") return;

    const payload = envelope.payload as ActionEventValue | undefined;
    if (!payload || typeof payload.action !== "string") return;

    // Disagreement policy — the server-side enforcement point for the
    // `client wins` rule documented on `ActionEventValue.tool`. Prefer
    // the envelope's client-populated `tool` (useAction fills it from
    // the same contract lookup the server would redo). Fall back to the
    // actionSpec declaration so a client that omits the wire hint still
    // gets the expected routing. If the two disagree, client wins — the
    // client is the source of truth for what the user actually saw.
    // Cross-validation against the agent's tracked contract happens on
    // the agent-SDK side, not here.
    // actionSpec / streamSpec only exist on ComponentRender. The
    // mcpApps / system variants narrow them to undefined.
    const componentItem =
      activeItem.type === "mcpApps" || activeItem.type === "system" ? undefined : activeItem;
    const actionEntry = componentItem?.actionSpec?.[payload.action];
    const serverDeclaredTool = actionEntry?.nextStep;
    const declaredTool =
      (typeof payload.tool === "string" && payload.tool.length > 0 ? payload.tool : undefined) ??
      serverDeclaredTool;
    if (!declaredTool) return;

    const actionName = payload.action;
    const input =
      payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? (payload.data as Record<string, unknown>)
        : {};
    const timeoutMs = opts.wiredActionTimeoutMs ?? DEFAULT_WIRED_TOOL_TIMEOUT_MS;
    const streamSpec = componentItem?.streamSpec;

    if (!router.has(declaredTool)) {
      emitContractError(render.id, streamSpec, {
        toolName: declaredTool,
        actionName,
        sourceAction: { type: "wired-action", dispatchedAt },
        error: {
          code: "TOOL_NOT_FOUND",
          message: `wiredActionRouter has no handler for tool '${declaredTool}'`,
        },
        timestamp: new Date().toISOString(),
      });
      opts.logger.warn("render_channel_wired_tool_not_found", {
        renderId: render.id,
        toolName: declaredTool,
        actionName,
      });
      return;
    }

    // Build the wired-action context the router hands the mount tool.
    // `sendPropsUpdate` closes over the active
    // `render.id` so a buggy mount can't accidentally cross-deliver to
    // another render by passing a foreign renderId. The same ctx is
    // reused for the refresh-stream pass below — a refresh tool that
    // wants to fire props_update can do so, though the canonical site
    // is the action tool itself.
    const wiredCtx: WiredActionContext = {
      renderId: render.id,
      sendPropsUpdate(props) {
        void sendPropsUpdateImpl(render.id, props);
      },
    };

    const invokeStartedAt = Date.now();
    try {
      await invokeWithTimeout(router, declaredTool, input, wiredCtx, timeoutMs);
    } catch (err) {
      const code: ContractErrorCode =
        err instanceof WiredToolTimeoutError ? "TOOL_TIMEOUT" : "TOOL_THREW";
      emitContractError(render.id, streamSpec, {
        toolName: declaredTool,
        actionName,
        sourceAction: { type: "wired-action", dispatchedAt },
        error: {
          code,
          message: err instanceof Error ? err.message : String(err),
          ...(err instanceof Error && err.stack ? { causedBy: sanitize(err.stack) } : {}),
        },
        timestamp: new Date().toISOString(),
      });
      opts.logger.warn("render_channel_wired_tool_failed", {
        renderId: render.id,
        toolName: declaredTool,
        actionName,
        code,
        error: String(err),
      });
      return;
    }

    // Operational telemetry — record the successful dispatch. Lossy
    // by contract (TelemetrySink.emit is sync + non-throwing); a bad
    // sink MUST NOT block the refresh pass. Attribute set is kept
    // flat + primitive-only per TelemetryEvent.attributes shape.
    telemetry.emit({
      name: "wired-tool.invoked",
      at: Date.now(),
      attributes: {
        toolName: declaredTool,
        actionName,
        renderId: render.id,
        latencyMs: Date.now() - invokeStartedAt,
      },
    });

    // Refresh pass — every declared channel with a `tool` hint fires a
    // fresh read and emits the result on that channel. Each refresh
    // tool gets its own timeout + isolation: one broken refresh MUST
    // NOT block others from completing.
    if (!streamSpec) return;
    for (const [channelName, channelEntry] of Object.entries(streamSpec)) {
      const refreshTool = channelEntry?.tool;
      if (!refreshTool) continue;

      if (!router.has(refreshTool)) {
        emitContractError(render.id, streamSpec, {
          toolName: refreshTool,
          actionName,
          sourceAction: { type: "refresh-stream", dispatchedAt },
          error: {
            code: "TOOL_NOT_FOUND",
            message: `wiredActionRouter has no handler for refresh tool '${refreshTool}' (channel '${channelName}')`,
          },
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      let output: unknown;
      try {
        // Refresh input is v1-locked to the empty shape via
        // EMPTY_REFRESH_INPUT. DO NOT replace with an inline `{}`
        // literal — the named constant is what keeps this contract
        // grep-able and future-proofs v2 evolution (see
        // {@link RefreshInput}).
        output = await invokeWithTimeout(
          router,
          refreshTool,
          EMPTY_REFRESH_INPUT,
          wiredCtx,
          timeoutMs
        );
      } catch (err) {
        const code: ContractErrorCode =
          err instanceof WiredToolTimeoutError ? "TOOL_TIMEOUT" : "TOOL_THREW";
        emitContractError(render.id, streamSpec, {
          toolName: refreshTool,
          actionName,
          sourceAction: { type: "refresh-stream", dispatchedAt },
          error: {
            code,
            message: err instanceof Error ? err.message : String(err),
            ...(err instanceof Error && err.stack ? { causedBy: sanitize(err.stack) } : {}),
          },
          timestamp: new Date().toISOString(),
        });
        opts.logger.warn("render_channel_refresh_tool_failed", {
          renderId: render.id,
          toolName: refreshTool,
          channel: channelName,
          code,
          error: String(err),
        });
        continue;
      }

      try {
        assertStreamContract(streamSpec, channelName, output, opts.extraReservedValidators);
      } catch (err) {
        if (err instanceof ContractViolationError) {
          emitContractError(render.id, streamSpec, {
            toolName: refreshTool,
            actionName,
            sourceAction: { type: "refresh-stream", dispatchedAt },
            error: {
              code: "SCHEMA_VIOLATION",
              message: err.message,
            },
            timestamp: new Date().toISOString(),
          });
          opts.logger.warn("render_channel_refresh_schema_violation", {
            renderId: render.id,
            toolName: refreshTool,
            channel: channelName,
            violations: err.violations,
          });
          continue;
        }
        throw err;
      }

      try {
        await fanOut(
          {
            renderId: render.id,
            channel: channelName,
            mode: channelEntry?.mode ?? "append",
            payload: output as StreamEnvelopeInput["payload"],
          },
          streamSpec
        );
      } catch (err) {
        // fanOut swallows per-subscriber transport errors; a throw here
        // is buffer-internal (e.g., record() invariant violation). Log
        // but don't propagate — a single broken channel must not take
        // down the render.
        opts.logger.error("render_channel_refresh_emit_failed", {
          renderId: render.id,
          toolName: refreshTool,
          channel: channelName,
          error: String(err),
        });
      }
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
    // `POST /ggui/console/render-cookie` and we do want to
    // reject the upgrade cleanly (HTTP 401 → browser WS error) when
    // the cookie is stale/missing, not carry a doomed handshake into
    // subscribe where the error surface is worse.
    //
    // On success, we stash the bound `{renderId, appId}` on the
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
              __gguiCookieBound?: { renderId: string; appId: string };
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
   * no-ops when no `ComponentRender` is active).
   */
  function resolveActiveRender(render: Render | undefined): Render | undefined {
    if (!render) return undefined;
    if (render.type === "mcpApps" || render.type === "system") return undefined;
    return render;
  }

  /**
   * Handle an inbound `action` message — the canonical flat
   * {@link ActionEnvelope} shape.
   *
   * Two-step enforcement: (1) allowlist via {@link assertEventAllowed}
   * against the active render's subscription allowlist (Phase B: no-op
   * stub — Render no longer carries `subscription.events`); (2)
   * actionSpec payload check via {@link assertActionContract} for
   * `data:submit` types. Both helpers are shared with the hosted
   * `handle-action.ts` ingress.
   */
  async function handleInboundAction(
    ws: WebSocket,
    sub: Subscriber,
    message: WebSocketMessage & { type: "action" }
  ): Promise<void> {
    const envelope: ActionEnvelope = message.payload;

    // Spoof guard — envelope.renderId is REQUIRED on the wire and
    // MUST match the subscriber's bound render.
    if (envelope.renderId !== sub.renderId) {
      sendError(
        ws,
        "RENDER_MISMATCH",
        `Action targets render '${envelope.renderId}' but this socket is subscribed to '${sub.renderId}'`,
        message.requestId
      );
      return;
    }

    const stored = await opts.renderStore.get(sub.renderId);
    if (!stored) {
      sendError(
        ws,
        "RENDER_NOT_FOUND",
        `Render ${sub.renderId} no longer exists`,
        message.requestId
      );
      return;
    }

    // Phase B: a render IS the addressable unit. The prior stack
    // routing (stackIndex / cross-stack pickIds) collapses — the
    // resolved render itself is the active item.
    const activeItem = resolveActiveRender(stored.render);

    // ── Two-step enforcement ──
    //   1. allowlist via assertEventAllowed (Phase B: no-op stub —
    //      Render no longer carries a `subscription` allowlist;
    //      reinstating per-render event policy is deferred.)
    //   2. actionSpec payload check via assertActionContract (data:submit)
    // Envelope.payload for data:submit carries the ActionEventValue
    // shape (`{action, data?, tool?}`).
    try {
      assertEventAllowed(undefined, envelope.type);
    } catch (err) {
      if (err instanceof EventNotAllowedError) {
        opts.logger.warn("render_channel_event_not_allowed", {
          renderId: sub.renderId,
          envelope: "action",
          error: err.message,
        });
        sendError(ws, "EVENT_NOT_ALLOWED", err.message, message.requestId);
        return;
      }
      throw err;
    }

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
            renderId: sub.renderId,
            violations: err.violations,
            envelope: "action",
          });
          sendError(ws, "CONTRACT_VIOLATION", err.message, message.requestId, err.toErrorData());
          return;
        }
        throw err;
      }
    }

    // Persist the envelope. RenderStore.appendEvent assigns a monotonic
    // seq the client acks back with so reconnects can resume via `fromSeq`.
    const dispatchedAt = new Date().toISOString();
    let seq: number;
    try {
      seq = await opts.renderStore.appendEvent({
        renderId: sub.renderId,
        type: "user.submitted",
        data: envelope,
      });
    } catch (err) {
      opts.logger.error("render_channel_append_failed", {
        renderId: sub.renderId,
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

    // wiredActionRouter — fire any declared action-tool +
    // stream-refresh tools BEFORE acking the user. Honest ordering:
    // when the ack lands, any refresh frames the tool produced have
    // already fanned out, so the client can treat "ack received" as
    // "UI state reflects my action". No-op when no router is
    // configured OR when the action didn't declare a tool.
    //
    // Awaited (not fire-and-forget): dispatchWiredAction internally
    // catches every failure and emits contract-error envelopes; a
    // throw out of this call would be a platform bug and we'd rather
    // see it in tests than silently drop.
    await dispatchWiredAction(stored, activeItem, envelope, dispatchedAt);

    // StreamFanout pump-drain: dispatchWiredAction's internal fanOut
    // calls `streamFanout.publish()` which queues envelopes into the
    // pump's async iterator. The pump's `await iter.next()` resolves
    // on the microtask queue — without this drain, the synchronous
    // `send(ws, ack)` below races ahead of the pump's `send(ws, data)`,
    // and the data-before-ack invariant fails. `setImmediate` waits for
    // the next macrotask, which is strictly after all pending
    // microtasks (the pump iterations) drain. OSS-only invariant —
    // hosted Path A's RedisPubSubFanout can't preserve cross-pod
    // ordering by construction; clients on hosted treat data + ack as
    // independent signals.
    await new Promise<void>((resolve) => setImmediate(resolve));

    send(ws, {
      type: "ack",
      payload: { sequence: seq, timestamp: Date.now() },
      ...(message.requestId ? { requestId: message.requestId } : {}),
    });
  }

  async function handleSubscribe(
    ws: WebSocket,
    identity: AuthResult,
    message: WebSocketMessage & { type: "subscribe" }
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
    // single-use bootstrap token per the RenderChannelBootstrap
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
        renderId: payload.renderId,
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
    let mintedRenderToken: string | undefined;
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
          renderId: payload.renderId,
          appId: payload.appId,
          reason: verifyResult.reason,
        });
        // G14 (2026-05-23): distinguish `expired` from `invalid` so the
        // iframe-side handler can branch on refresh-vs-rehandshake.
        // Tamper / format / kind failures collapse into BOOTSTRAP_INVALID
        // (no refresh path); expired-but-signed envelopes emit the
        // dedicated BOOTSTRAP_EXPIRED so the client knows to call
        // `ggui_runtime_refresh_bootstrap`.
        if (verifyResult.reason === "expired") {
          sendError(
            ws,
            "BOOTSTRAP_EXPIRED",
            "Bootstrap token expired — call ggui_runtime_refresh_bootstrap or re-handshake",
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
      const bound = { renderId: verifyResult.renderId, appId: verifyResult.appId };
      if (bound.renderId !== payload.renderId) {
        sendError(
          ws,
          "BOOTSTRAP_RENDER_MISMATCH",
          `Bootstrap token is bound to render '${bound.renderId}' but subscribe targets '${payload.renderId}'`,
          message.requestId
        );
        return;
      }
      if (bound.appId !== payload.appId) {
        sendError(
          ws,
          "BOOTSTRAP_APP_MISMATCH",
          `Bootstrap token is bound to app '${bound.appId}' but subscribe targets '${payload.appId}'`,
          message.requestId
        );
        return;
      }
      // Synthesize a minimal AuthResult from the bootstrap claims.
      // The subscriber row needs an identity for logging and roster
      // inspection; the bootstrap-derived identity is a first-class
      // citizen for the lifetime of this subscription.
      effectiveIdentity = {
        identity: {
          kind: "user",
          userId: bound.renderId,
          workspaceId: bound.appId,
          roles: [],
        },
        source: "apikey",
      };
      // Mint the reconnect credential now — before create/observe
      // work — so a downstream failure doesn't leave the client with
      // no way to resume.
      mintedRenderToken = opts.bootstrap.issueRenderToken(bound.renderId, bound.appId);
      opts.logger.info("render_channel_bootstrap_accepted", {
        renderId: bound.renderId,
        appId: bound.appId,
      });
    }

    // Dev-mode render provisioning: look up first; if not present,
    // create with the client-provided id via the widened
    // CreateRenderInput.id seam. Matches the hosted model's shape
    // (agent creates via ggui_render → client subscribes) in a single
    // step — production deployments tighten this by supplying an
    // AuthAdapter that mints render-scoped tokens on render.
    let stored = await opts.renderStore.get(payload.renderId);
    if (stored) {
      if (stored.appId !== payload.appId) {
        sendError(
          ws,
          "APP_MISMATCH",
          `Render ${payload.renderId} belongs to a different app`,
          message.requestId
        );
        return;
      }
    } else {
      try {
        stored = await opts.renderStore.create({
          id: payload.renderId,
          appId: payload.appId,
        });
      } catch (err) {
        sendError(
          ws,
          "RENDER_CREATE_FAILED",
          err instanceof Error ? err.message : String(err),
          message.requestId
        );
        return;
      }
    }

    // Snapshot the outbound-stream cursor BEFORE registering the
    // subscriber. Any concurrent producer that calls sendToRender
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
      renderId: stored.id,
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
      renderId: stored.id,
      appId: stored.appId,
      identityKind: effectiveIdentity.identity.kind,
      fromSeq: payload.fromSeq,
      snapshotSeq,
      replayCount: replay?.envelopes.length ?? 0,
      replayTruncated: replay?.truncated ?? false,
      bootstrap: mintedRenderToken !== undefined,
    });

    const ackPayload: AckPayload = {
      sequence: stored.eventSequence,
      timestamp: Date.now(),
      render: stored.render,
      streamSeq: snapshotSeq,
      // Advertise the server's protocol version on every successful
      // subscribe ack (SPEC §11.2.2). Clients whose
      // CLIENT_SUPPORTED_VERSIONS doesn't contain this string surface
      // UpgradeRequiredError to their caller; clients that don't wire
      // the handshake ignore the field (legacy-pass-through).
      serverVersion: PROTOCOL_SCHEMA_VERSION,
      ...(replay?.truncated ? { replayTruncated: true } : {}),
      ...(mintedRenderToken !== undefined ? { renderToken: mintedRenderToken } : {}),
    };
    send(ws, {
      type: "ack",
      payload: ackPayload,
      ...(message.requestId ? { requestId: message.requestId } : {}),
    });

    // R7 — RenderEvent ledger replay. When `payload.sinceSequence` is
    // present, fetch events with `seq > sinceSequence` from the per-
    // render ledger and emit each as a `render_event` wire frame
    // BEFORE the per-channel stream-buffer replay. Consumers dispatch
    // by `event.type` to fold the wire-frame-equivalent handler
    // (render/props_update/etc.) — same cursor model as the HTTP
    // `/api/renders/:id/events?sinceSequence=N` endpoint.
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
          // Render disappeared between resolve and ledger read —
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
            // RenderEvent is now the wire-shape ledger primitive
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
          if (message.payload.renderId !== cookieBound.renderId) {
            sendError(
              ws,
              "DEVTOOL_COOKIE_RENDER_MISMATCH",
              `Embedded-ui cookie is bound to render '${cookieBound.renderId}' but subscribe targets '${message.payload.renderId}'`,
              message.requestId
            );
            return;
          }
          if (message.payload.appId !== cookieBound.appId) {
            sendError(
              ws,
              "DEVTOOL_COOKIE_APP_MISMATCH",
              `Embedded-ui cookie is bound to app '${cookieBound.appId}' but subscribe targets '${message.payload.appId}'`,
              message.requestId
            );
            return;
          }
        }
        await handleSubscribe(ws, identity, message);
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
        // on `Render.hostContext` so `ggui_handshake` and
        // `ggui_consume` can surface it to the agent on subsequent
        // turns. Fire-and-forget on the client side; no response.
        if (!checkSubscriberTenancy(ws, sub, message.payload, message.type, message.requestId)) {
          return;
        }
        await applyRenderPatch(sub.renderId, sub.appId, message.type, {
          hostContext: message.payload.hostContext,
          lastActivityAt: Date.now(),
        });
        return;
      case "feedback":
        // Require an active subscription for operational messages.
        if (!sub) {
          sendError(
            ws,
            "NOT_SUBSCRIBED",
            `Send a 'subscribe' message first before '${message.type}'`,
            message.requestId
          );
          return;
        }
        // These OSS channel handlers land incrementally once the
        // matching shared handlers exist in @ggui-ai/mcp-server-handlers.
        // For now the ingress point is documented but rejected with a
        // clear code so clients don't assume silent success.
        sendError(
          ws,
          "NOT_IMPLEMENTED",
          `'${message.type}' not yet handled on the OSS channel server`,
          message.requestId
        );
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
   * `handleSubscribe` enforces `subscribe.renderId === bound.renderId`
   * so a valid cookie can't be used to open a render it wasn't
   * issued for. Parallel to {@link pendingIdentity} — same lifetime,
   * same WeakMap rationale.
   */
  const pendingCookieBinding = new WeakMap<WebSocket, { renderId: string; appId: string }>();

  wss.on("connection", (ws, req) => {
    // Bind the resolved identity from the upgrade phase. It was
    // attached to the request object in handleUpgrade.
    const identity = (req as IncomingMessage & { __gguiIdentity?: AuthResult }).__gguiIdentity;
    if (identity) pendingIdentity.set(ws, identity);
    // Likewise for any cookie binding.
    const cookieBound = (
      req as IncomingMessage & {
        __gguiCookieBound?: { renderId: string; appId: string };
      }
    ).__gguiCookieBound;
    if (cookieBound) pendingCookieBinding.set(ws, cookieBound);

    ws.on("message", (raw) => {
      // `ws.on('message')` delivers Buffer/ArrayBuffer/Buffer[] depending
      // on frame type; normalize to string.
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      onMessage(ws, text).catch((err) => {
        opts.logger.error("render_channel_message_failed", {
          error: String(err),
        });
      });
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
    async sendToRender(delivery) {
      // Outbound fan-out enforcement (defense-in-depth parity with
      // hosted `handle-data.ts`). Re-validates the delivery's payload
      // against the render's streamSpec BEFORE delivery — so a future
      // OSS mutation handler that bypasses the emit-side check can't
      // fan out malformed data to subscribers. Throws
      // ContractViolationError{tool:'ggui_emit'} on violation;
      // caller decides what to do (log, rethrow, wrap).
      const stored = await opts.renderStore.get(delivery.renderId);
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
    notifyRenderCommit(renderId, render, matchType) {
      // Best-effort fan-out to every live subscriber bound to this
      // render. NOT routed through the replay buffer — see the
      // `notifyRenderCommit` JSDoc on the interface for why fresh
      // subscribers rely on `ack.render` instead of a replay frame.
      // NOT routed through StreamFanout either — `type: 'render'` is a
      // distinct WebSocket message type. Filter the flat WS-subscriber
      // set by renderId; N is typically 1-2 (multi-tab render sharing).
      const payload = matchType !== undefined ? { render, matchType } : { render };
      for (const sub of wsSubscribers) {
        if (sub.renderId !== renderId) continue;
        send(sub.ws, { type: "render", payload });
      }
    },
    async primeStreams(renderId, render) {
      const router = opts.wiredActionRouter;
      const streamSpec = "streamSpec" in render ? render.streamSpec : undefined;
      if (!router || !streamSpec) return;
      const timeoutMs = opts.wiredActionTimeoutMs ?? DEFAULT_WIRED_TOOL_TIMEOUT_MS;
      // Build the same wired-action ctx the dispatcher uses.
      // Prime-time invocations reuse the seam so a refresh tool that
      // fires `sendPropsUpdate` on cold-start works the same way as
      // one fired post-action.
      const wiredCtx: WiredActionContext = {
        renderId,
        sendPropsUpdate(props) {
          void sendPropsUpdateImpl(renderId, props);
        },
      };
      for (const [channelName, channelEntry] of Object.entries(streamSpec)) {
        const refreshTool = channelEntry?.tool;
        if (!refreshTool) continue;
        if (!router.has(refreshTool)) {
          opts.logger.warn("render_channel_prime_tool_not_found", {
            renderId,
            toolName: refreshTool,
            channel: channelName,
          });
          continue;
        }
        let output: unknown;
        try {
          output = await invokeWithTimeout(
            router,
            refreshTool,
            EMPTY_REFRESH_INPUT,
            wiredCtx,
            timeoutMs
          );
        } catch (err) {
          opts.logger.warn("render_channel_prime_tool_failed", {
            renderId,
            toolName: refreshTool,
            channel: channelName,
            error: String(err),
          });
          continue;
        }
        try {
          assertStreamContract(streamSpec, channelName, output, opts.extraReservedValidators);
        } catch (err) {
          opts.logger.warn("render_channel_prime_schema_violation", {
            renderId,
            toolName: refreshTool,
            channel: channelName,
            error: String(err),
          });
          continue;
        }
        try {
          await fanOut(
            {
              renderId,
              channel: channelName,
              mode: channelEntry?.mode ?? "append",
              payload: output as StreamEnvelopeInput["payload"],
            },
            streamSpec
          );
        } catch (err) {
          opts.logger.error("render_channel_prime_emit_failed", {
            renderId,
            toolName: refreshTool,
            channel: channelName,
            error: String(err),
          });
        }
      }
    },
    sendPropsUpdate(renderId, props) {
      // Public entry point — delegates to the closure-level impl that
      // the wired-action dispatcher's `WiredActionContext.sendPropsUpdate`
      // also calls. Returns the impl's promise so the caller can await
      // store-lookup completion if desired (the wiredCtx call site
      // fire-and-forgets via `void`).
      return sendPropsUpdateImpl(renderId, props);
    },
    sendDrainAck({ renderId, appId, eventId, drainedAt }) {
      // Server-side fan-out for the action-drain ack.
      // Filter the flat WS-subscriber set by renderId (same posture
      // as `sendPropsUpdate`). No persistence; subscribers that
      // missed the frame fall back to their 10s claim timer, which
      // the atomic pop resolves cleanly.
      for (const sub of wsSubscribers) {
        if (sub.renderId !== renderId) continue;
        send(sub.ws, {
          type: "drain_ack",
          payload: { renderId, appId, eventId, drainedAt },
        });
      }
    },
    externalBroadcast(renderId, frame) {
      // Walk the flat subscriber set; filter to matching renderId.
      // `send()` already guards closed sockets and logs (but doesn't
      // throw on) per-subscriber failures, so the caller (a cloud
      // pubsub on-message handler) can't be made to fail by a dead
      // WebSocket. No RenderStore lookup — the publisher already
      // validated; this seam is the cross-pod delivery path, not the
      // re-validation point.
      for (const sub of wsSubscribers) {
        if (sub.renderId !== renderId) continue;
        send(sub.ws, frame);
      }
    },
    get subscriberCount() {
      return wsSubscribers.size;
    },
    get renderCount() {
      // Distinct render count across live WS subscribers. With
      // multi-tab clients, two subscribers may share a renderId —
      // dedupe before counting.
      const renders = new Set<string>();
      for (const sub of wsSubscribers) renders.add(sub.renderId);
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
      const renderIds = new Set<string>();
      for (const sub of wsSubscribers) {
        renderIds.add(sub.renderId);
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
        Array.from(renderIds, (renderId) =>
          streamFanout.close(renderId).catch(() => {
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

/** Fabricate a request id for live-channel ops so logs correlate. */
export function newRequestId(): string {
  return randomUUID();
}
