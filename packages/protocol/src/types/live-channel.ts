/**
 * Live-channel contract payload types.
 *
 * The live channel is the live session plane between core-mcp and the
 * user. The types in this file describe WHAT that plane talks about —
 * the payload shapes for each exchange, independent of how they're
 * framed on the wire.
 *
 * The transport envelope (discriminated union + discriminator enum +
 * connection-status enum) lives behind the
 * `@ggui-ai/protocol/transport/websocket` subpath so only transport
 * implementors pay its type/build cost. Consumers that only need
 * contract shapes stay on the root import.
 *
 * The corresponding inbound user-action envelope ({@link ActionEnvelope})
 * lives in `types/events.ts` alongside the event-type enum.
 */
import type { InterfaceContext } from './interface-context';
import type { SessionStackEntry } from './session';
import type {
  DataContract,
  JsonObject,
  JsonSchema,
  JsonValue,
  StreamChannelMode,
} from './data-contract';

/**
 * Payload for subscribe message
 */
export interface SubscribePayload {
  sessionId: string;
  appId: string;
  /** Role of the subscriber: 'user' (Portal) or 'agent' (MCP bridge) */
  role?: 'user' | 'agent';
  /**
   * Resume cursor for live-channel outbound stream replay. When present,
   * the server replays buffered envelopes with `seq > fromSeq` per the
   * active stack item's per-channel replay policy
   * (`streamSpec[name].replay`) BEFORE transitioning to the
   * live tail.
   *
   * Semantics:
   *   - Omitted → fresh subscribe. No replay; client only sees live
   *     tail from the current cursor onward.
   *   - `0` → replay everything the server still retains, subject to
   *     policy and bounded buffer retention (may flag
   *     `replayTruncated` on the ack).
   *   - `N` → replay envelopes with `seq > N`. Use `lastSeenSeq` from
   *     the last envelope the client observed.
   *
   * Honored only by implementations that expose
   * `SessionStreamBuffer`-backed replay. Hosted cloud does NOT
   * yet honor `fromSeq` — the field is silently ignored there. OSS
   * `@ggui-ai/mcp-server` honors it fully.
   */
  fromSeq?: number;
  /**
   * Opaque WS auth credential for initial subscribe — the live-channel
   * counterpart to a bearer token. Symmetric with {@link
   * SubscribePayload.sessionId}/`appId`/`wsUrl` — names what it auths.
   *
   * **Auth-credential string only.** Identity/render fields ride on
   * the `ai.ggui/session` + `ai.ggui/stack-item` slice meta delivered
   * through the MCP Apps `_meta` path; this field is purely the WS
   * subscribe credential.
   *
   * General transport-credential slot — the type system does NOT
   * couple this field to any integration. Today the only consumer
   * minting these is the MCP Apps outbound delivery path
   * (`ui://ggui/session`), but any future credential-mint mechanism
   * (signed-URL share, short-code auto-login, etc.) reuses the same
   * field with the same semantics:
   *
   *   - Opaque to the client — validated server-side against the
   *     subscribe's `sessionId` + `appId`.
   *   - Short TTL (seconds-to-minutes); stale tokens are rejected
   *     (refresh via `ggui_runtime_refresh_ws_token` within the
   *     refresh window, otherwise re-handshake).
   *   - Reusable within TTL (G14, 2026-05-23) so a transient WS drop
   *     can reconnect without a fresh handshake.
   *
   * On a successful ws-token-authed subscribe, the server SHOULD issue
   * a longer-lived reconnect credential via {@link AckPayload.sessionToken}.
   *
   * Mutually compatible with upstream bearer-auth (`Authorization`
   * header / `?token=` query). When both are present, server behavior
   * is implementation-defined; the canonical path is
   * bearer-OR-wsToken, not bearer-AND-wsToken.
   */
  wsToken?: string;
  /**
   * Protocol schema versions this client accepts on the wire. Opt-in
   * — absent is legacy-pass-through (server treats the subscribe as
   * version-agnostic).
   *
   * First-party clients populate this with `CLIENT_SUPPORTED_VERSIONS`
   * (`@ggui-ai/protocol`), seeded with `PROTOCOL_SCHEMA_VERSION`. A
   * server whose {@link PROTOCOL_SCHEMA_VERSION} is NOT a member of
   * this list is a version mismatch — the server replies with an
   * `UPGRADE_REQUIRED` error envelope (see {@link UPGRADE_REQUIRED}).
   *
   * Symmetric with {@link AckPayload.serverVersion}: the server's
   * declaration is advisory on the receiver; this client declaration
   * is advisory on the server. The policy split is intentional — it
   * lets either side opt into stricter enforcement without breaking
   * legacy peers.
   *
   * Launch posture: servers run `versionPolicy: 'reject'` by default —
   * mismatch emits `UPGRADE_REQUIRED` AND closes the connection. Legacy
   * opt-out via explicit `versionPolicy: 'advisory'` keeps the connection
   * open after the error frame — used only for controlled migration
   * windows.
   */
  supportedVersions?: string[];
}

