/**
 * mcp-mounts — aggregate external MCP tool handler bundles onto the
 * ggui `/mcp` surface so one session can see ggui-native tools (e.g.
 * `ggui_push`) AND mounted tools (e.g. `tasks_*`) through a single
 * MCP connection.
 *
 * Scope lock: a **mount** is a named bundle of `SharedHandler`
 * instances. That's the same runtime contract ggui's own default
 * handlers already satisfy — no proxy, no in-memory MCP wire, no
 * extra registry. A fixture (or any host package) that wants to
 * expose its tools on the OSS path builds `SharedHandler[]` against
 * the same seams ggui's native handlers use, wraps them in a mount,
 * and passes the mount to {@link CreateGguiServerOptions.mcpMounts}.
 *
 * The narrower "proxy an external MCP server whose source you can't
 * modify" path (connector registry + `tools/list` forwarding) is
 * deliberately NOT handled here — it is a separate seam. The bundle
 * seam is the smallest honest shape for in-process mounts: it reuses
 * the exact same handler interface, so collision checks,
 * `buildMcpServer` registration, `toolCount`, telemetry, and logging
 * all Just Work.
 */
import type { HandlerContext, SharedHandler } from "@ggui-ai/mcp-server-handlers";
import type { ZodRawShape } from "zod";
import type { WiredActionContext, WiredActionRouter } from "./render-channel.js";

/**
 * Runtime ctx the mount-router hands the mount handler. Structurally a
 * superset of `HandlerContext` (so the mount's `handler(input, ctx)`
 * signature stays unchanged) PLUS the wired-action-only fields from
 * {@link WiredActionContext}.
 *
 * Why the type is exported: TS-authored mount tools that want to read
 * `ctx.sendPropsUpdate` / `ctx.stackItemId` import this and narrow their
 * `handler` parameter (e.g. `async handler(input, ctx) { const wired =
 * ctx as WiredMountContext; … }`). JS-authored mounts (.mjs) read the
 * fields structurally — they're present on the runtime object whether
 * or not the static type knows about them.
 *
 * The static `SharedHandler.handler` signature deliberately stays
 * narrow on `HandlerContext`. Widening that type would force every
 * shared handler (ggui-native + mounted) to acknowledge a wired-only
 * surface, even handlers that never run through the wired-action path
 * (e.g. `ggui_push`, blueprint search). The structural superset here
 * keeps the canonical contract narrow without sacrificing access for
 * mount tools that opt in.
 */
/**
 * Intersection (not interface-extension) because `HandlerContext` declares
 * `sessionId?` / `stackItemId?` as optional — the canonical context shape any
 * handler may see — whereas `WiredActionContext` declares them as required
 * (the wired-action dispatcher always knows the active session + stack
 * frame at invocation time). Interface-extends rejects "narrowing
 * optional → required" via TS2320 ("cannot simultaneously extend"), but
 * an intersection composes the two perfectly: optional ∧ required ≡ required.
 *
 * Surface for consumers stays identical — a TS-authored mount that types
 * its `handler` parameter as `WiredMountContext` reads `sessionId: string`
 * + `stackItemId: string` (no `| undefined`) + every `HandlerContext` field
 * (`appId`, `requestId`, optional `apiKeyHash`).
 */
export type WiredMountContext = Omit<HandlerContext, "renderId"> & WiredActionContext;

/**
 * One named bundle of tool handlers the server should aggregate onto
 * its MCP surface.
 *
 * `name` is diagnostic-only — it shows up in collision-error messages
 * and composition telemetry so an operator running `ggui serve` with
 * three mounts can tell which one is misconfigured. It does NOT appear
 * on the wire; tool names stay whatever each handler declares.
 */
export interface McpServerMount {
  /**
   * Human-readable mount identifier. Surfaced in collision errors and
   * `server.composed` telemetry. No uniqueness constraint across mounts
   * (two mounts named `"tasks"` compose fine as long as their tool-name
   * sets don't collide).
   */
  readonly name: string;
  /**
   * Tool handler bundle. Each entry is a `SharedHandler` — the same
   * shape ggui-native handlers (blueprint family, renders,
   * threads) already use. The server calls {@link SharedHandler.handler}
   * through `buildMcpServer`'s regular registration path; validation,
   * logging, and output-schema parsing all happen uniformly.
   */
  readonly handlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>;
}

/**
 * Branded HTTP path for an isolated MCP service. Mint one from a
 * raw string via {@link validateServicePath}.
 */
export type ServicePath = string & { readonly __brand: "ServicePath" };

/**
 * Built-in routes the multi-service mount loop must not shadow.
 * Reserved at validation time so a typo in a host config can never
 * silently swallow OAuth discovery / health / per-app traffic.
 */
