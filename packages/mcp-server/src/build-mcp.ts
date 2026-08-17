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
  installMcpAppsOutbound,
  type GguiRenderResourceTemplateOptions,
} from './mcp-apps-outbound.js';

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
}

export interface BuildMcpServerOptions {
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
   * `publicBaseUrl` (the cloud pod) pass their `wsUrl` + its ws→http
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

export function buildMcpServer(
  info: ServerInfo,
  handlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>,
  getContext: () => HandlerContext,
  logger: Logger,
  opts: BuildMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: info.name,
    version: info.version,
    ...(info.description ? { description: info.description } : {}),
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
  });

  // Content-addressed shell URI (stale-shell bust) — when MCP Apps
  // outbound wiring registers the shell, declarations advertising the
  // BARE `ui://ggui/render` are rewritten to the versioned twin below
  // so host prefetch caches key on content, not on a constant string.
  let shellResourceUri: string | undefined;
  if (opts.mcpAppsOutbound) {
    ({ shellResourceUri } = installMcpAppsOutbound(server, {
      ...(opts.shellHtml !== undefined ? { shellHtml: opts.shellHtml } : {}),
      // Thread the same per-request context accessor + logger the tool
      // path uses (`getContext`, param 3 of `buildMcpServer`) so the
      // per-session resource handler's render-read gate sees the
      // caller (render-read-gate.ts).
      ...(opts.selfContained !== undefined
        ? { selfContained: { ...opts.selfContained, getContext, logger } }
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
      extra: { _meta?: unknown; signal?: AbortSignal },
    ) => {
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
      const ctx: HandlerContext = {
        ...baseCtx,
        ...(isRecord(requestMeta) ? { requestMeta } : {}),
        ...(extra?.signal !== undefined ? { signal: extra.signal } : {}),
      };
      const start = Date.now();
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
          const validated = z.object(handler.outputSchema).parse(data.data);
          logger.warn('tool_invoked', {
            tool: handler.name,
            appId: ctx.appId,
            outcome: 'tool_error',
            elapsedMs: Date.now() - start,
          });
          return {
            isError: true as const,
            structuredContent: validated,
            content: [{ type: 'text' as const, text: data.errorText }],
          };
        }
        const validated = z.object(handler.outputSchema).parse(data);
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
          elapsedMs: Date.now() - start,
        });
        throw err;
      }
    };

    const baseConfig = {
      ...(handler.title ? { title: handler.title } : {}),
      description: handler.description,
      inputSchema: handler.inputSchema,
      outputSchema: handler.outputSchema,
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