/**
 * Payload for ack message (subscribe response includes current stack)
 */
export interface AckPayload {
  sequence: number;
  timestamp: number;
  /** Current session stack (returned on subscribe) */
  stack?: SessionStackEntry[];
  /**
   * Current outbound-stream cursor snapshot at the moment the ack is
   * sent. Distinct from `sequence` (which counts INBOUND session
   * events like `user.submitted`). Clients use `streamSeq` to:
   *   - know the point beyond which the live tail begins;
   *   - seed their `lastSeenSeq` if they didn't pass `fromSeq` on
   *     subscribe.
   *
   * Absent on implementations without a `SessionStreamBuffer`.
   * 0 means the session has recorded no outbound envelopes yet.
   */
  streamSeq?: number;
  /**
   * Truthy when the server could NOT honor the client's `fromSeq`
   * fully — some envelopes with `seq > fromSeq` have been evicted
   * from the bounded buffer for a channel declaring
   * `replay: 'all'`. The client has a history gap; UX layers
   * typically surface this as a break-in-timeline indicator.
   *
   * Absent on fresh subscribes and on servers without replay
   * infrastructure.
   */
  replayTruncated?: boolean;
  /**
   * Reconnect credential issued on successful ws-token-authed subscribe.
   *
   * General transport-credential slot — the type system does NOT
   * couple this field to any integration (same positioning as
   * {@link SubscribePayload.wsToken}). Servers that accepted a WS
   * token on `subscribe` SHOULD mint a longer-lived session-scoped
   * token and return it here so the client can reconnect without
   * re-minting from the original credential source.
   *
   * Semantics:
   *   - Longer TTL than the ws token (minutes-to-hours).
   *   - Bound to the same `sessionId` + `appId`.
   *   - Passed on reconnect via the standard bearer path
   *     (`Authorization: Bearer <sessionToken>` or `?token=`), NOT in
   *     `SubscribePayload.wsToken` (which is short-TTL and credential-scoped).
   *
   * Absent when the subscribe was bearer-authed (no ws-token-bound
   * reconnect credential needed) and on servers that don't implement
   * ws-token auth.
   */
  sessionToken?: string;
  /**
   * Protocol schema version this server emits on. Advertised on every
   * successful ack. First-party servers populate this with
   * {@link PROTOCOL_SCHEMA_VERSION} from `@ggui-ai/protocol`.
   *
   * Client-side policy: on ack receipt, if `serverVersion` is present
   * AND not in the client's `CLIENT_SUPPORTED_VERSIONS`, the client
   * surfaces `UPGRADE_REQUIRED` (see {@link UPGRADE_REQUIRED}) via
   * its error channel. Absent `serverVersion` is legacy-pass-through
   * — the client treats the session as version-agnostic, preserving
   * pre-handshake behavior for servers that haven't wired the field.
   *
   * Symmetric with {@link SubscribePayload.supportedVersions}.
   */
  serverVersion?: string;
}

/**
 * Payload for push message (Server -> Client: agent push event with generated/cached UI).
 * Carries a {@link SessionStackEntry} — either a generated component
 * item (default) or an embedded MCP Apps iframe variant.
 */
export interface PushPayload {
  stackItem: SessionStackEntry;
  matchType?: string;
}

