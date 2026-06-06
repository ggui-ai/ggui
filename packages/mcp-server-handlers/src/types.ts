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
import type { ZodRawShape } from 'zod';

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
   * Active render id, when the dispatcher knows it at invocation time.
   *
   * Populated for render-scoped invocations — today's two paths:
   *
   *   1. Wired-action dispatch. The render-channel router synthesizes
   *      the runtime ctx for mount handlers as a structural superset
   *      of `HandlerContext` + `WiredActionContext`; formally
   *      declaring `sessionId` here lets the same `ctx` argument carry
   *      it under the canonical static type, no cast needed at the
   *      mount-handler call site.
   *   2. Agent-driven `ggui_update`. The handler reads `sessionId`
   *      off the wire input directly — but when a future caller
   *      (live-channel dispatch, console inspector) invokes the
   *      handler in-process, populating this field threads the active
   *      render through the canonical context shape rather than a
   *      parallel parameter.
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
   * for in-process invocations (wired-action dispatch, console
   * inspector, contract-test fixtures) where there is no upstream
   * MCP request. Handlers MUST treat it as optional and read keys
   * with a parser that tolerates absence — never assume a particular
   * slice is present.
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
   * `undefined` for in-process invocations (wired-action dispatch,
   * console inspector, contract-test fixtures) where there is no
   * upstream MCP request. Handlers MUST treat it as optional — a missing
   * signal simply means "no cancellation channel," not "never cancel."
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
   *   - `'protocol'` — design-time spec/discovery tools served on
   *     `/protocol`. Strips spec-discovery noise off the agent's runtime
   *     tools/list. Examples: `ggui_protocol_describe_*`,
   *     `ggui_protocol_get_example_blueprints`,
   *     `ggui_protocol_validate_blueprint`,
   *     `ggui_protocol_list_available_primitives`,
   *     `ggui_protocol_get_blueprint_boilerplate`.
   *   - `'ops'` — operator-class management tools served on `/ops`.
   *     Examples: `ggui_ops_set_provider_key`, `ggui_ops_get_credit_balance`,
   *     `ggui_ops_generate_blueprint`.
   *
   * Multi-audience tags (e.g. `['agent', 'runtime']`) are valid — a
   * handler may surface on more than one route. The route mounter
   * consults this field to decide which tools to expose per route.
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
 * Transport layers SHOULD map this to a 401 (or 403, depending on
 * whether the client could re-auth into a richer identity). The pod's
 * `podErrorMapper` maps it to 401 with the handler's message so
 * MCP clients can prompt for sign-in.
 */
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}
