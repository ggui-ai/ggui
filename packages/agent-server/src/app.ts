/**
 * Hono app factory + request handlers for the brand-agnostic agent
 * server. Three core routes + an adapter-mounted `/auth/*` sub-router:
 *
 *   GET  /                     — `{name, sandboxProxyUrl, mcpServers}`
 *                                manifest, used by frontends to bind.
 *   GET  /agent?chatId=X       — server-authoritative chat snapshot
 *                                (replayed through the same handler
 *                                the live SSE stream uses). Auth +
 *                                ownership gated.
 *   POST /agent                — { prompt, chatId?, data?: {meta?} }
 *                                → SSE stream of normalized SDK
 *                                messages. First event is always
 *                                `chat-allocated` carrying the
 *                                server-allocated chat id.
 *
 *   /auth/*                    — RESERVED for AuthAdapter.mount().
 *                                Library never registers a route here
 *                                itself. Guest-token adapter mounts
 *                                POST /auth/guest, GET /auth/me,
 *                                POST /auth/logout; bearer adapter
 *                                mounts GET /auth/me only.
 *
 *   POST /agent/relay/tools-call  — iframe-issued tools/call → MCP
 *                                relay. Preserved because the browser
 *                                still needs same-origin access to the
 *                                MCP without CORS; `/relay/resources-
 *                                read` is RETIRED because the tool-
 *                                result interceptor inlines the
 *                                resource alongside the result on the
 *                                way out.
 *
 *   GET  /sandbox-proxy-url    — `{url}` for the second-origin sandbox
 *                                (per MCP-Apps spec).
 *
 *   GET  /api/renders/:id/state — proxy to the ggui MCP server's
 *                                state endpoint (wsToken-gated).
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  defaultAuthorizeChat,
  principalId,
  type AuthAdapter,
  type Principal,
} from './auth.js';
import { callMcpToolsCall } from './mcp-client.js';
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
   * Optional system prompt the operator configured.
   */
  readonly systemPrompt: string | null;
  /**
   * URL of the second-origin sandbox proxy. Required because every
   * MCP-Apps iframe lives behind it.
   */
  readonly sandboxProxyUrl: string;
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
  const log = deps.log ?? ((): void => {});

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

  // ── GET /sandbox-proxy-url ──────────────────────────────────────────
  app.get('/sandbox-proxy-url', (c) =>
    c.json({ url: sandboxProxyUrl }, 200, { 'Cache-Control': 'no-store' }),
  );

  // ── GET /agent?chatId=X — snapshot ──────────────────────────────────
  // Returns the verbatim stream of normalized messages we observed
  // for this chat. Auth + ownership gated: 401 with no principal,
  // 404 on unknown chatId, 403 on chat owned by another principal,
  // 200 on success.
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
    return c.json(
      { chatId: rec.snapshot.chatId, messages: rec.snapshot.messages },
      200,
      { 'Cache-Control': 'no-store' },
    );
  });

  // ── POST /agent — main agent loop, SSE stream ───────────────────────
  app.post('/agent', requireAuth, async (c) => {
    let body: PostAgentBody;
    try {
      body = (await c.req.json()) as PostAgentBody;
    } catch {
      return c.json({ error: 'expected JSON body' }, 400);
    }
    if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
      return c.json({ error: 'prompt must be a non-empty string' }, 400);
    }

    const principal = c.get('principal');
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

  // ── POST /agent/relay/tools-call — iframe → MCP relay ───────────────
  // Forwards iframe-issued `tools/call` (postMessage) to the matching
  // MCP server over HTTP. The iframe holds no auth credential; this
  // host is the protocol-defined relay party.
  //
  // Auth-gated: only the chat owner (or any authenticated principal —
  // tools/call doesn't carry a chatId binding it to a specific chat)
  // can use the relay. Reasoning: this surface speaks to the MCP
  // server on behalf of the host; leaving it unauth'd would let
  // anyone issue tools/call through the proxy.
  app.post('/agent/relay/tools-call', requireAuth, async (c) => {
    let body: RelayToolsCallBody;
    try {
      body = (await c.req.json()) as RelayToolsCallBody;
    } catch {
      return c.json({ error: 'expected JSON body' }, 400);
    }
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
          ? (body.arguments as Record<string, unknown>)
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
  });

  // ── GET /api/renders/:renderId/state — MCP state proxy ──────────────
  // The state endpoint replaced the bearer-by-obscurity `/r/<shortCode>`
  // URL; the browser fetches via this same-origin path so the MCP
  // server doesn't need CORS. wsToken query is forwarded verbatim —
  // the MCP gates on token signature, render ownership, appId match,
  // so we don't double-gate here (any authenticated principal can
  // forward; the MCP's token is the actual gate).
  app.get(
    '/api/renders/:renderId/state',
    requireAuth,
    async (c: Context<{ Variables: AgentAppVariables }>) => {
      const renderId = c.req.param('renderId');
      if (typeof renderId !== 'string' || renderId.length === 0) {
        return c.json({ error: 'renderId required' }, 400);
      }
      const primary = mcpServers.ggui ?? Object.values(mcpServers)[0];
      if (!primary) {
        return c.json({ error: 'no MCP server configured' }, 500);
      }
      try {
        const mcpOrigin = new URL(primary.url);
        mcpOrigin.pathname = `/api/renders/${encodeURIComponent(renderId)}/state`;
        const incoming = new URL(c.req.url);
        mcpOrigin.search = incoming.search;
        const upstream = await fetch(mcpOrigin.toString(), {
          headers: { Accept: 'application/json' },
        });
        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: {
            'Content-Type':
              upstream.headers.get('Content-Type') ?? 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `state proxy error: ${message}` }, 502);
      }
    },
  );

  return app;
}

/**
 * Shape the client (`useMcpAppsChat.send`) sends on every POST.
 *
 * `data.meta` is a GENERIC forward-compat extension carrier — an opaque
 * record the client may attach. The server is a pure prompt-forwarder
 * with ZERO ggui-protocol knowledge: it does NOT inspect or special-case
 * any key here. (The "call ggui_consume…" directive a guest gesture
 * needs already lives in the iframe-authored `ui/message` text, which
 * the client forwards as `prompt`.)
 *
 * `chatId` is optional — when absent the server allocates one and
 * returns it as the first SSE event. When supplied for an existing
 * chat, the principal MUST own it (403 otherwise).
 */
interface PostAgentBody {
  readonly prompt?: unknown;
  readonly chatId?: unknown;
  readonly data?: {
    readonly meta?: {
      readonly [key: string]: unknown;
    };
  };
}

interface RelayToolsCallBody {
  readonly name?: unknown;
  readonly arguments?: unknown;
}

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
