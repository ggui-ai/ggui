/* eslint-disable no-console */
/**
 * Brand-agnostic MCP-Apps-spec HTTP API for the OpenAI Agents SDK
 * sample. Pure backend — no static file serving, no bundled frontend.
 * The reference frontend lives at `oss/samples/apps/ggui-basic-web/`
 * and binds to this URL via `VITE_AGENT_ENDPOINT_URL`.
 *
 * Exposed routes:
 *
 *   POST /chat                       { prompt } → SSE stream of NormalizedMessage events
 *   GET  /chat?chatId=X              server-authoritative chat snapshot
 *   POST /relay/tools-call           iframe-issued tools/call → ggui MCP relay
 *   POST /relay/resources-read       browser-issued resources/read → ggui MCP relay
 *   GET  /api/renders/:id/state      wsToken-gated render state proxy → ggui MCP
 *   GET  /sandbox-proxy-url          AppRenderer's second-origin sandbox URL
 *
 * Also boots a second-port sandbox-proxy server (via
 * `@ggui-ai/dev-stack`'s `startSandboxProxyServer`) so AppRenderer's
 * spec-mandated different-origin sandbox host is available without
 * extra setup. The URL is surfaced via the `/sandbox-proxy-url`
 * endpoint above so any frontend (Vite, Next.js, Remix, plain HTML)
 * can fetch + thread it.
 *
 * No framework dependency — node:http only. Keeps the sample's
 * `node_modules/` tiny so the test harness boots fast.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  startSandboxProxyServer,
  type SandboxProxyServerHandle,
} from '@ggui-ai/dev-stack';
import { runAgent, type McpServerConfig, type NormalizedMessage } from './agent.js';

/**
 * Per-chat in-memory snapshot of the agent's normalized message stream.
 *
 * **Brand-agnostic by design.** This server keeps only MCP-spec
 * primitives — `NormalizedMessage[]` — and stays oblivious to ggui's
 * `ai.ggui/render` slice. Any MCP-Apps-spec UI knowledge (parsing
 * `_meta`, mapping renderIds, etc.) lives in the frontend hook
 * (`useMcpAppsChat` in `@ggui-ai/react/chat-helpers`), which replays
 * `messages[]` through the same handler the live SSE stream uses.
 *
 * Kept in-process / non-durable on purpose: this slice mirrors how a
 * chat shell stores its current session's artifacts; cross-restart
 * persistence is a separate concern.
 */
interface ChatStateSnapshot {
  readonly chatId: string;
  readonly messages: NormalizedMessage[];
}

const chatStore = new Map<string, ChatStateSnapshot>();

function getOrCreateChatSnapshot(chatId: string): ChatStateSnapshot {
  let snap = chatStore.get(chatId);
  if (!snap) {
    snap = { chatId, messages: [] };
    chatStore.set(chatId, snap);
  }
  return snap;
}

export interface ServerOptions {
  readonly port: number;
  /**
   * MCP endpoints the agent's LLM is allowed to call into. Threaded
   * through to `runAgent` on each `/chat` POST. Conventionally includes
   * `ggui` for the primary ggui MCP server; additional keys add domain
   * MCPs (e.g. `todo`).
   */
  readonly mcpServers: Record<string, McpServerConfig>;
  /** Model id passed to the OpenAI Agents SDK. */
  readonly model?: string;
  /** Optional override; passed straight through to runAgent. */
  readonly systemPrompt?: string | null;
  /**
   * Port for the sandbox-proxy server (default: agent port + 1000).
   * Per MCP Apps spec, the sandbox must live on a different origin
   * from the host. Pass `0` to let the OS pick.
   */
  readonly sandboxProxyPort?: number;
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const gguiServer = opts.mcpServers.ggui;
  if (!gguiServer) {
    throw new Error(
      `startServer: mcpServers must include a 'ggui' entry — got keys ${JSON.stringify(Object.keys(opts.mcpServers))}`,
    );
  }
  const sandboxProxyPort = opts.sandboxProxyPort ?? opts.port + 1000;
  const sandboxProxy = await startSandboxProxyServer({ port: sandboxProxyPort });