const RESERVED_SERVICE_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/mcp",
  "/protocol",
  "/ops",
  "/ws",
  "/health",
  "/.well-known",
  "/oauth",
  "/_ggui",
  "/ggui",
]);

const SERVICE_PATH_REGEX = /^\/[a-zA-Z0-9_/-]+$/;

/**
 * Validate + brand a service HTTP path. Throws on malformed input or
 * collision with a reserved built-in route.
 *
 * Rules:
 * - Must start with `/`.
 * - May contain letters, digits, `-`, `_`, and `/` (no whitespace,
 *   no `.`, no path traversal).
 * - Must not end with `/` (prevents trailing-slash variant collisions).
 * - Must not equal a reserved built-in path (`/mcp`, `/protocol`, ...).
 */
export function validateServicePath(p: string): ServicePath {
  if (!SERVICE_PATH_REGEX.test(p)) {
    throw new Error(
      `createGguiServer: mcpServices path "${p}" is malformed — must start with "/" and contain only letters, digits, "-", "_", and "/".`
    );
  }
  if (p.length > 1 && p.endsWith("/")) {
    throw new Error(
      `createGguiServer: mcpServices path "${p}" must not end with "/" (use "${p.slice(0, -1)}" instead).`
    );
  }
  if (RESERVED_SERVICE_PATHS.has(p)) {
    throw new Error(
      `createGguiServer: mcpServices path "${p}" collides with a reserved built-in route. Pick a distinct prefix (e.g. "/docs", "/playground/...").`
    );
  }
  return p as ServicePath;
}

/**
 * One isolated MCP server mounted at its own HTTP path. Unlike a
 * {@link McpServerMount} (which contributes tools to the shared
 * audience-filtered routes), a service is a complete, self-contained
 * MCP server with its own tool namespace.
 *
 * Use a **service** when the handler set is conceptually a distinct
 * MCP server (`mcp.ggui.ai/docs`, `mcp.ggui.ai/playground/todos`).
 * Use a **mount** when the handlers should appear alongside
 * ggui-native tools on the shared `/mcp` surface (fixtures, external
 * MCPs aggregated for one session's view).
 *
 * Why two concepts and not one: audience tags carry caller-class
 * semantics (`agent` vs `runtime`) that don't map 1:1 to URL paths
 * — agent + runtime both live on `/mcp` today. Collapsing audience
 * and path into a single "mount at path" model would lose that
 * caller-class distinction. Mounts and services are honest about the
 * two different things the framework actually does.
 *
 * Compose-time invariants (validated by {@link validateMcpServices}):
 * - `path` passes {@link validateServicePath}.
 * - Each handler declares a non-empty `outputSchema` (matching the
 *   mount rule — empty schemas silently strip `structuredContent`).
 * - Tool names are unique within a service. Cross-service collisions
 *   ARE allowed — services are isolated namespaces; a client connects
 *   to one path and only ever sees that path's tools.
 * - Service handlers MUST NOT set `audience`. Services bypass
 *   audience filtering entirely (the path IS the audience), so an
 *   explicit tag is silently meaningless. Reject loudly.
 * - Service paths are unique across the whole `mcpServices` array.
 */
export interface McpService {
  /**
   * Human-readable service identifier. Surfaced in validation errors
   * and telemetry. No uniqueness constraint across services — only
   * {@link path} must be unique.
   */
  readonly name: string;
  /**
   * HTTP path the service mounts at (e.g. `/docs`,
   * `/playground/todos`). Validated via {@link validateServicePath} at
   * compose time.
   */
  readonly path: string;
  /**
   * Tool handler bundle. Same shape ggui-native handlers and mount
   * handlers use. See {@link McpService} for the service-specific
   * rules layered on top of the canonical contract.
   */
  readonly handlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>;
  /**
   * When `true`, this service skips the auth chain — unauthenticated
   * requests are let through with a synthesized identity
   * (`{kind: 'builder'}`, `source: 'anonymous'`). Default `false`
   * (auth required, same posture as `/mcp` / `/protocol` / `/ops`).
   *
   * Use for first-touch public surfaces (docs MCP, landing-agent
   * demos) where requiring a bearer token would block the use case.
   * Handlers that need to distinguish anonymous from authenticated
   * traffic read `ctx` for the synthesized identity OR check the
   * underlying `source` via the broader request context.
   *
   * Anonymous services SHOULD plug into the `RateLimiter` seam
   * (per-IP + per-session keys) to prevent unbounded compute; the
   * seam is wired the same way for authenticated and anonymous
   * paths — this flag does not change rate-limit composition.
   */
  readonly anonymous?: boolean;
}

