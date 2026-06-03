/**
 * Hono app factory + request handlers for the brand-agnostic agent
 * server. ONE agent endpoint (GET + POST `/agent`) + a manifest + an
 * adapter-mounted `/auth/*` sub-router. There is no fragmented relay /
 * proxy / sandbox-url surface — everything the frontend needs rides on
 * these routes:
 *
 *   GET  /                     — `{name, sandboxProxyUrl, mcpServers}`
 *                                manifest, used by frontends to bind.
 *                                The frontend reads `sandboxProxyUrl`
 *                                FROM HERE (there is no separate
 *                                `/sandbox-proxy-url` endpoint). Public
 *                                — no auth required (no per-principal
 *                                data).
 *
 *   GET  /agent?chatId=X       — server-authoritative chat snapshot
 *                                (replayed through the same handler
 *                                the live SSE stream uses). Auth +
 *                                ownership gated. Each recorded
 *                                tool-result's MCP-Apps resource is
 *                                RE-INLINED FRESH before replay (a
 *                                fresh `resources/read` to the MCP) so
 *                                rehydration reflects the CURRENT
 *                                server-authoritative render state, not
 *                                the frozen record-time HTML. There is
 *                                no `/api/renders/:id/state` proxy —
 *                                rehydration freshness is handled here.
 *
 *   POST /agent                — `kind`-discriminated body:
 *                                  { kind:'chat', chatId?, prompt,
 *                                    data?:{meta?} }
 *                                    → SSE stream of normalized SDK
 *                                      messages. First event is always
 *                                      `chat-allocated` carrying the
 *                                      server-allocated chat id.
 *                                  { kind:'tool-call', chatId?, name,
 *                                    arguments }
 *                                    → iframe-issued `tools/call`
 *                                      relayed to the MCP server;
 *                                      returns the `CallToolResult`
 *                                      JSON-RPC envelope as JSON (NOT
 *                                      SSE). The browser holds no MCP
 *                                      credential; this host is the
 *                                      protocol-defined relay party.
 *                                      (Folded in from the retired
 *                                      `/agent/relay/tools-call`.)
 *
 *   /auth/*                    — RESERVED for AuthAdapter.mount().
 *                                Library never registers a route here
 *                                itself. Guest-token adapter mounts
 *                                POST /auth/guest, GET /auth/me,
 *                                POST /auth/logout; bearer adapter
 *                                mounts GET /auth/me only.
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AgentToolEntry } from '@ggui-ai/protocol';
import {
  defaultAuthorizeChat,
  principalId,
  type AuthAdapter,
  type Principal,
} from './auth.js';
import { buildAgentCatalog, callMcpToolsCall } from './mcp-client.js';
import { declareToolCatalog } from './declare-tool-catalog.js';
import { interceptToolResult } from './tool-result-interceptor.js';
import { mintChatId, type ChatStore } from './chat-store.js';
import type { AgentAdapter, McpServerConfig } from './types.js';

/**
 * Per-request dependencies the route handlers reach for. Constructed
 * once in {@link createAgentApp} and closed-over by every handler.
 */