/**
 * Explicit outbound live-channel envelope — the body of a `type: 'data'`
 * WebSocket message.
 *
 * Carries the CHANNEL identity explicitly plus the minimal per-delivery
 * semantics receivers need to fold the payload correctly. Maps 1:1 to
 * the three-channel-topology doctrine's `StreamEnvelope` shape.
 *
 * Validation is split intentionally — `validateStreamData(channel,
 * payload, spec)` checks payload shape against the channel's
 * `schema`. `mode` / `complete` / `seq` are NOT validated by the
 * shape checker; senders declare them and receivers honor them.
 *
 * `replay` is NOT on the envelope — it's a per-channel policy
 * declared on `spec.channels[channel].replay`. A per-delivery field
 * would imply replay can vary message-to-message, which it can't.
 *
 * `timestamp` is NOT on the envelope in this slice. Replay
 * correctness needs `seq` only; timestamp is a future optional
 * addition driven by a concrete client-UX need.
 */
export interface StreamEnvelope {
  /** Session this delivery belongs to. */
  sessionId: string;
  /** Channel name (keys into `spec.channels`). */
  channel: string;
  /**
   * State-folding mode for this delivery. Senders declare; receivers
   * honor. Typically equals the channel's declared `mode` on the
   * spec, but the envelope is the authoritative per-delivery signal.
   */
  mode: StreamChannelMode;
  /**
   * Payload — validated against `spec.channels[channel].schema`.
   * Shape is channel-specific; consumers typecheck via contract
   * inference when they use `defineContract` + `useStream`.
   */
  payload: JsonValue;
  /**
   * Terminal completion marker — truthy on the last delivery for a
   * completable channel (one declared with `complete: true` on the
   * spec). Consumers use this to transition subscribers into a
   * "channel closed" state. Absent on non-terminal deliveries.
   */
  complete?: boolean;
  /**
   * Session-scoped monotonic outbound sequence. Server-assigned;
   * clients MUST NOT populate it on producer-side inputs. Gap-free
   * within a single session, starting at 1. Used by the client to:
   *   - track `lastSeenSeq` for reconnect (pass it back as
   *     `SubscribePayload.fromSeq`);
   *   - dedupe deliveries (at-least-once semantics).
   *
   * OPTIONAL because hosted cloud does not yet stamp `seq`;
   * implementations backed by `SessionStreamBuffer`
   * (OSS `@ggui-ai/mcp-server`) always populate it. When absent,
   * clients treat deliveries as single-shot with no replay possible.
   * This becomes required once the hosted runtime supports replay.
   */
  seq?: number;
  /**
   * Protocol schema version stamped by the producer. Pre-launch:
   * advisory — consumers MUST NOT reject on mismatch. A future
   * launch-cutover change tightens policy to `UPGRADE_REQUIRED` when
   * the received major diverges from the client's known major.
   *
   * See `PROTOCOL_SCHEMA_VERSION` for the current value.
   */
  schemaVersion?: string;
}

/**
 * Payload for stream message (Server → Client)
 * Delivers streaming text chunks from the agent in real-time.
 */
export interface StreamPayload {
  sessionId: string;
  /** Text chunk from agent. Empty string on final (done=true) message. */
  chunk: string;
  /** Whether this is the final chunk in the stream. */
  done: boolean;
}

/**
 * Payload for error message.
 * The `details` field is {@link JsonValue} to carry any JSON-safe diagnostic data.
 *
 * `code` is typed as `string` (open) so first-party servers can mint
 * new codes without a protocol version bump. Canonical codes shipped
 * by first-party implementations are exported as named constants from
 * `@ggui-ai/protocol::version` so consumers can pattern-match against
 * a typed literal rather than string-sniffing:
 *
 *   - `UPGRADE_REQUIRED` — version-handshake mismatch (see
 *     {@link SubscribePayload.supportedVersions} /
 *     {@link AckPayload.serverVersion}).
 *
 * Other codes emitted by first-party servers are free-form strings.
 */
export interface ErrorPayload {
  code: string;
  message: string;
  /** Additional diagnostic information. Typed as {@link JsonValue} (any JSON-safe value). */
  details?: JsonValue;
}

