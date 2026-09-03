/**
 * Shared handler types — framework-agnostic, seam-pure.
 *
 * Pure over `@ggui-ai/mcp-server-core` interfaces + `@ggui-ai/protocol`
 * types. These types intentionally DO NOT include:
 *
 *   - HTTP request/response shapes (bind in `@ggui-ai/mcp-server` / hosted)
 *   - MCP SDK wire types (bind in the transport layer)
 *   - Auth principal semantics (resolved by `AuthAdapter` upstream)
 *   - Logging / telemetry / audit (inject via deps, or let host decorate)
 *
 * Every handler in this package is a factory returning a `SharedHandler`:
 *
 * ```ts
 * const handler = createSearchBlueprintsHandler({ embedding, vectors });
 * await handler.handler({ query: 'weather' }, { appId: 'a', requestId: 'r' });
 * ```
 */
import type { AuthResult, CredentialScope } from '@ggui-ai/mcp-server-core';
import type { ZodRawShape, ZodType } from 'zod';

/**
 * Per-request context threaded through every shared handler.
 *
 * Narrower than a hosted `ToolContext` (which historically also carried
 * full request headers) so a standalone server doesn't have to
 * fabricate those fields. The `apiKeyHash` field below is the one
 * identity-derived hosted field that earned a place on this canonical
 * context. Standalone deployments leave it `undefined`; hosted
 * deployments fill it from the resolved `AuthResult.identity`
 * upstream of the handler.
 */