/**
 * Validate every service in the array: path well-formed + non-reserved
 * + unique across services, every handler's `outputSchema` non-empty,
 * no `audience` tags on service handlers, no within-service tool-name
 * collisions. Returns the input list when valid; throws with the
 * offending service name + path embedded in the message otherwise.
 *
 * Cross-service tool-name collisions are deliberately NOT checked —
 * services are isolated namespaces by design.
 *
 * No side effects — safe to call multiple times. Returns the input
 * reference unchanged on the empty path.
 */
export function validateMcpServices(
  services: ReadonlyArray<McpService> | undefined
): ReadonlyArray<McpService> {
  if (!services || services.length === 0) return services ?? [];
  const seenPaths = new Set<string>();
  for (const svc of services) {
    if (typeof svc.name !== "string" || svc.name.length === 0) {
      throw new Error(
        "createGguiServer: every `mcpServices` entry must carry a non-empty string `name` (for validation-error clarity)."
      );
    }
    validateServicePath(svc.path);
    if (seenPaths.has(svc.path)) {
      throw new Error(
        `createGguiServer: mcpServices path "${svc.path}" is declared by more than one service. Each service must mount at a distinct path.`
      );
    }
    seenPaths.add(svc.path);
    const seenTools = new Set<string>();
    for (const h of svc.handlers) {
      if (
        typeof h.outputSchema !== "object" ||
        h.outputSchema === null ||
        Object.keys(h.outputSchema).length === 0
      ) {
        throw new Error(
          `createGguiServer: service "${svc.name}" handler "${h.name}" declares an empty \`outputSchema\` — this silently strips \`structuredContent\` at the MCP SDK boundary. Declare the fields the handler returns (e.g. \`outputSchema: { items: z.array(...) }\`).`
        );
      }
      if (h.audience !== undefined) {
        throw new Error(
          `createGguiServer: service "${svc.name}" handler "${h.name}" sets \`audience\` (${JSON.stringify(h.audience)}). Services bypass audience filtering — the path "${svc.path}" IS the audience. Remove the \`audience\` field or move the handler to an aggregate mount.`
        );
      }
      if (seenTools.has(h.name)) {
        throw new Error(
          `createGguiServer: service "${svc.name}" registers tool "${h.name}" twice. Tool names must be unique within a service (cross-service collisions ARE allowed).`
        );
      }
      seenTools.add(h.name);
    }
  }
  return services;
}

/**
 * Compose a single handler list from ggui's base handlers + every
 * mount's handlers. Throws on tool-name collision so misconfiguration
 * surfaces at server-construction time, NOT on the first `tools/call`.
 *
 * Error messages intentionally mention the offending mount name so an
 * operator with several mounts can tell which bundle introduced the
 * collision without grepping their code.
 *
 * No side effects — the returned list is a fresh array even when
 * `mounts` is empty, so callers never mutate the input reference.
 */
export function composeHandlersWithMounts(
  baseHandlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>,
  mounts: ReadonlyArray<McpServerMount> | undefined
): ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>> {
  if (!mounts || mounts.length === 0) {
    return baseHandlers;
  }
  // Track ownership of every tool name so the error message can name
  // the offending source. 'ggui' = one of ggui's native handlers;
  // any other string = the mount's `name` that first claimed the tool.
  const owner = new Map<string, string>();
  for (const h of baseHandlers) owner.set(h.name, "ggui");

  const aggregated: Array<SharedHandler<ZodRawShape, ZodRawShape>> = [...baseHandlers];
  for (const mount of mounts) {
    if (typeof mount.name !== "string" || mount.name.length === 0) {
      throw new Error(
        "createGguiServer: every `mcpMounts` entry must carry a non-empty string `name` (for diagnostic telemetry + collision-error clarity)."
      );
    }
    for (const mh of mount.handlers) {
      // `outputSchema: {}` (empty `ZodRawShape`) silently strips
      // `structuredContent` at the MCP SDK boundary — the handler
      // can return `{ items: [...] }` and the wire answer is `{}`.
      // Operators hitting this see success-looking responses with
      // missing data and no diagnostic. Reject it at compose time
      // so the failure arrives with the mount + tool names
      // attached instead of showing up as a mystery at tools/call.
      //
      // Scope: mounted handlers only. ggui-native handlers are
      // under repo ownership and already correctly shaped. If a
      // legitimate no-output tool ever lands in a mount, declare
      // `{ ok: z.literal(true) }` or equivalent — the zero-field
      // case is never what you want over the wire.
      if (
        typeof mh.outputSchema !== "object" ||
        mh.outputSchema === null ||
        Object.keys(mh.outputSchema).length === 0
      ) {
        throw new Error(
          `createGguiServer: mount "${mount.name}" handler "${mh.name}" declares an empty \`outputSchema\` — this silently strips \`structuredContent\` at the MCP SDK boundary. Declare the fields the handler returns (e.g. \`outputSchema: { items: z.array(...) }\`). If the tool genuinely returns nothing, declare a sentinel like \`{ ok: z.literal(true) }\`.`
        );
      }
      const prior = owner.get(mh.name);
      if (prior !== undefined) {
        const priorLabel = prior === "ggui" ? "a ggui-native tool" : `mount "${prior}"`;
        throw new Error(
          `createGguiServer: mount "${mount.name}" registers tool "${mh.name}" which collides with ${priorLabel}. Rename the tool or drop the duplicate mount.`
        );
      }
      owner.set(mh.name, mount.name);
      aggregated.push(mh);
    }
  }
  return aggregated;
}

