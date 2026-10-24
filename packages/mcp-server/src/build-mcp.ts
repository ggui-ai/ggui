/**
 * buildMcpServer — register every shared handler on a fresh `McpServer`
 * instance. One server per request (matches the hosted pattern); the
 * `StreamableHTTPServerTransport` holds per-connection state so pooling
 * isn't worth the locking.
 *
 * Output validation runs here via a zod object built from each handler's
 * `outputSchema` raw shape. This enforces the ggui convention that every
 * tool return advertises its shape — wire consumers can trust the output.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResponse,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { McpUiToolMeta } from '@modelcontextprotocol/ext-apps';
import { isRecord } from '@ggui-ai/protocol';
import { z, type ZodRawShape } from 'zod';
import {
  isHandlerFailure,
  type HandlerContext,
  type SharedHandler,
} from '@ggui-ai/mcp-server-handlers';
import type { Logger } from './logger.js';
import { GGUI_RENDER_RESOURCE_URI } from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  type LoadingIndicatorOption,
  installMcpAppsOutbound,
  type GguiRenderResourceTemplateOptions,
} from './mcp-apps-outbound.js';
import { runViewProofGate, type ViewProofGate } from './view-proof-gate.js';

// =============================================================================
// Advertised output objects are OPEN (ggui#1333)
//
// The SDK projects a tool's registered output object into `tools/list` in
// zod's OUTPUT mode, which closes every object (`additionalProperties:
// false`) whether or not the zod object is strict. A host that caches that
// document and validates results — the TS SDK client does — then refuses a
// result carrying a member it does not name, so an optional output field
// added in release N failed every host that listed tools against N−1, and
// an additive field could only ship by declaring it one release before
// emitting it (ggui#1336). The MUST this section enforces: an advertised
// output object MUST NOT be closed, at any depth.
//
// The ADVERTISED document is therefore decoupled from the PARSE: what the
// server registers is an open derivation of the handler's shape (every
// object node loose, the top level included), while
// {@link validateOutputPayload} keeps validating with the handler's own
// shape, so an undeclared member is still stripped before the wire. The SDK's
// own output validation runs the loose object over the already-stripped
// payload and passes. `assertAdvertisedOpen` makes the obligation
// self-enforcing at server build — a node kind the derivation does not open
// fails loudly here, never silently as a closed object on the wire.
// =============================================================================

/**
 * A node reached through a schema's definition is typed as zod's CORE
 * `$ZodType`; every schema a handler builds with `z.*` is a classic
 * `ZodType` instance, so this is a real check at the one place a core node
 * is handed back, and a non-classic node is a definition-site bug.
 */
function asClassic(node: z.core.$ZodType): z.ZodType {
  if (node instanceof z.ZodType) return node;
  throw new Error('a tool output shape holds a schema node that is not a zod classic ZodType');
}

/**
 * One open derivation per source node (ggui#1333): the memo is what keeps a
 * recursive schema (`z.lazy`) from looping, and it keeps a node shared by two
 * fields shared in the derivation too.
 */
const OPENED = new WeakMap<z.ZodType, z.ZodType>();

/** The open derivation of one node: every object under it becomes loose. */
function openNode(schema: z.ZodType): z.ZodType {
  const seen = OPENED.get(schema);
  if (seen !== undefined) return seen;
  const meta = z.globalRegistry.get(schema);
  const unmetered = openNodeUnmetered(schema);
  const opened = unmetered === schema || meta === undefined ? unmetered : unmetered.meta(meta);
  OPENED.set(schema, opened);
  return opened;
}

function openNodes(nodes: readonly z.core.$ZodType[]): z.ZodType[] {
  return nodes.map((node) => openNode(asClassic(node)));
}

/** The inner node of a wrapper, as the classic type the derivation rebuilds with. */
function inner(node: z.core.$ZodType): z.ZodType {
  return openNode(asClassic(node));
}

function openNodeUnmetered(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) return z.looseObject(openShape(schema.shape));
  if (schema instanceof z.ZodArray) return z.array(inner(schema.element));
  // A discriminated union is a union in the projection (`anyOf`); the
  // discriminator only speeds the parse, which stays on the original.
  if (schema instanceof z.ZodUnion) {
    const [first, ...rest] = openNodes(schema.options);
    if (first === undefined) return schema;
    return z.union([first, ...rest]);
  }
  if (schema instanceof z.ZodIntersection) {
    const { left, right } = schema._zod.def;
    return z.intersection(inner(left), inner(right));
  }
  if (schema instanceof z.ZodTuple) {
    const { items, rest } = schema._zod.def;
    const [first, ...others] = openNodes(items);
    if (first === undefined) return rest === null ? z.tuple([]) : schema;
    return rest === null ? z.tuple([first, ...others]) : z.tuple([first, ...others], inner(rest));
  }
  if (schema instanceof z.ZodRecord) return z.record(schema.keyType, inner(schema.valueType));
  if (schema instanceof z.ZodOptional) return inner(schema.unwrap()).optional();
  if (schema instanceof z.ZodNullable) return inner(schema.unwrap()).nullable();
  if (schema instanceof z.ZodNonOptional) return inner(schema.unwrap()).nonoptional();
  if (schema instanceof z.ZodReadonly) return inner(schema.unwrap()).readonly();
  if (schema instanceof z.ZodDefault) {
    return inner(schema.unwrap()).default(schema._zod.def.defaultValue);
  }
  if (schema instanceof z.ZodCatch) {
    return inner(schema.unwrap()).catch(schema._zod.def.catchValue);
  }
  if (schema instanceof z.ZodLazy) return z.lazy(() => inner(schema.unwrap()));
  if (schema instanceof z.ZodPipe) return z.pipe(schema.in, inner(schema.out));
  return schema;
}

function openShape(shape: ZodRawShape): ZodRawShape {
  return Object.fromEntries(Object.entries(shape).map(([key, member]) => [key, inner(member)]));
}

