/**
 * Hono app factory + request handlers for the brand-agnostic agent
 * server. Three routes, all sharing one {@link AgentAdapter}:
 *
 *   GET  /                     — `{name, sandboxProxyUrl, mcpServers}`
 *                                manifest, used by frontends to bind.
 *   GET  /agent?chatId=X       — server-authoritative chat snapshot
 *                                (replayed through the same handler the
 *                                live SSE stream uses).
 *   POST /agent                — { data: { meta?: { ai.ggui/userAction
 *                                ... } }, prompt, chatId? } → SSE stream
 *                                of normalized SDK messages.
 *
 *   POST /agent/relay/tools-call  — iframe-issued tools/call → MCP relay.
 *                                Preserved because the browser still
 *                                needs same-origin access to the MCP
 *                                without CORS; `/relay/resources-read`
 *                                is RETIRED because the tool-result
 *                                interceptor inlines the resource
 *                                alongside the result on the way out.
 *
 *   GET  /sandbox-proxy-url    — `{url}` for the second-origin sandbox
 *                                (per MCP-Apps spec). Surfaced as its
 *                                own endpoint so the frontend can fetch
 *                                + thread before mount; also folded
 *                                into the root manifest for
 *                                single-fetch frontends.
 *
 *   GET  /api/renders/:id/state — proxy to the ggui MCP server's
 *                                state endpoint (wsToken-gated).
 *                                Same-origin so the browser doesn't
 *                                need CORS on the MCP server.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { isGguiUserActionMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { callMcpToolsCall } from './mcp-client.js';
import { interceptToolResult } from './tool-result-interceptor.js';
import { synthesizeUserActionPrompt } from './user-action-prompt.js';
import { mintChatId, type ChatStore } from './chat-store.js';
import type { AgentAdapter, McpServerConfig } from './types.js';

/**
 * Per-request dependencies the route handlers reach for. Constructed
 * once in {@link createAgentApp} and closed-over by every handler.
 */
export interface AgentAppDeps {
  readonly adapter: AgentAdapter;
  readonly chatStore: ChatStore;
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
   * `console.log` no-op fallback when omitted at server boot.
   */
  readonly log?: (line: string) => void;
}

/**
 * Build the Hono app object. Does NOT bind a port — callers serve it
 * via `@hono/node-server`. Returned as a plain `Hono` so embeds can
 * mount sub-routes if needed.
 */
export function createAgentApp(deps: AgentAppDeps): Hono {
  const { adapter, chatStore, mcpServers, sandboxProxyUrl } = deps;
  const log = deps.log ?? ((): void => {});

  const app = new Hono();

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
          'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Chat-Id',
        },
      });
    }
    await next();
    c.res.headers.set('Access-Control-Allow-Origin', '*');
    c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.res.headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, X-Chat-Id',
    );
  });

  // ── GET / — Manifest ────────────────────────────────────────────────
  // Single-fetch manifest for frontends that want one round-trip on
  // mount. Carries the same `sandboxProxyUrl` the dedicated endpoint
  // returns, plus the configured MCP-server URLs (so a frontend can
  // wire its iframe relay).
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
  // for this chat. The frontend hook replays `messages[]` through
  // the same handler the live SSE stream uses, rebuilding the chat
  // panel and re-mounting iframes from each tool_result's `_meta`
  // slice — no separate per-render store needed server-side.
  //
  // 404 on unknown chatId — distinguishes "fresh tab opened on a URL
  // we don't know about" from "empty conversation".
  app.get('/agent', (c) => {
    const chatId = c.req.query('chatId') ?? '';
    if (chatId.length === 0) {
      return c.json({ error: 'chatId query required' }, 400);
    }
    const snap = chatStore.get(chatId);
    if (!snap) {
      return c.json({ error: 'chat not found' }, 404);
    }
    return c.json(
      { chatId: snap.chatId, messages: snap.messages },
      200,
      { 'Cache-Control': 'no-store' },
    );
  });

  // ── POST /agent — main agent loop, SSE stream ───────────────────────
  app.post('/agent', async (c) => {
    let body: PostAgentBody;
    try {
      body = (await c.req.json()) as PostAgentBody;
    } catch {
      return c.json({ error: 'expected JSON body' }, 400);
    }
    if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
      return c.json({ error: 'prompt must be a non-empty string' }, 400);
    }

    // Server-allocated chatId — client never mints. Returned to the
    // browser as the first SSE event so the URL / localStorage can
    // pin it for resume.
    const chatId =
      typeof body.chatId === 'string' && body.chatId.length > 0
        ? body.chatId
        : mintChatId();

    // Pull the spec-canonical `ai.ggui/userAction` slice off the
    // request body's `data.meta` when present and synthesize the
    // imperative-first directive prompt server-side. The client
    // (`useMcpAppsChat.send`) just forwards the slice — every
    // ggui-coupled formatting lives here.
    const rawUserAction = body.data?.meta?.['ai.ggui/userAction'];
    const userAction = isGguiUserActionMeta(rawUserAction)
      ? rawUserAction
      : undefined;
    const promptForLlm =
      userAction !== undefined
        ? synthesizeUserActionPrompt({
            originalPrompt: body.prompt,
            userAction,
          })
        : body.prompt;

    log(
      `[agent-server] POST /agent chat=${chatId} prompt=${JSON.stringify(body.prompt.slice(0, 80))}${userAction ? ` (userAction kind=${userAction.kind} renderId=${userAction.renderId})` : ''}`,
    );

    return streamSSE(c, async (stream) => {
      // The first SSE event is ALWAYS the chatId allocation echo so
      // the client can stamp it into URL / localStorage even on the
      // first POST that didn't carry one.
      const chatAllocated: ChatAllocatedEvent = {
        type: 'chat-allocated',
        chatId,
      };
      await stream.writeSSE({
        event: 'chat-allocated',
        data: JSON.stringify(chatAllocated),
      });

      const abortController = new AbortController();
      const onAbort = (): void => abortController.abort();
      stream.onAbort(() => {
        onAbort();
      });

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
          chatStore.append(chatId, msg);
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
  // host is the protocol-defined relay party. Browser-side
  // `<AppRenderer onCallTool>` POSTs here; we proxy + return the
  // JSON-RPC envelope verbatim.
  app.post('/agent/relay/tools-call', async (c) => {
    let body: RelayToolsCallBody;
    try {
      body = (await c.req.json()) as RelayToolsCallBody;
    } catch {
      return c.json({ error: 'expected JSON body' }, 400);
    }
    if (typeof body.name !== 'string' || body.name.length === 0) {
      return c.json({ error: 'name required' }, 400);
    }
    // Pick the MCP server — same routing logic as the resource
    // interceptor's URL-host match, then `ggui` fallback. Tools/call
    // doesn't carry a URI we can route on, so we always go to the
    // primary `ggui` MCP unless the operator routed differently
    // (extension point for future relay-route override).
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
  // the MCP gates on token signature, render ownership, appId match.
  app.get('/api/renders/:renderId/state', async (c) => {
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
      // Forward the browser's full query string (wsToken etc.).
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
  });

  return app;
}

/**
 * Shape the client (`useMcpAppsChat.send`) sends on every POST.
 *
 * `data.meta` carries the spec-canonical extension slice — only
 * `ai.ggui/userAction` is recognized today; future ggui-meta keys
 * (e.g. `ai.ggui/host-session`) thread through here too.
 *
 * `chatId` is optional — when absent the server allocates one and
 * returns it as the first SSE event.
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

/**
 * Type-only re-export so consumers of the app factory see the same
 * brand-agnostic MCP-server shape from one import.
 */
export type { McpServerConfig };