/**
 * Build a {@link WiredActionRouter} that dispatches wired-action
 * hits to the matching mount handler's `handler(input, ctx)`. Zero-config composition for
 * OSS `ggui serve` — when the operator declares `ggui.json#mcpMounts`,
 * every mounted tool automatically becomes wire-dispatchable from
 * a generated UI's `useAction` without additional glue.
 *
 * Ownership + scoping:
 *   - Only MOUNT handlers participate. ggui-native handlers
 *     (`ggui_push`, `ggui_handshake`, etc.) are platform tools and
 *     deliberately NOT exposed as wire-dispatchable actions — a
 *     component that tried to dispatch `ggui_push` would bypass the
 *     agentic-loop contract.
 *   - Name collisions across mounts are prevented at aggregation
 *     time by {@link composeHandlersWithMounts}, so the first-match
 *     lookup here is safe.
 *
 * Context synthesis:
 *   - Each invocation gets a fresh {@link HandlerContext} with the
 *     caller-supplied `appId` (typically the session's appId) + a
 *     fresh request id. Mount handlers that read from storage scope
 *     to this appId, matching the `/mcp` ingress behavior.
 *   - The session-channel dispatcher additionally hands a
 *     {@link WiredActionContext}. The runtime ctx the mount handler
 *     sees is a structural superset
 *     ({@link WiredMountContext}) so a JS-authored mount can call
 *     `ctx.sendPropsUpdate(ctx.stackItemId, {...})` directly. The static
 *     `SharedHandler.handler(input, ctx: HandlerContext)` shape stays
 *     untouched — tooling that doesn't read the wired fields keeps its
 *     existing types.
 *
 * Returns `null` when `mounts` is empty/absent, signaling the
 * composer to OMIT the `wiredActionRouter` opt entirely so servers
 * with no mounts behave as if the router did not exist.
 */
export function composeWiredActionRouterFromMounts(
  mounts: ReadonlyArray<McpServerMount> | undefined,
  resolveContext: () => HandlerContext
): WiredActionRouter | null {
  if (!mounts || mounts.length === 0) return null;
  const byName = new Map<string, SharedHandler<ZodRawShape, ZodRawShape>>();
  for (const mount of mounts) {
    for (const h of mount.handlers) {
      // First-write-wins matches `composeHandlersWithMounts`'s
      // collision-rejection order; the compose path throws before
      // reaching this builder, so a duplicate here is dead code.
      if (!byName.has(h.name)) byName.set(h.name, h);
    }
  }
  return {
    has(toolName: string): boolean {
      return byName.has(toolName);
    },
    async invoke(
      toolName: string,
      input: Record<string, unknown>,
      wiredCtx: WiredActionContext
    ): Promise<unknown> {
      const handler = byName.get(toolName);
      if (!handler) {
        // Unreachable in normal use — the session channel has()-gates
        // before calling invoke. Thrown errors surface as TOOL_THREW
        // envelopes, so the caller still gets a canonical shape.
        throw new Error(`wiredActionRouter(mounts): no handler registered for '${toolName}'`);
      }
      // Synthesize the runtime ctx — structural superset of
      // HandlerContext + WiredActionContext. The static
      // `SharedHandler.handler` accepts `HandlerContext`; mounts that
      // need the wired fields read them off the same `ctx` argument
      // (TS via `WiredMountContext`, JS structurally).
      const baseCtx = resolveContext();
      const ctx: WiredMountContext = {
        ...baseCtx,
        renderId: wiredCtx.renderId,
        sendPropsUpdate: wiredCtx.sendPropsUpdate,
      };
      return handler.handler(input, ctx);
    },
  };
}