export interface AgentAppDeps {
  readonly adapter: AgentAdapter;
  readonly chatStore: ChatStore;
  /** Auth adapter — resolves Principal + (optionally) mounts /auth/*. */
  readonly auth: AuthAdapter;
  /**
   * Already-resolved MCP-server map keyed by operator-chosen name.
   * Each entry includes the bearer the library will thread through
   * on every MCP call (`tools/call`, `resources/read`).
   */
  readonly mcpServers: Record<
    string,
    { readonly url: string; readonly bearer: string }
  >;
  /**
   * System prompt the operator configured, as a three-way the adapter
   * MUST honor:
   *   - `undefined` → operator left it unset; the adapter applies its
   *     OWN default (e.g. the sample's `GGUI_AGENT_SYSTEM_PROMPT`).
   *   - `null` → operator explicitly asked for NO system prompt.
   *   - string → custom override.
   * The library MUST NOT collapse `undefined` to `null` — doing so
   * silently disables the adapter's default.
   */
  readonly systemPrompt: string | null | undefined;
  /**
   * URL of the second-origin sandbox proxy. Required because every
   * MCP-Apps iframe lives behind it.
   */
  readonly sandboxProxyUrl: string;
  /**
   * When `true`, after the canonical agent-tool catalog resolves the
   * library declares the derived `{ bareToolName -> canonical serverInfo }`
   * map to ggui via `ggui_runtime_declare_tool_catalog` — ONCE, on the
   * agent's own ggui connection (`mcpServers.ggui`, same URL + bearer ⇒
   * same `appId`). Co-located with the memoized catalog so it fires once
   * per process, not per request. Default `false`; the declaration is a
   * Tier-2 enhancement (non-fatal on failure).
   */
  readonly crossFramework?: boolean;
  /**
   * Optional logger — receives one line per significant event
   * (request received, interceptor outcome, errors). Defaults to a
   * no-op fallback when omitted at server boot.
   */
  readonly log?: (line: string) => void;
}

// Hono Variables typing for the `principal` stash. Set by the
// gated-route middleware; consumed by the handler.
interface AgentAppVariables {
  principal: Principal;
  authResponseHeaders?: HeadersInit;
}

/**
 * Build the Hono app object. Does NOT bind a port — callers serve it
 * via `@hono/node-server`. Returned as a plain `Hono` so embeds can
 * mount sub-routes if needed.
 */