export interface HandlerContext {
  /**
   * Resolved app/tenant id. Upstream auth adapter proves this; handlers
   * use it to scope every read/write. In single-tenant mode this may
   * collapse to a single well-known value (e.g. `"local"`); in a
   * hosted runtime it's the authenticated app id.
   */
  readonly appId: string;
  /** Per-request correlation id. Used for log lines. */
  readonly requestId: string;
  /**
   * SHA-256 hash of the caller's API key, when the upstream
   * `AuthAdapter` resolved an `app`-kind identity that carries one.
   *
   * `undefined` for every other identity kind and for deployments
   * whose adapters don't produce one. Handlers MUST treat it as
   * optional. Today's two production uses, both on a hosted server:
   *
   *   1. Bring-your-own-key propagation — `ggui_render` threads it to
   *      the Generator as `connectorApiKeyHash` for downstream
   *      credential lookup on platform traffic.
   *   2. Playground traffic-class gate — `ggui_render` + `ggui_update`
   *      bypass the non-playground billing check when this field
   *      equals the hardcoded `"playground"` sentinel.
   *
   * Adding it to the canonical context (vs. a parallel hosted-only
   * shape) keeps `SharedHandler` mono-typed across deployments.
   */
  readonly apiKeyHash?: string;
  /**
   * Authenticated user id, when the upstream `AuthAdapter` resolved a
   * `kind: 'user'` identity (today: `ApiKeyAuthAdapter`'s `ggui_user_*`
   * branch and `CognitoAuthAdapter`). Threaded onto the canonical
   * context so kind=user handlers (cloud pod billing gate, per-user
   * blueprint scoping) can read userId directly without a redundant
   * GSI-by-apiKeyHash lookup.
   *
   * `undefined` for kind=app (use {@link apiKeyHash} → user-key table
   * GSI), kind=builder, and adapters that don't produce one.
   * Handlers MUST treat it as optional. Symmetry with apiKeyHash:
   * exactly one of the two is set on hosted requests, never both,
   * never neither when auth resolved.
   */
  readonly userId?: string;
  /**
   * What the CREDENTIAL on this request may act on, forwarded verbatim
   * from the resolved `AuthResult.credentialScope` upstream of the
   * handler. See `CredentialScope` in `@ggui-ai/mcp-server-core`.
   *
   * Orthogonal to {@link userId}, which says who the caller is. One
   * account can hold several credentials — one bound to a single app,
   * another carrying full account authority — and {@link userId} is the
   * same string for both. A handler that grants account-wide authority
   * (enumerating an account's apps, minting new ones) therefore CANNOT
   * decide from {@link userId}; it reads this.
   *
   * `undefined` when the deployment's adapter doesn't distinguish
   * credential scopes, and for in-process invocations. Absence is NOT
   * account scope: handlers MUST require an explicit `'account'` scope
   * (or another positive proof of full authority, such as a first-party
   * session) rather than treating a missing scope as permission.
   */
  readonly credentialScope?: CredentialScope;
  /**
   * How the caller's identity was proved, forwarded verbatim from the
   * resolved `AuthResult.source` upstream of the handler.
   *
   * The one value handlers act on is `'anonymous'`, which the transport
   * synthesizes for a request that reached an anonymous-capable surface
   * without a credential the `AuthAdapter` accepted. Everything else
   * means "this request was authenticated"; WHICH mechanism proved it
   * is deployment-specific and handlers should not branch on it.
   *
   * This is the only way to tell an authenticated single-user builder
   * (`source: 'dev'`, no `userId`, no `apiKeyHash`) apart from an
   * anonymous one — the identity FIELDS are identical for both. Any
   * handler on an anonymous-capable surface that must refuse
   * unauthenticated callers reads this and throws
   * {@link AuthRequiredError}.
   *
   * `undefined` for in-process invocations (console inspector, contract
   * fixtures) where no request was authenticated at all. Handlers MUST
   * treat that the same as anonymous — absence is not proof of auth.
   */
  readonly authSource?: AuthResult['source'];
  /**
   * Active render id, when the dispatcher knows it at invocation time.
   *
   * Populated for render-scoped invocations — today's one path:
   * agent-driven `ggui_update`. The handler reads `sessionId` off the
   * wire input directly — but when a future caller (console
   * inspector, in-process composition) invokes the handler
   * in-process, populating this field threads the active render
   * through the canonical context shape rather than a parallel
   * parameter.
   *
   * `undefined` for everything else: `/mcp` HTTP ingress (per-request
   * context built from auth identity, no render bound), blueprint /
   * thread / preflight handlers (no render scope). Handlers MUST treat
   * it as optional and fall back to wire-input fields when bound.
   *
   * Post-Phase-B (flatten-render-identity): collapsed from the prior
   * `sessionId` + `stackItemId` pair to a single `sessionId` — every
   * render IS the addressable scope.
   */
  readonly sessionId?: string;
  /**
   * Host-supplied `_meta` from the inbound JSON-RPC `tools/call`
   * request. The MCP SDK extracts this from `params._meta` and the
   * transport layer threads it onto the context for handlers that
   * need to read host-channel slices (today: the
   * `ai.ggui/host-session` slice consumed by `ggui_render` to
   * group renders for end-user resume).
   *
   * `undefined` when the request carried no `_meta` (most calls) and
   * for in-process invocations (console inspector, contract-test
   * fixtures) where there is no upstream MCP request. Handlers MUST
   * treat it as optional and read keys with a parser that tolerates
   * absence — never assume a particular slice is present.
   */
  readonly requestMeta?: Readonly<Record<string, unknown>>;
  /**
   * Per-request abort signal, fired when the inbound `tools/call`
   * request is cancelled by the caller — either via the MCP
   * `notifications/cancelled` notification (the canonical cancellation
   * path; an aborting agent SDK sends this) OR via transport close
   * (the HTTP connection dropping; `@ggui-ai/mcp-server` wires
   * `res.on("close") → transport.close()`, which aborts every in-flight
   * request handler). The MCP SDK exposes it on
   * `RequestHandlerExtra.signal`; the transport layer threads it here.
   *
   * The one handler that reads it today is `ggui_consume`, whose inline
   * long-poll races each poll tick against this signal so a
   * disconnected consumer stops long-polling — and therefore stops
   * being counted by the active-consumer registry — PROMPTLY, rather
   * than holding `hasActive: true` until its deadline (the
   * zombie-consumer bug that suppresses the recovery doorbell on a
   * post-reload user gesture).
   *
   * `undefined` for in-process invocations (console inspector,
   * contract-test fixtures) where there is no upstream MCP request.
   * Handlers MUST treat it as optional — a missing signal simply
   * means "no cancellation channel," not "never cancel."
   */
  readonly signal?: AbortSignal;
}

/**
 * Audience tag — declares which MCP route this handler should appear on.
 * See {@link SharedHandler.audience} for the per-tag semantics. The
 * server mounts audience-filtered routes that read this field on
 * every registered handler.
 */