/** Every `additionalProperties: false` under a JSON Schema document, by path. */
function closedObjectsIn(node: unknown, path: string): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => closedObjectsIn(item, `${path}[${i}]`));
  }
  if (!isRecord(node)) return [];
  const closed: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties' && value === false) closed.push(path);
    closed.push(...closedObjectsIn(value, `${path}.${key}`));
  }
  return closed;
}

/**
 * The output object a tool ADVERTISES in `tools/list` (ggui#1333): the
 * handler's shape with every object node open. Throws at server build if
 * the derivation left a closed object anywhere in the projection the SDK
 * will publish — the MUST is enforced where the document is made, not
 * only where a test happens to look.
 */
export function openOutputObject(toolName: string, shape: ZodRawShape): z.ZodObject {
  const advertised = z.looseObject(openShape(shape));
  const closed = closedObjectsIn(z.toJSONSchema(advertised, { io: 'output' }), '$');
  if (closed.length > 0) {
    throw new Error(
      `Tool ${toolName} would advertise a closed output object at ${closed.join(', ')} — ` +
        `an advertised output object MUST NOT be closed (ggui#1333); extend openNode for this node kind.`,
    );
  }
  return advertised;
}

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
}

export interface BuildMcpServerOptions {
  /**
   * How many array elements and object members one `tools/call`'s
   * `arguments` may carry before the SDK refuses the call ahead of any
   * handler (ggui#1993). Default {@link MAX_TOOL_INPUT_ELEMENTS}; `Infinity`
   * is the SDK's "no limit", leaving the request body limit as the only
   * bound. A value below 1 or NaN is refused by the SDK at construction
   * (`RangeError`); `createGguiServer` refuses it earlier, at composition,
   * so a misconfigured deployment fails at boot and not at its first call
   * (ggui#1996).
   */
  readonly maxToolInputElements?: number;
  /**
   * The view-origin proof's measuring gate (ggui#1415), built once per
   * server with the secret its ws envelopes are signed with. For a tool
   * that declares a view proof, the gate verifies the call's proof before
   * the handler runs, puts the verdict on the handler's context and names
   * it on the `tool_invoked` line. It never refuses or fails a call.
   * Absent: a declared call's line says `viewProofUnverifiable: true`.
   */
  readonly viewProofGate?: ViewProofGate;
  /**
   * Whether this mount's read door (`resources/read` of a render
   * locator) may issue a view key (ggui#1415). Set only for the data
   * plane, the mount that delivers a view to an app-credentialed caller.
   */
  readonly issueViewKeys?: boolean;
  /**
   * When set, register the MCP Apps outbound wiring on every fresh
   * server instance — advertises the `io.modelcontextprotocol/ui`
   * capability and serves `ui://ggui/render` via `resources/read`.
   *
   * Tool-declaration `_meta.ui.*` is INDEPENDENT of this flag; it's
   * carried per-handler on `SharedHandler._meta`. A server can stamp
   * those without turning the outbound wiring on, but serving the
   * resource without stamping the declaration is pointless, so the
   * canonical path is "enable both together" via `createGguiServer`.
   */
  readonly mcpAppsOutbound?: boolean;
  /**
   * Optional override for the `ui://ggui/render` shell body. Defaults
   * to whatever shell the server was built with — either a placeholder
   * or the real thin-shell HTML.
   */
  readonly shellHtml?: string;
  /** #667 working-state knob — see `LoadingIndicatorOption`. */
  readonly loadingIndicator?: LoadingIndicatorOption;
  /**
   * Per-render self-contained shell options. When supplied,
   * `installMcpAppsOutbound` ALSO registers
   * `ui://ggui/render/{sessionId}` as a resource template — the URI
   * `ggui_render.resultMeta` stamps on per-call `_meta.ui.resourceUri`
   * for third-party MCP Apps hosts (Claude Desktop, claude.ai web)
   * that don't speak ggui's custom postMessage protocol.
   *
   * Absent → only the legacy postMessage shell is registered (first-
   * party hosts only).
   */
  readonly selfContained?: GguiRenderResourceTemplateOptions;
  /**
   * Public origin the server is reachable at — forwarded to
   * `installMcpAppsOutbound` so the static `ui://ggui/render`
   * resource declares `_meta.ui.csp.{connectDomains,resourceDomains}`.
   * Without this, spec-compliant hosts (Claude Desktop, claude.ai
   * Connector, Claude Code) apply their default CSP (`connect-src
   * 'none'`) and the iframe can't fetch the runtime bundle or open
   * the WebSocket. Omit when running same-origin behind a first-party
   * host that owns the iframe CSP itself.
   */
  readonly publicBaseUrl?: string;
  /**
   * Live-channel origins for the static shell's CSP declaration —
   * forwarded to `installMcpAppsOutbound`. Deployments that set no
   * `publicBaseUrl` (a hosted deployment) pass their `wsUrl` + its ws→http
   * origin flip here so the mounted iframe's `connect-src` covers the
   * SSE / HTTP-polling session API and the WebSocket; otherwise
   * cross-origin hosts CSP-block every network rung of the failover
   * ladder (#471 round 11).
   */
  readonly extraConnectUrls?: readonly (string | undefined)[];
  /**
   * Identity-kind allowlist for tool registration. When set, handlers
   * whose `allowedFor` field is non-empty AND does NOT intersect this
   * list are skipped at registration time (NOT registered with the MCP
   * server, NOT visible in `tools/list`).
   *
   * Handlers without `allowedFor` are registered unconditionally per the
   * "anyone authenticated" default in
   * `packages/mcp-server-handlers/src/types.ts:151-153`. Omitting this
   * option (or passing `undefined`) disables filtering entirely —
   * today's behavior, kept for OSS callers (resolved as
   * `kind: 'builder'`) so an OSS deployment never accidentally gates
   * itself off.
   *
   * Production postures:
   *   - agent-builder posture: `allowedKinds: ['app']`
   *   - end-user / Connector posture: `allowedKinds: ['user']`
   *   - OSS local: omit (every handler registers regardless)
   */
  readonly allowedKinds?: ReadonlyArray<'app' | 'user' | 'builder'>;