/**
 * Payload for `channel_subscribe` (Client → Server). Tells the server
 * to begin polling the channel's `streamSpec[ch].source.tool` on the
 * iframe's behalf and fan results out as `channel_payload` frames.
 *
 * Idempotent on reconnect: replaying the same `{sessionId, channelName,
 * pollIntervalMs?, args?}` triple after a WS disconnect re-binds the
 * existing subscription rather than minting a duplicate. The server is
 * authoritative on `pollIntervalMs` — clients propose, server caps to
 * its policy floor.
 */
export interface ChannelSubscribePayload {
  /** Active session id from the iframe's bootstrap. */
  sessionId: string;
  /** Active app id from the iframe's bootstrap. */
  appId: string;
  /** Stack item the channel belongs to (so the server can resolve `streamSpec[channelName]`). */
  stackItemId: string;
  /** Channel name as keyed in `streamSpec`. The source.tool comes from the contract. */
  channelName: string;
  /**
   * Optional client-side poll cadence override (milliseconds). The
   * server clamps to its configured floor (default 1000ms) and ceiling
   * (default 60000ms). Absent ⇒ server default (typically 10000ms).
   */
  pollIntervalMs?: number;
  /**
   * Optional arguments object merged into the `source.tool` call. Layered
   * over `streamSpec[ch].source.args`; client values win on key collision.
   * Use for "subscribe to a specific city's weather" style scoping.
   */
  args?: JsonObject;
}

/**
 * Payload for `channel_unsubscribe` (Client → Server). Idempotent: the
 * server tolerates an unsubscribe for an unknown `{sessionId,
 * channelName}` pair (treats as a no-op + ack). Closing the WebSocket
 * implicitly unsubscribes all channels on that subscriber — this
 * message is for fine-grained mid-session cancellation.
 */
export interface ChannelUnsubscribePayload {
  sessionId: string;
  appId: string;
  stackItemId: string;
  channelName: string;
}

/**
 * Payload for `channel_payload` (Server → Client). A single result of
 * the server's poll against `streamSpec[channelName].source.tool`,
 * matching the existing component-facing `StreamDelivery` shape.
 *
 * `mode: 'replace'` collapses the channel's history to this payload;
 * `mode: 'append'` appends to the tail. The runtime forwards both to
 * the component's `useChannel(name)` subscription with the same
 * semantics as iframe-polled payloads.
 */
export interface ChannelPayloadFrame {
  sessionId: string;
  appId: string;
  stackItemId: string;
  channelName: string;
  /** Server-monotonic sequence for this channel — gap-detection on the client. */
  seq: number;
  /** Server clock at fan-out — useful for staleness checks on slow clients. */
  ts: string;
  /** `replace` (full snapshot) or `append` (delta). Mirrors `StreamDelivery.mode`. */
  mode: StreamChannelMode;
  /** Raw tool output validated against `streamSpec[ch].schema` server-side. */
  payload: JsonValue;
  /**
   * Channel quiescence marker. When `true`, the server has decided the
   * channel is finished (e.g., source tool returned a terminal status)
   * and will not poll further. Client surfaces this as `isComplete`.
   */
  complete?: boolean;
}

/**
 * Payload for `channel_error` (Server → Client). Either a subscribe
 * rejection (channel name unknown, tool not in `streamWebSocketLocalTools`,
 * token expired) OR a poll-time failure (source.tool threw / timed
 * out). Clients distinguish via {@link code}.
 *
 * Defined error codes (extend in the SPEC's live-channel table as new
 * cases land):
 *
 *   - `CHANNEL_UNKNOWN`         — channelName not present in streamSpec.
 *   - `CHANNEL_NOT_LOCAL`       — `source.tool` not in `streamWebSocketLocalTools`; iframe must poll directly.
 *   - `STACK_ITEM_NOT_FOUND`    — `stackItemId` not on the session.
 *   - `SUBSCRIBE_UNAUTHORIZED`  — WS auth token expired or session-mismatch.
 *   - `POLL_FAILED`             — source.tool invocation threw. `details` carries the error.
 */