export type AudienceTag = 'agent' | 'runtime' | 'protocol' | 'ops';

/**
 * Marker key for {@link HandlerFailure}. A registry symbol
 * (`Symbol.for`) so the check is stable across module instances, and a
 * symbol (not a string field) so ordinary wire data — which can never
 * carry symbol keys through JSON — can't collide with the marker.
 */
export const HANDLER_FAILURE_MARKER: unique symbol = Symbol.for(
  'ai.ggui.handlerFailure',
);

/**
 * First-class in-result failure channel for shared handlers.
 *
 * A handler opts in by widening its `OutputData` generic to
 * `Data | HandlerFailure<Data>` and returning
 * {@link handlerFailure | handlerFailure(data, errorText)} on a failed
 * operation that still has a schema-conformant output to report. The
 * transport layer (`buildMcpServer` in `@ggui-ai/mcp-server`) unwraps
 * the marker into an MCP tool result with:
 *
 *   - `isError: true` — IN-RESULT, never a thrown error. MCP SDK
 *     clients validate `structuredContent` against the declared
 *     `outputSchema` even when `isError` is set, so {@link data} MUST
 *     parse against the handler's `outputSchema`.
 *   - `content: [{type: 'text', text: errorText}]` — the model-visible
 *     self-correction surface.
 *   - `structuredContent` — the zod-validated {@link data}.
 *   - NO `_meta` — `resultMeta` is not invoked for failures; a failed
 *     call exposes no mount affordance.
 *
 * Distinct from THROWING: a thrown error becomes an SDK-wrapped
 * `isError` result WITHOUT structuredContent (breaking client-side
 * outputSchema validation) or a JSON-RPC error, depending on the
 * transport. Handlers whose failure still has a meaningful,
 * schema-conformant output (e.g. `ggui_render` committing an error
 * GguiSession) MUST use this channel instead.
 *
 * The channel carries TWO kinds of non-success (SPEC §7.1, ggui#786),
 * told apart by the payload's `outcome`:
 *
 *   - `failed` — work RAN and did not produce a result. State was
 *     committed, so the payload carries the full identity.
 *   - `refused` — a PRE-STATE refusal: the deployment declined before
 *     anything was parsed, read or committed, so the payload is the
 *     refusal envelope and NOTHING else.
 */
export interface HandlerFailure<OutputData = unknown> {
  readonly [HANDLER_FAILURE_MARKER]: true;
  /**
   * Schema-conformant structuredContent for the failed call. Parsed
   * (and unknown-key-stripped) against the handler's `outputSchema`
   * by the transport before serialization — a non-conformant payload
   * fails loudly at the transport, never silently on the wire —
   * INCLUDING its cross-field rules when the handler declares an
   * {@link SharedHandler.outputEnvelopeSchema}. `ggui_render` does, so
   * "a refusal carries `refusal` and nothing else" and
   * "present-iff-committed on the `rendered` / `failed` arms" are both
   * transport-enforced, not merely test-enforced.
   */
  readonly data: OutputData;
  /**
   * Model-visible failure text — becomes `content[0].text` on the
   * tool result. This is the agent's self-correction surface: state
   * the failure, whether the operation consumed its input, and the
   * recovery step.
   */
  readonly errorText: string;
}

/** Union a handler's success shape with its opt-in failure marker. */
export type SharedHandlerResult<OutputData> =
  | OutputData
  | HandlerFailure<OutputData>;

/** Build a {@link HandlerFailure} result. */
export function handlerFailure<OutputData>(
  data: OutputData,
  errorText: string,
): HandlerFailure<OutputData> {
  return { [HANDLER_FAILURE_MARKER]: true, data, errorText };
}

/**
 * Narrowing guard for {@link HandlerFailure}. Accepts `unknown` so
 * transports (which see handler results untyped) and concretely-typed
 * in-process callers both narrow: on a
 * `Success | HandlerFailure<Fail>` union the if-branch keeps the
 * failure member and the else-branch keeps the success member.
 */
export function isHandlerFailure(
  value: unknown,
): value is HandlerFailure<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const marker = (value as { [HANDLER_FAILURE_MARKER]?: unknown })[
    HANDLER_FAILURE_MARKER
  ];
  return marker === true;
}