  /**
   * Server-level instructions string injected into the MCP
   * `InitializeResult.instructions` field. Hosts (Claude.ai web,
   * Claude Desktop, MCP Inspector) inject this into the LLM's system
   * prompt as a top-level block, ABOVE per-tool descriptions —
   * influencing "how should I behave with this server's tools
   * generally?" vs. per-tool "should I pick THIS tool right now?"
   *
   * Resolved upstream by `resolveMcpInstructions` from a preset name
   * or arbitrary string. Pass `undefined` here to omit the field
   * (host falls back to per-tool descriptions only).
   *
   * See `instructions-presets.ts` for the supported preset enum and
   * full rationale.
   */
  readonly instructions?: string;

  /**
   * Hooks invoked once the per-request `McpServer` is constructed,
   * after the MCP-Apps outbound install (when enabled) and before
   * any tool registration. Each entry receives the fresh `McpServer`
   * and may register additional resources / resource templates.
   *
   * Use case: hosted deployments that mount cross-cutting MCP App
   * UI bundles (e.g. a `ui://`-scheme resource for welcome /
   * account-status cards) without baking the bundle's wiring into
   * this OSS factory. The closure runs on every fresh server
   * instance, mirroring the per-request `installMcpAppsOutbound`
   * lifecycle.
   *
   * Each registrar SHOULD be idempotent across calls (the underlying
   * SDK throws on duplicate URIs anyway). Errors thrown by a
   * registrar propagate up — the request fails before any tool can
   * dispatch, surfacing misconfiguration loudly rather than 404-ing
   * `resources/read` later.
   */
  readonly extraResources?: ReadonlyArray<(server: McpServer) => void>;

  /**
   * Withhold every handler's per-result bootstrap MATERIAL from tool
   * results — the read-plane-only posture.
   *
   * By default a successful tool result carries the handler's
   * `resultMeta` — for `ggui_render` / `ggui_update` that is the
   * `ai.ggui/render` bootstrap a host may mount DIRECTLY without any
   * further round-trip, plus the spec-canonical pointer `_meta.ui.
   * resourceUri`. Setting this makes the server publish only the
   * durable IDENTITY: `structuredContent.resourceUri` (the `ui://`
   * locator) and — the same value, on the wire slot MCP Apps hosts
   * read — `_meta.ui.resourceUri` (+ the legacy flat `ui/resourceUri`).
   * `resultMeta` is never invoked (no bootstrap token is minted for a
   * slice nobody receives); the pointer is derived from the validated
   * OUTPUT itself, the single source of truth `resultMeta` reuses.
   * A host MUST resolve every view by an authenticated `resources/read`
   * — the persisted-locator path — before it can mount anything.
   *
   * Why the pointer stays (ggui#537): the identity IS the pointer.
   * Spec-canonical hosts (claude.ai, Claude Desktop, `@ggui-ai/
   * mcp-apps-react`'s chat-helpers, the OSS samples) mount the
   * per-render self-contained shell that `_meta.ui.resourceUri` names —
   * a `resources/read` the HOST performs, exactly the read-plane path
   * this posture wants. The first arm (f8c93405d) stripped `_meta`
   * wholesale, which took the pointer with it and left every such host
   * with the declaration-level static shell and a result it could not
   * mount from ("Waiting for tool result…", prod 2026-08-16→17).
   *
   * That is a deployment posture, not a debug switch: a hosted
   * deployment that wants "views mount only through the read plane"
   * (thread-scoped ownership checks, fresh per-read credentials, no
   * inlined bootstrap material crossing a chat transcript) states it
   * here by construction, and any host that still expects the inlined
   * bootstrap fails loudly (a locator it cannot resolve) instead of
   * silently mounting stale material. `structuredContent` and `content`
   * are untouched; only `_meta` is withheld.
   */
  readonly withholdResultMeta?: boolean;
}

/**
 * Build a fresh MCP server with every handler registered.
 *
 * `getContext` is a late-binding accessor so the HTTP layer can thread
 * per-request context (via AsyncLocalStorage or a closure) without
 * leaking the shape into this module.
 */
/**
 * The identity-only `_meta` a withholding server publishes (ggui#537):
 * when the validated output carries a `ui://` `resourceUri` (the durable
 * locator `ggui_render` / `ggui_update` surface on structuredContent),
 * mirror it onto the spec-canonical `_meta.ui.resourceUri` slot MCP
 * Apps hosts read (+ the legacy flat key), and nothing else. Same value
 * `resultMeta` would have stamped, without invoking it — no bootstrap
 * material, no minted token. `undefined` for outputs without a locator.
 */
function identityPointerMeta(validated: unknown): Record<string, unknown> | undefined {
  if (!isRecord(validated)) return undefined;
  const uri = validated['resourceUri'];
  if (typeof uri !== 'string' || !uri.startsWith('ui://')) return undefined;
  return { ui: { resourceUri: uri }, 'ui/resourceUri': uri };
}

/** Whether a failure payload declares itself a pre-generation refusal. */
function declaresRefusedOutcome(payload: unknown): boolean {
  return isRecord(payload) && payload['outcome'] === 'refused';
}

/**
 * Validate an outbound tool payload — success or failure — before it
 * reaches the wire.
 *
 * A tool's `outputSchema` is a raw FIELD RECORD, because that is what
 * the MCP SDK registers. Rebuilding it here with `z.object(shape)`
 * therefore drops every cross-field refinement the tool's composed
 * protocol schema carries — which would leave rules like ggui#786's
 * "a refused result carries `refusal` and NOTHING else" and
 * "present-iff-committed on the rendered / failed arms" unenforced at
 * the very seam that is supposed to enforce them.
 *
 * So a handler that declares {@link SharedHandler.outputEnvelopeSchema}
 * gets validated against THAT (same object, same unknown-key
 * stripping, plus its refinements); every other handler keeps today's
 * rebuilt-shape validation verbatim. Either way a non-conformant
 * payload throws — loudly at the transport, never silently on the
 * wire.
 */