export interface ChannelErrorPayload {
  sessionId: string;
  channelName: string;
  code:
    | 'CHANNEL_UNKNOWN'
    | 'CHANNEL_NOT_LOCAL'
    | 'STACK_ITEM_NOT_FOUND'
    | 'SUBSCRIBE_UNAUTHORIZED'
    | 'POLL_FAILED'
    | (string & {});
  message: string;
  details?: JsonValue;
}

/**
 * Payload for pop message (Client → Server: remove top card from stack)
 */
export interface PopPayload {
  sessionId: string;
}

/**
 * Payload for close message (Client → Server: close session)
 */
export interface ClosePayload {
  sessionId: string;
}

/**
 * Payload for get_stack message (Client → Server: get stack info)
 */
export interface GetStackPayload {
  sessionId: string;
}

/**
 * Generation strategy controls how ggui resolves UI generation requests.
 *
 * - `strict`   — Only use predefined/cached blueprints. Fails if no match found.
 * - `balanced` — Try blueprint matching first, fall back to LLM generation.
 * - `creative` — Always generate fresh UI via LLM (no blueprint matching).
 */
export type GenerationStrategy = 'strict' | 'balanced' | 'creative';

/**
 * Payload for the legacy `generate` WS message — the pre-handshake-first
 * direct-generation entry point. The canonical mint path is the
 * `ggui_new_session` → `ggui_handshake` → `ggui_push` tool chain; this
 * payload survives only because `@ggui-ai/ggui-react` /
 * `@ggui-ai/ggui-react-native` SDKs still expose a `useGenerate()` hook
 * that POSTs through the WS surface for one-shot UI generation.
 *
 * Several flat fields here (`adapters`, `actions`) are legacy shapes
 * superseded by `DataContract.agentCapabilities` + `DataContract.actionSpec`;
 * they remain on the type for SDK back-compat but new code MUST author
 * via the handshake-first chain.
 *
 * Generic `TProps` defaults to {@link JsonObject} for the data payload.
 * Generic `TContext` defaults to {@link JsonObject} for generator context hints.
 *
 * @deprecated Use `ggui_handshake` + `ggui_push` (the canonical mint
 * path). This payload is retained only for the legacy `useGenerate()`
 * SDK hook surface.
 */
export interface GeneratePayload<TProps = JsonObject, TContext = JsonObject> {
  sessionId: string;
  prompt: string;
  /** Human-readable description (for non-LLM producers) */
  description?: string;
  /** Context hints for the generator */
  context?: TContext;
  /** JSON Schema for form validation */
  schema?: JsonSchema;
  /**
   * @deprecated Legacy flat shape. Declare via
   * `DataContract.actionSpec` instead.
   */
  actions?: Array<{ id: string; label: string; description?: string; icon?: string; variant?: string; confirm?: boolean | string; disabled?: boolean }>;
  /** Device/viewport context for responsive UI generation */
  interfaceContext?: InterfaceContext;
  /** Generation strategy (default: 'balanced') */
  strategy?: GenerationStrategy;
  /** Predefined blueprint name to use (for strict/balanced strategy) */
  blueprintName?: string;
  /** Props data to pass to the blueprint */
  data?: TProps;
  /** Data contract from negotiation (agreed props/actions shape) */
  contract?: DataContract;
  /** UX/presentation instructions for the generator */
  instructions?: string;
  /** Specific model override for generation */
  model?: string;
  /**
   * Existing stack-item id for repair — reuses the broken component's
   * slot instead of creating a new one.
   */
  stackItemId?: string;
}

/**
 * Progress step during UI generation
 */
export type ProgressStep = 'queued' | 'primitives' | 'writing' | 'compiling';

/**
 * Payload for progress message (Server → Client)
 */
export interface ProgressPayload {
  sessionId: string;
  stackItemId: string;
  step: ProgressStep;
  message: string;
}

/**
 * Payload for agent thinking message (Server → Client).
 * Sent immediately when a user message is received, before the agent processes it.
 * Agent message payload — used for both thinking and final messages.
 */
export type AgentMsgType = 'thinking' | 'chat';

export interface AgentMsgPayload {
  /** Message type — 'thinking' for status updates, 'chat' for final responses */
  type: AgentMsgType;
  /** Message text from the agent */
  message: string;
  /** Session ID */
  sessionId: string;
}

