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
import { z, type ZodRawShape } from 'zod';
import type {
  HandlerContext,
  SharedHandler,
} from '@ggui-ai/mcp-server-handlers';
import type { Logger } from './logger.js';
import {
  installMcpAppsOutbound,
  type GguiSessionResourceTemplateOptions,
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
   * capability and serves `ui://ggui/session` via `resources/read`.
   *
   * Tool-declaration `_meta.ui.*` is INDEPENDENT of this flag; it's
   * carried per-handler on `SharedHandler._meta`. A server can stamp
   * those without turning the outbound wiring on, but serving the
   * resource without stamping the declaration is pointless, so the
   * canonical path is "enable both together" via `createGguiServer`.
   */
  readonly mcpAppsOutbound?: boolean;
  /**
   * Optional override for the `ui://ggui/session` shell body. Defaults
   * to whatever shell the server was built with — either a placeholder
   * or the real thin-shell HTML.
   */
  readonly shellHtml?: string;
  /**
   * Per-session self-contained shell options. When supplied,
   * `installMcpAppsOutbound` ALSO registers
   * `ui://ggui/session/{sessionId}` as a resource template — the URI
   * `ggui_push.resultMeta` stamps on per-call `_meta.ui.resourceUri`
   * for third-party MCP Apps hosts (Claude Desktop, claude.ai web)
   * that don't speak ggui's custom postMessage protocol.
   *
   * Absent → only the legacy postMessage shell is registered (first-
   * party hosts only).
   */
  readonly selfContained?: GguiSessionResourceTemplateOptions;
  /**
   * Public origin the server is reachable at — forwarded to
   * `installMcpAppsOutbound` so the static `ui://ggui/session`
   * resource declares `_meta.ui.csp.{connectDomains,resourceDomains}`.
   * Without this, spec-compliant hosts (Claude Desktop, claude.ai
   * Connector, Claude Code) apply their default CSP (`connect-src
   * 'none'`) and the iframe can't fetch the runtime bundle or open
   * the WebSocket. Omit when running same-origin behind a first-party
   * host that owns the iframe CSP itself.
   */
  readonly publicBaseUrl?: string;
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
}

/**
 * Build a fresh MCP server with every handler registered.
 *
 * `getContext` is a late-binding accessor so the HTTP layer can thread
 * per-request context (via AsyncLocalStorage or a closure) without
 * leaking the shape into this module.
 */
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

  if (opts.mcpAppsOutbound) {
    installMcpAppsOutbound(server, {
      ...(opts.shellHtml !== undefined ? { shellHtml: opts.shellHtml } : {}),
      ...(opts.selfContained !== undefined
        ? { selfContained: opts.selfContained }
        : {}),
      ...(opts.publicBaseUrl !== undefined
        ? { publicBaseUrl: opts.publicBaseUrl }
        : {}),
    });
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
    server.registerTool(
      handler.name,
      {
        ...(handler.title ? { title: handler.title } : {}),
        description: handler.description,
        inputSchema: handler.inputSchema,
        outputSchema: handler.outputSchema,
        // Forward declaration-level `_meta` (e.g. `_meta.ui.resourceUri`
        // / `_meta.ui.visibility` stamped by the MCP Apps outbound path).
        // Opaque to the transport — hosts consume it per their own spec.
        ...(handler._meta ? { _meta: handler._meta } : {}),
      },
      async (input: Record<string, unknown>, extra) => {
        // Thread per-request `_meta` onto the canonical context. The MCP
        // SDK already parses `params._meta` for us and exposes it on
        // `RequestHandlerExtra._meta`; handlers that read host-channel
        // slices (e.g. `ai.ggui/host-session` on `ggui_new_session`)
        // pick it up via `ctx.requestMeta` without touching the SDK
        // surface themselves.
        const baseCtx = getContext();
        const ctx: HandlerContext =
          extra?._meta !== undefined
            ? {
                ...baseCtx,
                requestMeta: extra._meta as Readonly<Record<string, unknown>>,
              }
            : baseCtx;
        const start = Date.now();
        try {
          const data = await handler.handler(input, ctx);
          const validated = z.object(handler.outputSchema).parse(data);
          // Per-result `_meta` — NOT merged into structuredContent, so
          // agents that typecheck against the tool signature never see
          // it. This is where view-only bootstrap material lives.
          const meta = await handler.resultMeta?.(data, input, ctx);
          logger.info('tool_invoked', {
            tool: handler.name,
            appId: ctx.appId,
            outcome: 'success',
            elapsedMs: Date.now() - start,
          });
          return {
            structuredContent: validated as Record<string, unknown>,
            content: [
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
      },
    );
  }

  return server;
}

function errorClassName(err: unknown): string {
  if (err instanceof Error) {
    if (err.name && err.name !== 'Error') return err.name;
    return err.constructor.name || 'Error';
  }
  return 'Unknown';
}