function validateOutputPayload(
  handler: SharedHandler<ZodRawShape, ZodRawShape>,
  payload: unknown,
): Record<string, unknown> {
  const envelope = handler.outputEnvelopeSchema;
  const validated: unknown =
    envelope !== undefined
      ? envelope.parse(payload)
      : z.object(handler.outputSchema).parse(payload);
  // `ZodType.parse` widens to `unknown`, and the MCP result's
  // `structuredContent` is a JSON OBJECT by spec. Both branches above
  // are object schemas, so this narrowing never fires in practice — but
  // it is a real check rather than an assertion, and a handler that
  // ever declares a non-object envelope fails here by name.
  if (!isRecord(validated)) {
    throw new Error(
      `${handler.name}: validated tool output is not a JSON object — structuredContent cannot carry it`,
    );
  }
  return validated;
}

/**
 * The `tool_invoked` fields that classify a failure result (ggui#786,
 * ruling item 7). A refusal is a WIRE STATE, so it reports its own
 * `outcome` and the registry `code` that produced it — without those
 * two fields a refusal is indistinguishable from a generation failure
 * in the logs. Any other failure keeps the generic `tool_error`.
 *
 * The thrown path is untouched (`outcome: 'error'` + `errorClass`),
 * which is what makes "a gate that throws instead of returning a
 * refusal is a conformance failure" observable in ops.
 *
 * `outcome: 'refused'` has a second door since ggui#1995: a `tools/call`
 * the SDK refused before any handler ran (element ceiling, input schema,
 * unknown tool) logs the same outcome from {@link observeToolCallRefusals},
 * carrying a `reason` instead of a registry `code`. One outcome, two
 * fields: `code` names a handler's refusal, `reason` an SDK-level one.
 */
function classifyFailurePayload(
  payload: unknown,
): { readonly outcome: string; readonly code?: string } {
  if (!declaresRefusedOutcome(payload) || !isRecord(payload)) {
    return { outcome: 'tool_error' };
  }
  const refusal = payload['refusal'];
  const code = isRecord(refusal) ? refusal['code'] : undefined;
  return {
    outcome: 'refused',
    ...(typeof code === 'string' ? { code } : {}),
  };
}

/**
 * Per-session fields on the `tool_invoked` line of the session-keyed tools:
 * the three runtime tools (ggui#1377 for pull; ggui#1395 for consume and
 * submit) and the mutation and render tools (ggui#1474 — amend, update,
 * render), so an instrument joins a reaction to its tap by session.
 *
 * In a composition that wires no logger into these handlers, this line is
 * their whole trace. ggui#1376 had to be read per app and minute; these
 * fields make it per session, from the wire shapes the handlers already
 * return — ids, counts and flags, never gesture content. The return type is
 * the closed key set that posture promises: a new key is a type change here,
 * never a spread.
 *
 * What a `sessionId` on a SUCCESS line proves, per tool — never raw caller
 * input in any of them:
 *   - pull and consume: a session the caller's app owns. Both throw on an
 *     unknown or cross-app session before they return (the visibility gate),
 *     so every success line of theirs qualifies.
 *   - submit: a pipe this server holds. Only a `kind: 'dispatch'` that
 *     committed (`ok: true`) carries it — the append fails on an absent pipe
 *     and the handler answers `{ok: false, code}` (logged as `ok: false` +
 *     `code`, no session). The append checks existence, not app ownership,
 *     so the claim stops there. An audit kind (`openLink`,
 *     `requestDisplayMode`, an extension kind) touches no pipe and carries no
 *     session at all: its `sessionId` was never read by anything.
 *   - amend and update: a session the caller's app owns, read from the
 *     OUTPUT. Both run the shared mutation core, which app-scope-gates the
 *     session (`renderStore.get` + an `appId` match) and throws
 *     `GguiSessionNotFoundError` on a missing or cross-app one before any
 *     return — so the output's `sessionId` is the gated one, including when
 *     an in-process caller threads it through the context rather than the
 *     input.
 *   - render: the session id this call MINTED for the caller's app, read
 *     from the OUTPUT (never caller input — render's input names no
 *     session). A `rendered` result carries it, and so does a `failed` one
 *     (on the in-result failure line); a `refused` result mints none. It
 *     proves the id is this call's, NOT that a row backs it: the handler
 *     swallows a render-store commit rejection (the placeholder, probe,
 *     cache-hit and error-record commits, and the cold-generation success
 *     commit, which then answers `failed`), so on those paths the id names
 *     no row, or only a provisional placeholder — the claim stops there,
 *     and a consumer that needs the row reads it from the store.
 *
 * Consume adds `eventCount`, `status`, `timeoutS` (the requested timeout; 0
 * when omitted, the handler's own default) and `aborted: true` when the
 * request's signal is aborted by the time the line is written — a superset
 * of "cancelled mid-poll", read at log time, never a false negative. A
 * committed dispatch adds `consumerPresent`, the doorbell's gate.
 *
 * `ggui_runtime_sync_context` is not a session tool here: a refused sync's
 * session is only claimed. Its line names a refusal (`ok: false` and the
 * `code`) and nothing else from this function. A tool that declares a view
 * proof (ggui#1415) also carries the measuring gate's fields and
 * `authSource` on every one of its lines (`view-proof-gate.ts`).
 */
const SESSION_TOOLS: ReadonlySet<string> = new Set([
  'ggui_runtime_pull',
  'ggui_consume',
  'ggui_runtime_submit_action',
  'ggui_amend',
  'ggui_update',
  'ggui_render',
]);

/** ggui#1474 — session tools whose logged session is the OUTPUT's (the gated or committed one), not the input's. */
const OUTPUT_SESSION_TOOLS: ReadonlySet<string> = new Set(['ggui_amend', 'ggui_update', 'ggui_render']);