/**
 * Payload for props_update message (Server → Client).
 * Replaces props on an existing rendered component without re-generation.
 */
export interface PropsUpdatePayload {
  /** Stack-item id of the rendered component being updated. */
  stackItemId: string;
  /** New props — full replacement */
  props: JsonObject;
}

/**
 * Payload for url message (Server → Client)
 * Note: shortCode is returned; client constructs full URL using renderUrl from amplify_outputs
 */
export interface UrlPayload {
  sessionId: string;
  stackItemId: string;
  shortCode: string;
}

/**
 * System-level event actions sent from platform to client.
 *
 * - `auth_required` — Agent needs user to authorize an OAuth service.
 * - `credential_ready` — User completed OAuth; credential is available.
 */
export type SystemAction = 'auth_required' | 'credential_ready';

/**
 * Payload for system message (Server → Client).
 * Carries platform-level events such as OAuth consent requests.
 */
export interface SystemPayload {
  action: SystemAction;
  serviceId: string;
  /** Human-readable service name (e.g., "Google", "Slack") */
  displayName?: string;
  /** OAuth scopes the agent is requesting */
  scopes?: string[];
  /** URL the user should open to initiate the OAuth consent flow */
  consentUrl?: string;
  /** Human-readable message explaining why access is needed */
  message?: string;
  /** Status of the credential (used with credential_ready) */
  status?: string;
  /** App ID requesting access (used with auth_required for app-scoped grants) */
  appId?: string;
  /** Session ID for WebSocket context (used with auth_required) */
  sessionId?: string;
}

/**
 * Payload for internal:progress message (generator → handler)
 */
export interface InternalProgressPayload {
  sessionId: string;
  stackItemId: string;
  step: ProgressStep;
}

/**
 * Extended AckPayload for legacy `generate` requests. The handshake-first
 * mint path (`ggui_new_session` → `ggui_handshake` → `ggui_push`) does
 * NOT use this ack — it returns its own structured-content envelope.
 *
 * Note: shortCode is returned; client constructs full URL using renderUrl
 * from amplify_outputs.
 *
 * @deprecated Same lifecycle as {@link GeneratePayload}.
 */
export interface GenerateAckPayload extends AckPayload {
  shortCode: string;
  stackItemId: string;
  /**
   * @deprecated No live producer or consumer. Retained on the type for
   * one minor before structural removal.
   */
  sentViaWebsocket: boolean;
}

/**
 * Payload for session message (Server → Client)
 * Sent when an agent creates a session in response to a start invoke.
 */
export interface SessionPayload {
  sessionId: string;
}

/**
 * Payload for `drain_ack` (Server → Client). Sent by `ggui_consume` after
 * it pops an `ActionEnvelope` off a stack item's pending-events pipe, so
 * the iframe-runtime knows the agent received the gesture and can
 * dismiss the per-action toast.
 *
 * Wired entirely server-initiated — there is no `drain_subscribe` from
 * the iframe; the runtime listens on its existing WS connection and
 * filters frames by `eventId`.
 *
 * Named parties: **`ggui_consume` handler** produces (on successful pop);
 * **iframe-runtime** consumes (toast dismissal). Frame loss is
 * inconsequential — the pipe is the single source of truth for the
 * action; drain_ack is the optional UI-resolution signal, the pipe-
 * append + agent drain already happened.
 *
 * @public
 */
export interface DrainAckPayload {
  /** Active session id from the bootstrap that emitted the action. */
  sessionId: string;
  /** Active app id from the bootstrap that emitted the action. */
  appId: string;
  /** Stack item the drained event was queued on. */
  stackItemId: string;
  /**
   * Server-assigned `ActionEnvelope.id` of the specific event that
   * was drained. The iframe-runtime keys its toast resolution on this
   * id to dismiss the matching toast.
   */
  eventId: string;
  /**
   * ISO 8601 UTC timestamp of when the pop landed (server clock). Used
   * by the iframe for end-to-end latency telemetry (`drainedAt -
   * submittedAt` becomes the submit→consume latency).
   */
  drainedAt: string;
}