export function createAgentApp(
  deps: AgentAppDeps,
): Hono<{ Variables: AgentAppVariables }> {
  const { adapter, chatStore, mcpServers, sandboxProxyUrl, auth } = deps;
  const crossFramework = deps.crossFramework ?? false;
  const log = deps.log ?? ((): void => {});

  // Canonical agent-tool catalog, built ONCE from the live MCP
  // connection (`initialize` + `tools/list`) and memoized for the
  // process lifetime — boot-cost matters and the catalog is stable.
  // Built lazily on the first `kind:'chat'` request rather than at
  // construction so the app object stays synchronous to create and a
  // not-yet-reachable MCP at boot doesn't block app construction.
  //
  // Failure mode: if the build rejects (a server is down), we RESET the
  // memo so the next request retries rather than permanently disabling
  // the catalog on a transient boot failure. The caller catches the
  // rejection and degrades to `agentCapabilities: undefined`.
  let catalogPromise:
    | Promise<Record<string, AgentToolEntry>>
    | undefined;
  const getAgentCatalog = (): Promise<Record<string, AgentToolEntry>> => {
    if (catalogPromise === undefined) {
      const built = buildAgentCatalog(mcpServers);
      catalogPromise = built;
      // Don't cache a rejected promise — reset so the next request
      // retries. Swallow here only to avoid an unhandled-rejection
      // warning; the awaiting caller still observes the rejection.
      built.catch(() => {
        if (catalogPromise === built) catalogPromise = undefined;
      });
      // Cross-framework: declare the canonical tool catalog to ggui
      // ONCE, chained off this first successful build (not per request).
      // Because it hangs off the memoized `built` promise — created only
      // on the first call — it fires at most once per process for a
      // successful catalog. A failed build resets the memo (above) so a
      // later retry can still declare; `declareToolCatalog` is itself
      // non-fatal, so a declaration failure never breaks the run.
      if (crossFramework) {
        const ggui = mcpServers.ggui;
        if (ggui) {
          void built.then(
            (catalog) =>
              declareToolCatalog({
                ggui: { url: ggui.url, bearer: ggui.bearer },
                catalog,
                log,
              }),
            () => {
              // Build rejected — the memo was reset above; nothing to
              // declare. The next request retries the build.
            },
          );
        } else {
          log(
            "[agent-server] crossFramework:true but no 'ggui' MCP server configured — skipping tool-catalog declaration.",
          );
        }
      }
    }
    return catalogPromise;
  };

  const app = new Hono<{ Variables: AgentAppVariables }>();

  // CORS — the reference frontend (`ggui-basic-web`) runs on a
  // different origin (port 6890 vs the agent backend's 67xx). Every
  // browser fetch is cross-origin; the backend is dev/sample-only
  // and never speaks to real users without an upstream auth layer
  // that would override these headers.
  app.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
        },
      });
    }
    await next();
    c.res.headers.set('Access-Control-Allow-Origin', '*');
    c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.res.headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, Authorization',
    );
  });

  // Adapter-mounted /auth/* sub-router. `/auth/*` is RESERVED — the
  // library never registers a route under it itself.
  const authRouter = new Hono();
  auth.mount?.(authRouter);
  app.route('/auth', authRouter);

  // Per-request principal resolver. Used on every endpoint that
  // needs identity. Stashes the principal + any response headers
  // from the adapter onto `c.var` so the handler reads one copy.
  const requireAuth: MiddlewareHandler<{
    Variables: AgentAppVariables;
  }> = async (c, next) => {
    const result = await auth.authenticate(c.req.raw);
    if (!result) {
      return c.json({ error: 'unauthenticated' }, 401);
    }
    c.set('principal', result.principal);
    if (result.responseHeaders !== undefined) {
      c.set('authResponseHeaders', result.responseHeaders);
    }
    await next();
    // Merge adapter response headers (Set-Cookie etc.) onto the
    // final response. Skip when the adapter declined to attach any.
    if (result.responseHeaders !== undefined) {
      const merged = new Headers(result.responseHeaders);
      merged.forEach((value, key) => {
        c.res.headers.append(key, value);
      });
    }
  };

  // ── GET / — Manifest ────────────────────────────────────────────────
  // Single-fetch manifest for frontends that want one round-trip on
  // mount. Public — no auth required (no per-principal data).
  app.get('/', (c) =>
    c.json({
      name: adapter.name,
      sandboxProxyUrl,
      mcpServers: Object.fromEntries(
        Object.entries(mcpServers).map(([name, cfg]) => [name, { url: cfg.url }]),
      ),
    }),
  );

  // ── GET /agent?chatId=X — snapshot ──────────────────────────────────
  // Returns the stream of normalized messages we observed for this
  // chat, RE-INLINED FRESH. Auth + ownership gated: 401 with no
  // principal, 404 on unknown chatId, 403 on chat owned by another
  // principal, 200 on success.
  //
  // Rehydration freshness (Problem B): the recorded tool-results carry
  // an `inlinedResource` FROZEN at record time (the initial render).
  // Any `*_update` delivered live over WS afterwards never re-baked
  // into the snapshot, so a naive replay would show stale pre-click
  // HTML. Before returning, we re-run the tool-result interceptor with
  // `forceReinline` so each render's resource is re-fetched from the
  // MCP at its CURRENT state — the replayed messages then carry
  // up-to-date HTML. Renders that no longer resolve fall back to their
  // recorded HTML (the interceptor passes the message through on a
  // failed `resources/read`), so a TTL-evicted render degrades to its
  // last-known state rather than vanishing.
  app.get('/agent', requireAuth, async (c) => {
    const chatId = c.req.query('chatId') ?? '';
    if (chatId.length === 0) {
      return c.json({ error: 'chatId query required' }, 400);
    }
    const rec = chatStore.get(chatId);
    if (!rec) {
      return c.json({ error: 'chat not found' }, 404);
    }
    const principal = c.get('principal');
    const allowed = auth.authorizeChat
      ? await auth.authorizeChat(principal, rec.row)
      : defaultAuthorizeChat(principal, rec.row);
    if (!allowed) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const freshMessages = await Promise.all(
      rec.snapshot.messages.map((message) =>
        interceptToolResult({
          message,
          mcpServers,
          forceReinline: true,
          log,
        }),
      ),
    );
    return c.json(
      { chatId: rec.snapshot.chatId, messages: freshMessages },
      200,
      { 'Cache-Control': 'no-store' },
    );
  });

  // ── POST /agent — kind-discriminated ────────────────────────────────
  // `kind:'chat'`      → run the agent loop, SSE stream of normalized
  //                      SDK messages (first event `chat-allocated`).
  // `kind:'tool-call'` → relay an iframe-issued `tools/call` to the MCP
  //                      server, return the JSON-RPC envelope as JSON.
  app.post('/agent', requireAuth, async (c) => {
    let body: PostAgentBody;
    try {
      body = (await c.req.json()) as PostAgentBody;
    } catch {
      return c.json({ error: 'expected JSON body' }, 400);
    }
    if (body.kind !== 'chat' && body.kind !== 'tool-call') {
      return c.json(
        { error: "kind must be 'chat' or 'tool-call'" },
        400,
      );
    }

    const principal = c.get('principal');

    // ── kind:'tool-call' — iframe → MCP relay (JSON, not SSE) ─────────
    // Forwards the iframe-issued `tools/call` to the matching MCP
    // server over HTTP. The iframe holds no auth credential; this host
    // is the protocol-defined relay party. Auth-gated above — any
    // authenticated principal may relay (tools/call doesn't bind to a
    // chat). Generic MCP forwarding: ZERO ggui-protocol knowledge.
    if (body.kind === 'tool-call') {
      if (typeof body.name !== 'string' || body.name.length === 0) {
        return c.json({ error: 'name required' }, 400);
      }
      const primary = mcpServers.ggui ?? Object.values(mcpServers)[0];
      if (!primary) {
        return c.json({ error: 'no MCP server configured' }, 500);
      }
      try {
        const args =
          body.arguments && typeof body.arguments === 'object'
            ? body.arguments
            : {};
        const rpc = await callMcpToolsCall({
          url: primary.url,
          bearer: primary.bearer,
          name: body.name,
          arguments: args,
        });
        return c.json(rpc, 200);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `relay error: ${message}` }, 502);
      }
    }

    // ── kind:'chat' — agent loop, SSE stream ──────────────────────────
    if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
      return c.json({ error: 'prompt must be a non-empty string' }, 400);
    }

    const ownerId = principalId(principal);

    // Resolve / allocate chatId. When the client supplied one, verify
    // they own it before letting the new prompt write to that chat;
    // otherwise allocate fresh.
    let chatId: string;
    if (typeof body.chatId === 'string' && body.chatId.length > 0) {
      const existing = chatStore.get(body.chatId);
      if (existing) {
        const allowed = auth.authorizeChat
          ? await auth.authorizeChat(principal, existing.row)
          : defaultAuthorizeChat(principal, existing.row);
        if (!allowed) {
          return c.json({ error: 'forbidden' }, 403);
        }
      }
      // Unknown chatId on POST = client previously had one but the
      // server forgot it (process restart with in-memory store).
      // Accept the id; the next append creates the row with the
      // CURRENT principal as owner. Reasonable for the in-memory
      // default; durable stores can enforce stricter semantics.
      chatId = body.chatId;
    } else {
      chatId = mintChatId();
    }

    // Pure prompt-forwarder: the prompt feeds the adapter verbatim. The
    // server has ZERO ggui-protocol knowledge — when a user gesture
    // needs to wake the agent, the directive ("call ggui_consume…")
    // already lives in the iframe-authored `ui/message` text the client
    // forwarded as `body.prompt`. (`body.data.meta` is a generic
    // forward-compat extension carrier; the server does not special-case
    // any key in it.)
    const promptForLlm = body.prompt;

    log(
      `[agent-server] POST /agent chat=${chatId} owner=${ownerId} prompt=${JSON.stringify(body.prompt.slice(0, 80))}`,
    );

    // Resolve the canonical agent-tool catalog (memoized). On failure
    // (an MCP server down at boot) degrade to undefined rather than
    // 500ing the run — the reuse gate is designed to degrade when caps
    // are absent. `getAgentCatalog` already resets its memo on reject
    // so the next request retries.
    let agentCapabilities: Record<string, AgentToolEntry> | undefined;
    try {
      agentCapabilities = await getAgentCatalog();
    } catch (err) {
      agentCapabilities = undefined;
      log(
        `[agent-server] agent-capabilities catalog build failed; degrading to none: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return streamSSE(c, async (stream) => {
      // First SSE event is always the chatId allocation echo so the
      // client can stamp it into URL / localStorage on the first POST
      // that didn't carry one.
      const chatAllocated: ChatAllocatedEvent = {
        type: 'chat-allocated',
        chatId,
      };
      await stream.writeSSE({
        event: 'chat-allocated',
        data: JSON.stringify(chatAllocated),
      });

      const abortController = new AbortController();
      stream.onAbort(() => abortController.abort());

      const startedAt = Date.now();
      let msgCount = 0;
      try {
        for await (const rawMsg of adapter.run({
          prompt: promptForLlm,
          chatId,
          mcpServers,
          systemPrompt: deps.systemPrompt,
          abortSignal: abortController.signal,
          ...(agentCapabilities ? { agentCapabilities } : {}),
        })) {
          msgCount += 1;
          // Tool-result interceptor — when `_meta.ui.resourceUri` is
          // present on the result, fetch the resource and inline it
          // under `_meta.ui.resource` so the frontend doesn't need
          // a follow-up `resources/read` round trip.
          const msg = await interceptToolResult({
            message: rawMsg,
            mcpServers,
            signal: abortController.signal,
            log,
          });
          chatStore.append({
            chatId,
            ownerId,
            message: msg,
          });
          if (abortController.signal.aborted) break;
          await stream.writeSSE({
            event: 'message',
            data: JSON.stringify(msg),
          });
        }
        log(
          `[agent-server] POST /agent complete chat=${chatId} ${msgCount} messages in ${Date.now() - startedAt}ms`,
        );
      } catch (err) {
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || abortController.signal.aborted);
        if (!isAbort) {
          log(
            `[agent-server] POST /agent error chat=${chatId} after ${Date.now() - startedAt}ms (${msgCount} messages): ${err instanceof Error ? err.message : String(err)}`,
          );
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          });
        }
      }
    });
  });

  return app;
}

/**
 * `kind`-discriminated body the client posts to `POST /agent`.
 *
 *   kind:'chat'      — run the agent loop. `prompt` feeds the adapter
 *                      verbatim; `data.meta` is a GENERIC forward-compat
 *                      extension carrier (opaque record the client may
 *                      attach). The server is a pure prompt-forwarder
 *                      with ZERO ggui-protocol knowledge — it does NOT
 *                      inspect or special-case any key in `data.meta`.
 *                      (The "call ggui_consume…" directive a guest
 *                      gesture needs already lives in the iframe-authored
 *                      `ui/message` text the client forwards as
 *                      `prompt`.) `chatId` optional — when absent the
 *                      server allocates one and returns it as the first
 *                      SSE event; when supplied for an existing chat the
 *                      principal MUST own it (403 otherwise).
 *
 *   kind:'tool-call' — relay an iframe-issued `tools/call` to the MCP
 *                      server. `name` + `arguments` are forwarded
 *                      verbatim. Generic MCP forwarding; not
 *                      ggui-specific.
 *
 * Fields are typed `unknown` because this is the untrusted wire
 * boundary — handlers narrow each before use.
 */
type PostAgentBody =
  | {
      readonly kind: 'chat';
      readonly chatId?: unknown;
      readonly prompt?: unknown;
      readonly data?: {
        readonly meta?: {
          readonly [key: string]: unknown;
        };
      };
    }
  | {
      readonly kind: 'tool-call';
      readonly chatId?: unknown;
      readonly name?: unknown;
      readonly arguments?: Record<string, unknown>;
    };

/**
 * SSE event the server always writes first on a fresh `/agent` POST
 * stream, carrying the chatId the client should pin into its URL /
 * localStorage for rehydration.
 */
export interface ChatAllocatedEvent {
  readonly type: 'chat-allocated';
  readonly chatId: string;
}

export type { McpServerConfig };