interface SessionLogFields {
  readonly sessionId?: string;
  readonly eventCount?: number;
  readonly status?: string;
  readonly timeoutS?: number;
  readonly aborted?: true;
  readonly consumerPresent?: boolean;
  readonly ok?: false;
  readonly code?: string;
}

function sessionFields(
  tool: string,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  ctx: HandlerContext,
): SessionLogFields {
  // ggui#1415: a sync names its refusal (`ok: false` and the code) so a
  // refused call is countable. Its session is not logged as owned: a
  // refused call's session is only claimed (the gate's `claimedSessionId`).
  if (tool === 'ggui_runtime_sync_context') {
    if (output['ok'] === true) return {};
    return typeof output['code'] === 'string' ? { ok: false, code: output['code'] } : { ok: false };
  }
  if (!SESSION_TOOLS.has(tool)) return {};
  const sessionId = OUTPUT_SESSION_TOOLS.has(tool) ? output['sessionId'] : input['sessionId'];
  if (typeof sessionId !== 'string' || sessionId === '') return {};
  if (tool === 'ggui_runtime_submit_action') {
    if (input['kind'] !== 'dispatch') return {};
    if (output['ok'] !== true) {
      return typeof output['code'] === 'string' ? { ok: false, code: output['code'] } : { ok: false };
    }
    return {
      sessionId,
      ...(typeof output['consumerPresent'] === 'boolean'
        ? { consumerPresent: output['consumerPresent'] }
        : {}),
    };
  }
  if (tool === 'ggui_consume') {
    const events = output['events'];
    return {
      sessionId,
      ...(Array.isArray(events) ? { eventCount: events.length } : {}),
      ...(typeof output['status'] === 'string' ? { status: output['status'] } : {}),
      timeoutS: typeof input['timeout'] === 'number' ? input['timeout'] : 0,
      ...(ctx.signal?.aborted === true ? { aborted: true } : {}),
    };
  }
  return { sessionId };
}

/** Bound on `claimedSessionId`: a real id is a UUID; anything longer is not one. */
const CLAIMED_SESSION_ID_MAX_CHARS = 128;

/**
 * The caller's CLAIMED session on an `outcome: 'error'` line of the session
 * tools (ggui#1395; amend and update since ggui#1474). Render's input schema
 * declares no `sessionId` and the MCP SDK strips undeclared keys before the
 * handler runs, so a render line never carries a claim. A refused consume — unknown or cross-app
 * session, the visibility gate — is the one failure of the tap → consume
 * chain that is otherwise invisible per session. It is raw caller input,
 * the first on this line: named as a claim so it never reads as an owned
 * session, and cut to {@link CLAIMED_SESSION_ID_MAX_CHARS} with a flag so a
 * caller cannot put arbitrary text in a log under a field that promises an
 * id.
 */
function claimedSessionField(
  tool: string,
  input: Record<string, unknown>,
): { readonly claimedSessionId?: string; readonly claimedSessionIdTruncated?: true } {
  if (!SESSION_TOOLS.has(tool)) return {};
  const sessionId = input['sessionId'];
  if (typeof sessionId !== 'string') return {};
  if (sessionId.length <= CLAIMED_SESSION_ID_MAX_CHARS) return { claimedSessionId: sessionId };
  return {
    claimedSessionId: sessionId.slice(0, CLAIMED_SESSION_ID_MAX_CHARS),
    claimedSessionIdTruncated: true,
  };
}