  const ctx: ServerContext = { ...opts, gguiMcpUrl: gguiServer.url, sandboxProxy };

  const server = createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => {
      console.error('[sample-agent] request handler error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`internal error: ${err.message ?? String(err)}`);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(opts.port, () => {
      console.log(
        `[sample-agent] chat UI ready: http://localhost:${opts.port}`,
      );
      for (const [name, cfg] of Object.entries(opts.mcpServers)) {
        console.log(`[sample-agent] mcp server '${name}': ${cfg.url}`);
      }
      console.log(`[sample-agent] sandbox proxy: ${sandboxProxy.url}`);
      resolve();
    });
  });
}

interface ServerContext extends ServerOptions {
  /**
   * Cached `opts.mcpServers.ggui.url` — the relay handlers
   * (`/relay/tools-call`, `/relay/resources-read`, `/api/renders/:id/state`)
   * forward requests to the primary ggui MCP, never the secondary domain
   * MCPs.
   */
  readonly gguiMcpUrl: string;
  readonly sandboxProxy: SandboxProxyServerHandle;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerContext,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);

  // Wide-open CORS — the reference frontend (`ggui-basic-web`) runs on a
  // different origin (port 6890 vs the agent backend's 6791), so every
  // browser fetch is cross-origin. The agent backend is dev-only /
  // sample-only; it never speaks to real users without an upstream auth
  // layer that would override these headers anyway.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, X-Chat-Id',
  );
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /sandbox-proxy-url — surfaces the second-origin sandbox URL
  // that `<AppRenderer sandbox.url>` needs per MCP Apps spec. The
  // backend boots the sandbox-proxy on `agent_port + 1000` (see
  // ServerOptions.sandboxProxyPort); frontends fetch this endpoint on
  // mount and thread the URL down.
  if (req.method === 'GET' && url.pathname === '/sandbox-proxy-url') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ url: opts.sandboxProxy.url }));
    return;
  }

  // GET /chat?chatId=<id> — server-authoritative chat snapshot.
  //
  // Returns the verbatim stream of normalized messages we observed for
  // this chat. The frontend hook (`useMcpAppsChat`) replays
  // `messages[]` through the same handler the live SSE stream uses,
  // rebuilding the chat panel and re-mounting iframes from each
  // tool_result's `_meta` slice — no separate per-render store needed
  // server-side.
  //
  // 404 on unknown chatId — distinguishes "fresh tab opened on a URL
  // we don't know about" from "empty conversation" (the former gets a
  // blank slate without spurious restore work).
  if (req.method === 'GET' && url.pathname === '/chat') {
    const chatId = url.searchParams.get('chatId') ?? '';
    if (chatId.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'chatId query required' }));
      return;
    }
    const snap = chatStore.get(chatId);
    if (!snap) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'chat not found' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        chatId: snap.chatId,
        messages: snap.messages,
      }),
    );
    return;
  }

  // R5 — `/api/renders/:renderId/state?wsToken=...` proxy to the ggui
  // MCP server. The state endpoint replaced the bearer-by-obscurity
  // `/r/<shortCode>` URL; the browser fetches state via this same-origin
  // path so we don't have to CORS-enable the MCP server.
  const stateMatch = url.pathname.match(/^\/api\/renders\/([^/]+)\/state$/);
  if (req.method === 'GET' && stateMatch) {
    const renderId = stateMatch[1] ?? '';
    try {
      const mcpOrigin = new URL(opts.gguiMcpUrl);
      mcpOrigin.pathname = `/api/renders/${encodeURIComponent(renderId)}/state`;
      // Forward the browser's wsToken query verbatim — the MCP server
      // gates this endpoint on token signature, render ownership, and
      // appId match; dropping the query forces 401.
      mcpOrigin.search = url.search;
      const upstream = await fetch(mcpOrigin.toString(), {
        headers: { Accept: 'application/json' },
      });
      const body = await upstream.text();
      res.writeHead(upstream.status, {
        'Content-Type':
          upstream.headers.get('Content-Type') ?? 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `state proxy error: ${message}` }));
    }
    return;
  }

  // MCP Apps relay — forwards iframe-issued `tools/call` (postMessage)
  // to the ggui MCP server over HTTP. The iframe holds no auth
  // credential; this host (running in Node) is the protocol-defined
  // relay party. The browser-side <McpAppIframe onToolCall> calls
  // POST /relay/tools-call which proxies to opts.gguiMcpUrl.
  //
  // Keeps the browser on a single same-origin endpoint and avoids
  // having to CORS-enable the MCP server.
  if (req.method === 'POST' && url.pathname === '/relay/tools-call') {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body) as {
        readonly name?: unknown;
        readonly arguments?: unknown;
      };
      if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'name required' }));
        return;
      }
      const rpcId = Math.floor(Math.random() * 1e9);
      const mcpReq = await fetch(opts.gguiMcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: rpcId,
          method: 'tools/call',
          params: {
            name: parsed.name,
            arguments:
              parsed.arguments && typeof parsed.arguments === 'object'
                ? (parsed.arguments as Record<string, unknown>)
                : {},
          },
        }),
      });
      const text = await mcpReq.text();
      // The OSS MCP server may stream back as SSE or as raw JSON
      // depending on the Accept header negotiated. Normalize both
      // shapes to the JSON-RPC response object.
      const jsonRpc = parseMcpResponse(text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpc));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `relay error: ${message}` }));
    }
    return;
  }

  // MCP Apps spec-canonical resource read relay. The browser-side
  // <AppRenderer toolResourceUri={uri} onReadResource={...}> calls
  // POST /relay/resources-read which proxies a JSON-RPC `resources/read`
  // to the ggui MCP server.
  //
  // Why this exists: the spec-canonical render flow has the host fetch
  // iframe HTML from `_meta.ui.resourceUri` via standard MCP
  // `resources/read`. The ggui MCP server returns the full
  // self-contained iframe HTML (with current propsJson baked in) on
  // every read — every host (claude.ai, ChatGPT, our own) needs zero
  // ggui-specific HTML-building code; only the standard MCP read.
  //
  // The iframe holds no MCP credential; this Node process is the
  // protocol-defined relay party, same pattern as /relay/tools-call.
  if (req.method === 'POST' && url.pathname === '/relay/resources-read') {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body) as { readonly uri?: unknown };
      if (typeof parsed.uri !== 'string' || parsed.uri.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'uri required' }));
        return;
      }
      const rpcId = Math.floor(Math.random() * 1e9);
      const mcpReq = await fetch(opts.gguiMcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: rpcId,
          method: 'resources/read',
          params: { uri: parsed.uri },
        }),
      });
      const text = await mcpReq.text();
      const jsonRpc = parseMcpResponse(text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpc));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `relay error: ${message}` }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/chat') {
    const body = await readBody(req);
    let prompt: string;
    try {
      prompt = JSON.parse(body).prompt;
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('expected JSON body with { prompt: string }');
      return;
    }
    if (typeof prompt !== 'string' || prompt.length === 0) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('prompt must be a non-empty string');
      return;
    }

    // Per-tab chat id from the browser's `X-Chat-Id`
    // header — keys per-chat agent state (conversation history,
    // resume tokens, ggui renderId continuity) so multi-turn flows
    // preserve context across `/chat` POSTs. Auto-mint when missing
    // (non-browser callers like curl get single-turn isolation).
    const chatIdHeader = req.headers['x-chat-id'];
    const chatId =
      typeof chatIdHeader === 'string' && chatIdHeader.length > 0
        ? chatIdHeader
        : (() => {
            const minted = randomUUID();
            console.warn(
              `[sample-agent] /chat missing X-Chat-Id header — minted ${minted} (single-turn isolation; clients should set the header to preserve multi-turn context)`,
            );
            return minted;
          })();

    console.log(
      `[sample-agent] /chat received — chat=${chatId} prompt: ${JSON.stringify(prompt.slice(0, 80))}`,
    );

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Per-request cancellation. When the SSE client disconnects
    // (browser tab closed, fetch().abort(), nav-away) we abort the
    // in-flight agent loop so a dead client doesn't keep spending
    // tokens. The `close` listener fires on both `req` (incoming
    // socket) and `res` (response stream); listening on req catches
    // both keep-alive teardown + explicit client aborts.
    const abortController = new AbortController();
    let aborted = false;
    const onClientClose = (): void => {
      if (aborted) return;
      aborted = true;
      abortController.abort();
    };
    req.on('close', onClientClose);

    const snapshot = getOrCreateChatSnapshot(chatId);

    const startedAt = Date.now();
    let msgCount = 0;
    try {
      for await (const msg of runAgent({
        prompt,
        chatId,
        mcpServers: opts.mcpServers,
        abortController,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.systemPrompt !== undefined
          ? { systemPrompt: opts.systemPrompt }
          : {}),
      })) {
        msgCount += 1;
        console.log(`[sample-agent] sdk message #${msgCount}: ${msg.type}`);
        if (msg.type === 'assistant') {
          for (const c of msg.message.content ?? []) {
            if (c.type === 'tool_use' && typeof c.name === 'string') {
              console.log(`[sample-agent]   → tool_use: ${c.name}`);
            }
          }
        }
        // Snapshot capture — always happens, even when the client has
        // disconnected. The agent loop keeps running until completion
        // regardless of the SSE socket state (we ALSO abort the SDK on
        // client-close above; this just hedges the ordering race), so
        // any final tool_result still gets recorded for the next
        // browser refresh. The browser hook (`useMcpAppsChat`) replays
        // the recorded `messages[]` through the same `handleEvent` the
        // live SSE stream uses — re-spawning every render entry and
        // re-mounting every iframe — so no separate per-render parse
        // step is needed here.
        snapshot.messages.push(msg);
        // Check abort BEFORE writing — otherwise the first
        // post-abort iteration writes one message to an
        // already-closed SSE socket and Node logs an EPIPE.
        if (aborted) break;
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      }
      console.log(
        `[sample-agent] /chat complete — ${msgCount} messages in ${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      // AbortError is the expected outcome of client disconnect —
      // don't propagate it as a tool error to a now-dead SSE.
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || abortController.signal.aborted);
      if (!isAbort) {
        console.error(
          `[sample-agent] /chat agent error after ${Date.now() - startedAt}ms (${msgCount} messages):`,
          err,
        );
        const message = err instanceof Error ? err.message : String(err);
        res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      }
    } finally {
      req.off('close', onClientClose);
    }
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

/**
 * The ggui MCP server speaks streamable-HTTP — depending on the
 * negotiated Accept, the response is either:
 *   - `application/json` — a single JSON-RPC envelope; just parse it.
 *   - `text/event-stream` — one or more `event: message\ndata: <JSON>`
 *     frames; we expect exactly one for a tools/call.
 *
 * Extracts the first JSON-RPC envelope from either shape and returns
 * it. On parse failure, returns a synthetic error envelope so the
 * browser caller can still classify it as a fallback.
 */
function parseMcpResponse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { jsonrpc: '2.0', error: { message: 'empty MCP response' } };
  }
  // SSE: `data: { … }` (possibly with `event:` lines before).
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const dataLine = trimmed
      .split('\n')
      .find((line) => line.startsWith('data:'));
    if (dataLine === undefined) {
      return { jsonrpc: '2.0', error: { message: 'SSE without data frame' } };
    }
    try {
      return JSON.parse(dataLine.slice('data:'.length).trim());
    } catch (err) {
      return {
        jsonrpc: '2.0',
        error: { message: `SSE JSON parse failed: ${(err as Error).message}` },
      };
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    return {
      jsonrpc: '2.0',
      error: { message: `JSON parse failed: ${(err as Error).message}` },
    };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