/**
 * Shared tool-handler shape. A hosted server's tool-handler is a
 * `SharedHandler` re-export with a wider `ToolContext` — it can wrap a
 * `SharedHandler` with zero conversion cost. The only difference is
 * that this version's `handler` takes the narrower {@link HandlerContext}.
 */
export interface SharedHandler<
  Input extends ZodRawShape,
  Output extends ZodRawShape,
  OutputData = unknown,
> {
  /** Canonical tool name shipped to MCP clients (e.g. `"ggui_search_blueprints"`). */
  readonly name: string;
  /** Optional human-friendly title shown in clients that support it. */
  readonly title?: string;
  /** Long-form description; fed directly to the MCP client. */
  readonly description: string;
  /** Zod raw-shape. Transport layer decides whether to parse here or upstream. */
  readonly inputSchema: Input;
  /** Zod raw-shape for the output. */
  readonly outputSchema: Output;
  /**
   * The COMPOSED output schema, when the tool declares cross-field
   * rules that a raw shape cannot carry (ggui#786).
   *
   * `outputSchema` above is a raw field record because that is what the
   * MCP SDK registers — and the spec requires the declared
   * `Tool.outputSchema` root to be a JSON Schema of type `object`, so
   * that must stay a plain shape. But rebuilding it with
   * `z.object(shape)` at the transport DROPS every refinement attached
   * to the composed schema, which would leave rules like "a refused
   * result carries no identity fields" unenforced on the wire.
   *
   * A handler whose protocol schema carries refinements sets this to
   * that schema. The transport then validates outbound payloads
   * against it INSTEAD of the rebuilt shape — same stripping, plus the
   * refinements — so a non-conformant payload fails loudly at the
   * transport rather than shipping. Registration keeps using
   * `outputSchema`.
   *
   * Omitted ⇒ the transport rebuilds the raw shape, exactly as before.
   */
  readonly outputEnvelopeSchema?: ZodType;
  /**
   * Declaration-level metadata forwarded on the MCP tool registration's
   * `_meta` field. MCP-Apps-aware hosts read `_meta.ui.resourceUri` and
   * `_meta.ui.visibility` here to wire UI-producing tools. Opaque to the
   * handler itself — the transport layer just passes it through.
   *
   * Scoping convention: top-level keys are MCP spec namespaces (`ui`,
   * `related-task`, etc.). ggui's own declaration-level metadata, if any
   * ever lands, uses the `ggui` key.
   */
  readonly _meta?: Record<string, unknown>;
  /**
   * Identity-kind gate. When present, the tool is only registered with
   * the MCP server for callers whose `Identity.kind` (resolved by the
   * deployment's `AuthAdapter`) is in this list.
   *
   * Omitting the field (the default) means "no kind restriction" —
   * authenticated callers of any kind see the tool. Today, no enforcement
   * filter is wired (this field is declarative; gate logic lands when
   * `mcp.ggui.ai` ships and a single deployment needs to expose only a
   * curated user-facing subset). Setting the field NOW is cheap; backfilling
   * later across 15+ tools is expensive.
   *
   * Examples:
   *   - `allowedFor: ['app']` — agent-builder MCP-caller-only (e.g.
   *     `ggui_render`, `ggui_handshake`). Used on hosted kind=app deployments.
   *   - `allowedFor: ['user']` — end-user-only (e.g. a future
   *     `ggui_render` exposed by the user-pod posture to Claude Desktop).
   *   - `allowedFor: ['user', 'builder']` — both Connector users and
   *     builders, but not per-app machine callers.
   *   - omitted — anyone authenticated (today's behavior; safest
   *     default since standalone callers are `kind: 'builder'` and
   *     any tightening here would gate them off).
   */
  readonly allowedFor?: ReadonlyArray<'app' | 'user' | 'builder'>;
  /**
   * Audience tag — declares which MCP route-audience this handler is
   * intended for. The MCP surface is split into audience-filtered
   * routes:
   *
   *   - `'agent'` — runtime agent-callable tools on the canonical agent
   *     route (`/mcp`, or a cloud server's bare-root + `/apps/{appId}`).
   *     Examples: `ggui_render`, `ggui_handshake`,
   *     `ggui_update`, `ggui_consume`, `ggui_search_blueprints`.
   *   - `'runtime'` — iframe-runtime-callable tools (visibility-tagged
   *     `'app'`). Hidden from agent's tools/list but routed on the same
   *     agent endpoint. Examples: `ggui_runtime_submit_action`,
   *     `ggui_runtime_sync_context`.
   *   - `'protocol'` — design-time spec/discovery tools. Served on the
   *     `/control` plane, which keeps spec-discovery noise off the
   *     agent's runtime tools/list. Answer anonymously: an agent
   *     authoring a blueprint has no account yet. Examples:
   *     `ggui_protocol_describe_*`,
   *     `ggui_protocol_get_example_blueprints`,
   *     `ggui_protocol_validate_blueprint`,
   *     `ggui_protocol_list_available_primitives`,
   *     `ggui_protocol_get_blueprint_boilerplate`.
   *   - `'ops'` — operator-class management tools. Also served on
   *     `/control`, but auth-gated per tool, and confirm-gated when
   *     state-changing. Examples: `ggui_ops_set_provider_key`,
   *     `ggui_ops_get_credit_balance`, `ggui_ops_generate_blueprint`.
   *
   * The tag is the normative caller-class declaration; it does NOT mint
   * one HTTP route per value. Two surfaces exist: the data plane
   * (`agent` + `runtime`) and the control plane (`protocol` + `ops`).
   *
   * Multi-audience tags (e.g. `['agent', 'runtime']`) are valid — a
   * handler may surface on more than one caller class. The route
   * mounter consults this field to decide which surface exposes it.
   *
   * Absent = the route mounter SHOULD treat the handler as `['agent']`
   * (the historical default — every handler that didn't have a tag was
   * agent-runtime-callable).
   */
  readonly audience?: ReadonlyArray<'agent' | 'runtime' | 'protocol' | 'ops'>;
  /** Request handler. Takes a generic record so transports can pass unvalidated input. */
  handler(
    input: Record<string, unknown>,
    ctx: HandlerContext,
  ): Promise<OutputData>;
  /**
   * Per-result `_meta` builder. Invoked AFTER {@link handler} succeeds
   * and BEFORE the transport serializes the reply. The returned object
   * becomes the tool result's `_meta` field (alongside `structuredContent`
   * and `content`), NOT merged into `structuredContent`.
   *
   * This is the canonical seam for attaching APP-FACING metadata — e.g.
   * the `ai.ggui/render` slice carrying
   * the WebSocket bootstrap credentials the MCP Apps iframe needs.
   * Because `_meta` is not described by `outputSchema`, agents that
   * typecheck against the tool signature never see these fields; only
   * hosts that inspect `_meta` do.
   *
   * Returning `undefined` (or omitting the method) means "no `_meta` on
   * this result" — the transport simply doesn't attach the field.
   */
  resultMeta?(
    output: OutputData,
    input: Record<string, unknown>,
    ctx: HandlerContext,
  ):
    | Record<string, unknown>
    | undefined
    | Promise<Record<string, unknown> | undefined>;
}