/**
 * Largest combined number of array elements and object members one
 * `tools/call` may carry in its `arguments` (ggui#1993). The MCP SDK
 * counts them before any schema runs and before the handler is reached;
 * a call over the ceiling takes the invalid-input door it already has —
 * `isError: true` with one text block naming the tool and the ceiling —
 * and the handler never sees it. A call at or under it is unaffected.
 *
 * The number: the largest legitimate tool input in this repository's
 * corpora is about a thousand elements (a benchmark render of a
 * 41-element contract with 945 elements of props; conformance-kit cases
 * stay under 120; a theme document is ~325), so ten thousand is an order
 * of magnitude of headroom over anything the surface is asked to carry
 * today. Strings do not count toward it, however long. It bounds the
 * work a request can ask of schema validation; the request body limit
 * bounds everything else, and lives with the transport.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 10_000;

export function buildMcpServer(
  info: ServerInfo,
  handlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>,
  getContext: () => HandlerContext,
  logger: Logger,
  opts: BuildMcpServerOptions = {},
): McpServer {
  // `instructions` is a ServerOptions field (the SECOND argument): the
  // SDK sends it in the `initialize` result. In the first argument (the
  // Implementation) it was dropped, and no host ever received it (ggui#1579).
  // The element ceiling rides the same options object: every server this
  // function builds carries it, on every mount (ggui#1993).
  const server = new McpServer(
    {
      name: info.name,
      version: info.version,
      ...(info.description ? { description: info.description } : {}),
    },
    {
      maxToolInputElements: opts.maxToolInputElements ?? MAX_TOOL_INPUT_ELEMENTS,
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
    },
  );
  // ggui#1995 — what `observeToolCallRefusals` pairs a `tools/call` answer
  // against: the request ids whose registered callback ran, and the names
  // this server registered (an unknown name is refused by the SDK too).
  const accounting: ToolCallAccounting = {
    invoked: new Set<RequestId>(),
    tools: new Set(handlers.map((h) => h.name)),
  };
  TOOL_CALL_ACCOUNTING.set(server, accounting);

  // Content-addressed shell URI (stale-shell bust) — when MCP Apps
  // outbound wiring registers the shell, declarations advertising the
  // BARE `ui://ggui/render` are rewritten to the versioned twin below
  // so host prefetch caches key on content, not on a constant string.
  let shellResourceUri: string | undefined;
  if (opts.mcpAppsOutbound) {
    ({ shellResourceUri } = installMcpAppsOutbound(server, {
      ...(opts.shellHtml !== undefined ? { shellHtml: opts.shellHtml } : {}),
      ...(opts.loadingIndicator !== undefined
        ? { loadingIndicator: opts.loadingIndicator }
        : {}),
      getContext,
      // Thread the same per-request context accessor + logger the tool
      // path uses (`getContext`, param 3 of `buildMcpServer`) so the
      // per-session resource handler's render-read gate sees the
      // caller (`renderReadAllowed`, @ggui-ai/mcp-server-handlers/renders).
      ...(opts.selfContained !== undefined
        ? {
            selfContained: {
              ...opts.selfContained,
              getContext,
              logger,
              ...(opts.issueViewKeys === true ? { issueViewKeys: true } : {}),
            },
          }
        : {}),
      ...(opts.publicBaseUrl !== undefined
        ? { publicBaseUrl: opts.publicBaseUrl }
        : {}),
      ...(opts.extraConnectUrls !== undefined
        ? { extraConnectUrls: opts.extraConnectUrls }
        : {}),
    }));
  }

  // Per-request resource registrars supplied by the host. Run BEFORE
  // tool registration so `tools/list` ordering is unaffected and any
  // registrar-thrown error fails the request before tool dispatch.
  if (opts.extraResources) {
    for (const register of opts.extraResources) {
      register(server);
    }
  }

  const allowedKinds = opts.allowedKinds;
  for (const handler of handlers) {
    // Identity-kind gate. Skipping at registration time (rather than at
    // call dispatch) means a curated deployment's `tools/list` reflects
    // exactly what callers can use — no "ghost" tools that 401 on
    // invocation. Handlers without `allowedFor` register regardless.
    if (
      allowedKinds !== undefined
      && handler.allowedFor !== undefined
      && handler.allowedFor.length > 0
      && !handler.allowedFor.some((kind) => allowedKinds.includes(kind))
    ) {
      continue;
    }
    const cb = async (
      input: Record<string, unknown>,
      extra: { _meta?: unknown; signal?: AbortSignal; requestId?: RequestId },
    ) => {
      // ggui#1995 — the callback ran for this request: whatever answer
      // leaves for this id is the handler's, not an SDK-level refusal.
      if (extra?.requestId !== undefined) accounting.invoked.add(extra.requestId);
      // Thread per-request `_meta` AND the cancellation `signal` onto the
      // canonical context. The MCP SDK already parses `params._meta` for
      // us and exposes it on `RequestHandlerExtra._meta`; handlers that
      // read host-channel slices (e.g. `ai.ggui/host-session` on
      // `ggui_handshake`) pick it up via `ctx.requestMeta` without
      // touching the SDK surface themselves. The same
      // `RequestHandlerExtra` carries `signal: AbortSignal` — fired by
      // the SDK on a `notifications/cancelled` from the caller OR on
      // transport close (this server wires `res.on("close") →
      // transport.close()`, which aborts every in-flight request
      // handler). `ggui_consume` reads `ctx.signal` to break its
      // long-poll promptly on a disconnected consumer, releasing the
      // active-consumer count instead of zombie-holding it to the
      // deadline. Both ride the canonical context without leaking the
      // SDK type into the handlers package.
      const baseCtx = getContext();
      // `_meta` is `unknown` at the SDK seam; per JSON-RPC it MUST be
      // an object, so narrow with the validating predicate and DROP
      // anything else rather than asserting.
      const requestMeta = extra?._meta;
      const requestCtx: HandlerContext = {
        ...baseCtx,
        ...(isRecord(requestMeta) ? { requestMeta } : {}),
        ...(extra?.signal !== undefined ? { signal: extra.signal } : {}),
      };
      const start = Date.now();
      // ggui#1415: the measuring gate. For a tool that declares a view
      // proof it verifies the proof, puts the verdict (and the request's
      // row-read memo) on the context and returns the line's proof fields.
      // Total: it never throws and never changes the handler's answer.
      const gated = await runViewProofGate(opts.viewProofGate, handler, input, requestCtx);
      const ctx = gated.ctx;
      const proofFields = {
        ...gated.fields,
        ...(ctx.authSource !== undefined && (handler.viewProof !== undefined || handler.name === 'ggui_runtime_declare_tool_catalog')
          ? { authSource: ctx.authSource }
          : {}),
      };
      try {
        const data = await handler.handler(input, ctx);
        // First-class in-result failure channel. A handler that
        // returns the `HandlerFailure` marker gets an `isError: true`
        // TOOL RESULT (never a thrown/JSON-RPC error): the marker's
        // `errorText` is the model-visible content, and its `data` is
        // validated against the SAME outputSchema as a success — MCP
        // SDK clients validate structuredContent against outputSchema
        // even when isError is set, so the envelope stays
        // schema-conformant. NO `_meta` on failures: `resultMeta` is
        // not invoked, so no mount affordance / bootstrap slice is
        // emitted for a failed call.
        if (isHandlerFailure(data)) {
          const validated = validateOutputPayload(handler, data.data);
          logger.warn('tool_invoked', {
            tool: handler.name,
            appId: ctx.appId,
            ...classifyFailurePayload(data.data),
            // A HandlerFailure sits past the handler's own gates (consume's
            // malformed-row refusal, ggui#839), so its session is owned and
            // the per-session fields apply (ggui#1395).
            ...sessionFields(handler.name, input, validated, ctx),
            ...proofFields,
            elapsedMs: Date.now() - start,
          });
          return {
            isError: true as const,
            structuredContent: validated,
            content: [{ type: 'text' as const, text: data.errorText }],
          };
        }
        const validated = validateOutputPayload(handler, data);
        // Per-result `_meta` — NOT merged into structuredContent, so
        // agents that typecheck against the tool signature never see
        // it. This is where view-only bootstrap material lives. Under
        // the withhold posture only the identity pointer is published,
        // derived from the output (see `withholdResultMeta`).
        const meta =
          opts.withholdResultMeta === true
            ? identityPointerMeta(validated)
            : await handler.resultMeta?.(data, input, ctx);
        logger.info('tool_invoked', {
          tool: handler.name,
          appId: ctx.appId,
          outcome: 'success',
          ...sessionFields(handler.name, input, validated, ctx),
          ...proofFields,
          elapsedMs: Date.now() - start,
        });
        // When the handler's output carries a `nextStep`, lead the
        // model-visible content with the imperative in PLAIN TEXT.
        // Burying the chain cue inside the JSON block proved fragile
        // on live hosts (the first claude.ai #471 test: the agent
        // rendered, never noticed `nextStep`, ended its turn, and the
        // user's click had no listener). The JSON stays second —
        // structured consumers read `structuredContent` anyway.
        const nextStepHint =
          validated !== null &&
          typeof validated === 'object' &&
          'nextStep' in validated &&
          (validated as { nextStep?: { example?: unknown } }).nextStep &&
          typeof (validated as { nextStep: { example?: unknown } }).nextStep
            .example === 'string'
            ? (validated as { nextStep: { example: string } }).nextStep.example
            : undefined;
        // The gesture-poll wrapper below describes ggui_consume's
        // semantics ("catch an immediate gesture", "waits up to 25s")
        // — it is ONLY true when the nextStep IS the consume hint.
        // Ungated, it decorated ggui_handshake results too (whose
        // nextStep is a ggui_render example), telling agents a
        // not-yet-rendered UI "has interactive actions" — a live agent
        // flagged the contradiction against an actions=∅ contract
        // (2026-08-12).
        const gestureHint =
          nextStepHint !== undefined && nextStepHint.includes('ggui_consume')
            ? nextStepHint
            : undefined;
        // The consume → amend hint (ggui#1399 step 2) rides `nextStep` in
        // the structured result only, with NO plain-text lead (ggui#1397):
        // a lead ("repaint … then re-call ggui_consume") was measured as the
        // carrier of informational taps left unanswered on gpt-6-luna, and
        // removing it held every repaint. Probes 3 and 4 are on #1397.
        return {
          structuredContent: validated,
          content: [
            ...(gestureHint !== undefined
              ? [
                  {
                    type: 'text' as const,
                    // Gentle + bounded, deliberately: a forcing
                    // imperative hijacked live agents into polling
                    // instead of acting (matrix scenario 6), and an
                    // unbounded "re-call on empty" looped them past
                    // their turn budget. The poll is a latency
                    // optimization, not the delivery guarantee — when
                    // nobody is polling, a gesture rings the chat via
                    // ui/message and arrives as a new user message
                    // carrying its own consume directive.
                    text: `The UI has interactive actions. After this turn's work, you may call ${gestureHint} once to catch an immediate gesture (waits up to 25s); if events is empty, end your turn — later gestures arrive as new user messages.`,
                  },
                ]
              : []),
            { type: 'text' as const, text: JSON.stringify(validated) },
          ],
          ...(meta !== undefined ? { _meta: meta } : {}),
        };
      } catch (err) {
        logger.warn('tool_invoked', {
          tool: handler.name,
          appId: ctx.appId,
          outcome: 'error',
          errorClass: errorClassName(err),
          ...claimedSessionField(handler.name, input),
          ...proofFields,
          elapsedMs: Date.now() - start,
        });
        throw err;
      }
    };

    const baseConfig = {
      ...(handler.title ? { title: handler.title } : {}),
      description: handler.description,
      inputSchema: handler.inputSchema,
      // Advertised OPEN (ggui#1333); the parse stays the handler's own shape
      // in `validateOutputPayload`.
      outputSchema: openOutputObject(handler.name, handler.outputSchema),
    };

    // Dispatch on declaration-level UI meta presence. `registerAppTool`
    // (from `@modelcontextprotocol/ext-apps/server`) normalizes the
    // legacy flat key — when `_meta.ui.resourceUri` is set, it also
    // stamps `_meta["ui/resourceUri"]` for older hosts. Letting the
    // canonical helper do that work means ggui handlers carry the
    // single canonical key only; the helper owns the back-compat
    // shape. Handlers without `_meta.ui` fall through to plain
    // `registerTool` — the ext-apps helper requires `_meta.ui` to be
    // typed. A declared-but-malformed `_meta.ui` is a programming
    // error on the handler author's side — fail loud rather than
    // silently registering the tool without its UI surface.
    if (handler._meta && 'ui' in handler._meta) {
      const uiRaw = handler._meta['ui'];
      if (!isMcpUiToolMeta(uiRaw)) {
        throw new Error(
          `Tool ${handler.name} declares _meta.ui with an invalid shape — ` +
            `expected { resourceUri?: string; visibility?: ('model' | 'app')[] }.`,
        );
      }
      // Declarations author the STABLE `ui://ggui/render` constant;
      // registration swaps in the content-addressed twin so hosts
      // prefetch (and cache) the shell by its content hash. Handlers
      // stay host-cache-agnostic; the swap lives in ONE place.
      const ui =
        shellResourceUri !== undefined &&
        uiRaw.resourceUri === GGUI_RENDER_RESOURCE_URI
          ? { ...uiRaw, resourceUri: shellResourceUri }
          : uiRaw;
      registerAppTool(
        server,
        handler.name,
        {
          ...baseConfig,
          _meta: { ...handler._meta, ui },
        },
        cb,
      );
    } else {
      server.registerTool(
        handler.name,
        {
          ...baseConfig,
          ...(handler._meta ? { _meta: handler._meta } : {}),
        },
        cb,
      );
    }
  }

  return server;
}

/**
 * Validating narrower for declaration-level MCP-Apps UI meta. The
 * `SharedHandler` seam types `_meta` as `Record<string, unknown>`;
 * `registerAppTool` requires `_meta.ui` typed as `McpUiToolMeta`.
 * Validates the two fields the ext-apps helper actually reads —
 * `resourceUri` (string when present) and `visibility`
 * (`"model"`/`"app"` array when present) — instead of asserting
 * blindly across the SDK seam.
 */
function isMcpUiToolMeta(value: unknown): value is McpUiToolMeta {
  if (!isRecord(value)) return false;
  if (value.resourceUri !== undefined && typeof value.resourceUri !== 'string') {
    return false;
  }
  if (value.visibility !== undefined) {
    if (!Array.isArray(value.visibility)) return false;
    if (!value.visibility.every((v) => v === 'model' || v === 'app')) {
      return false;
    }
  }
  return true;
}

function errorClassName(err: unknown): string {
  if (err instanceof Error) {
    if (err.name && err.name !== 'Error') return err.name;
    return err.constructor.name || 'Error';
  }
  return 'Unknown';
}

/** ggui#1995 — per-server pairing state for {@link observeToolCallRefusals}. */
interface ToolCallAccounting {
  /** Request ids of `tools/call`s whose registered callback ran. */
  readonly invoked: Set<RequestId>;
  /** Tool names this server registered. */
  readonly tools: ReadonlySet<string>;
}
const TOOL_CALL_ACCOUNTING = new WeakMap<McpServer, ToolCallAccounting>();

/**
 * Why an SDK-level `tools/call` refusal was refused, as far as the server
 * can tell without the SDK exposing it (ggui#1995):
 *
 *   - `elements_over_ceiling` — the SDK's element-count door
 *     (`maxToolInputElements`, {@link MAX_TOOL_INPUT_ELEMENTS}). Classified
 *     by the SDK's own sentence, which `build-mcp.test.ts` pins as the
 *     refusal text — an SDK wording change reds that pin before it could
 *     silently reclassify every over-ceiling refusal here.
 *   - `unknown_tool` — a name this server never registered.
 *   - `input_rejected` — every other `isError` answer the handler never saw:
 *     the SDK's input-schema validation, a disabled tool.
 *   - `rpc_error` — answered as a JSON-RPC `error` member rather than a
 *     tool result (in SDK 1.32.1 only `UrlElicitationRequired` leaves this
 *     way).
 */