/**
 * Thrown by a handler when the caller's identity isn't sufficient to
 * run the operation — most commonly when a Cognito-gated handler sees
 * a `ctx.userId` that's undefined (anonymous / builder identity, e.g.
 * an unauthenticated request reaching a user-scoped service like
 * `mcp.ggui.ai/playground/todos`).
 *
 * Distinct from `UnauthenticatedError` (in `@ggui-ai/mcp-server`),
 * which the auth middleware throws BEFORE the handler runs when no
 * bearer is present. `AuthRequiredError` is for handler-level
 * authorization — auth resolved fine, but the resolved identity
 * doesn't have what this particular handler needs.
 *
 * How this reaches the wire is two-layered (ggui#505): the control
 * transport challenges anonymous OPS calls with an HTTP 401 +
 * `WWW-Authenticate` BEFORE dispatch (so standards hosts
 * auto-negotiate OAuth), and a throw from INSIDE a handler surfaces
 * as an in-band `isError` tool result — the MCP framework converts
 * handler throws at dispatch, so transport error mappers (the pod's
 * `podErrorMapper` 401 arm included) never see this error from tool
 * dispatch. The in-band form is the contract for authenticated-but-
 * insufficient callers; the transport 401 is the contract for
 * anonymous ones.
 */
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}