export type ToolCallRefusalReason = 'elements_over_ceiling' | 'unknown_tool' | 'input_rejected' | 'rpc_error';

const CEILING_SENTENCE = 'arguments contain more than the maximum of';

/**
 * ggui#1995 — every answered `tools/call` produces exactly one `tool_invoked`
 * line. The SDK refuses an over-ceiling or schema-failing call inside its
 * own handler, before the callback {@link buildMcpServer} registers, so the
 * refusal is observable on the wire (`isError`) yet, without this, invisible
 * in ops logs. There is no pre-dispatch seam in the SDK (`registerTool`
 * takes zod only; the element counter is module-private), so the rule is
 * structural and read at the transport: **a `tools/call` answered — by
 * `result.isError` or by a JSON-RPC `error` — whose request id the callback
 * never saw is an SDK-level refusal**, logged as `tool_invoked` with
 * `outcome: 'refused'` and a {@link ToolCallRefusalReason}. The same event
 * name as every other call, so an operator's per-tool counts include the
 * refusals; the fields are the tool name, the request id and the app —
 * never the arguments or the SDK's message (a schema message can carry
 * received values).
 *
 * A decorator, not a patch: it implements `Transport` around the real one
 * and is what `McpServer.connect` receives, so nothing on the SDK's object
 * is replaced and the order of `connect` does not matter. A `tools/call`
 * whose transport closes before an answer is a non-event here — the
 * obligation is on answered calls.
 *
 * Parties: this server ↔ its operator's log consumer. Failure mode: a
 * refusal with no line. Observable violation: `build-mcp.test.ts`
 * (ggui#1995) and the route test over HTTP.
 */
export function observeToolCallRefusals(
  inner: Transport,
  server: McpServer,
  logger: Logger,
  getContext: () => HandlerContext,
): Transport {
  const accounting = TOOL_CALL_ACCOUNTING.get(server);
  if (!accounting) {
    throw new Error('observeToolCallRefusals: the server was not built by buildMcpServer');
  }
  return new ToolCallRefusalObserver(inner, accounting, logger, getContext);
}

class ToolCallRefusalObserver implements Transport {
  /** `tools/call` requests seen inbound and not yet answered: id → tool name. */
  private readonly pending = new Map<RequestId, string>();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly inner: Transport,
    private readonly accounting: ToolCallAccounting,
    private readonly logger: Logger,
    private readonly getContext: () => HandlerContext,
  ) {
    inner.onmessage = (message, extra) => {
      if (isJSONRPCRequest(message) && message.method === 'tools/call') {
        const name = message.params?.['name'];
        this.pending.set(message.id, typeof name === 'string' ? name : '');
      }
      this.onmessage?.(message, extra);
    };
    inner.onclose = () => {
      this.pending.clear();
      this.onclose?.();
    };
    inner.onerror = (error) => this.onerror?.(error);
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.observe(message);
    return this.inner.send(message, options);
  }

  private observe(message: JSONRPCMessage): void {
    let id: RequestId;
    let reason: ToolCallRefusalReason | undefined;
    if (isJSONRPCResponse(message)) {
      id = message.id;
      const result = message.result;
      if (result['isError'] !== true) {
        this.pending.delete(id);
        return;
      }
      reason = 'input_rejected';
      const content = result['content'];
      const first = Array.isArray(content) ? content[0] : undefined;
      const text = isRecord(first) && typeof first['text'] === 'string' ? first['text'] : '';
      if (text.includes(CEILING_SENTENCE)) reason = 'elements_over_ceiling';
    } else if (isJSONRPCErrorResponse(message)) {
      // An error response may carry no id (a parse error); nothing to pair.
      if (message.id === undefined) return;
      id = message.id;
      reason = 'rpc_error';
    } else {
      return;
    }
    const tool = this.pending.get(id);
    this.pending.delete(id);
    if (tool === undefined || this.accounting.invoked.has(id)) return;
    if (reason !== 'rpc_error' && !this.accounting.tools.has(tool)) reason = 'unknown_tool';
    this.logger.warn('tool_invoked', {
      tool,
      appId: this.getContext().appId,
      outcome: 'refused',
      reason,
      requestId: String(id),
    });
  }
}
