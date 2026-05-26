/* eslint-disable no-console */
/**
 * Minimal HTTP server: static chat shell + SSE-streamed agent loop.
 *
 *   GET  /                serves public/index.html
 *   GET  /chat.js, /chat.css   static
 *   POST /chat            { prompt } → SSE stream of SDKMessage events
 *
 * No framework dependency — node:http only. Keeps the sample's
 * `node_modules/` tiny so the test harness boots fast.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Vite builds the React chat UI into `dist-ui/`. The Node server
// reads from there as a flat static-files directory. Run
// `pnpm run build:ui` (or `pnpm run dev` / `pnpm start` which chain
// the build) before booting if `dist-ui/` is missing.
const PUBLIC_DIR = join(__dirname, '..', 'dist-ui');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface ServerOptions {
  readonly port: number;
  readonly mcpUrl: string;
  /** Optional secondary MCP endpoint (e.g. todo MCP for the e2e sample). */
  readonly todoMcpUrl?: string;
  /** Model id passed to the Claude Agent SDK (default: claude-haiku-4-5). */
  readonly model?: string;
  /** Optional override; passed straight through to runAgent. */
  readonly systemPrompt?: string | null;
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const server = createServer((req, res) => {
    handleRequest(req, res, opts).catch((err) => {
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
      console.log(`[sample-agent] talking to ggui MCP: ${opts.mcpUrl}`);
      resolve();
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);

  // Meta proxy — forwards the browser's `/r/<shortCode>` GET (with
  // `Accept: application/json`) to the ggui MCP server's
  // content-negotiated public-render endpoint, which returns the slice
  // envelope. The Anthropic SDK strips `_meta` (incl. the `ai.ggui/*`
  // slices) from `tool_result` blocks (the API spec only allows text
  // content), so the chat UI recovers the meta slice pair via this
  // side-channel.
  //
  // Same proxy posture as `/relay/tools-call`: keeps the browser on
  // a single same-origin endpoint, avoids CORS on the MCP server.
  const renderMatch = url.pathname.match(/^\/r\/([^/]+)$/);
  if (req.method === 'GET' && renderMatch && req.headers['accept']?.includes('application/json')) {
    const shortCode = renderMatch[1] ?? '';
    try {
      const mcpOrigin = new URL(opts.mcpUrl);
      mcpOrigin.pathname = `/r/${encodeURIComponent(shortCode)}`;
      // Forward the browser's `?sig=...&exp=...` to the MCP server's
      // render-signing gate. Stripping the query was a real bug: when
      // the MCP server boots with render-signing on (the default),
      // every `/r/<code>` URL the agent receives carries a sig+exp,
      // and the route enforces the same signature on both HTML and
      // JSON branches. Dropping the query forces a 403.
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
      res.end(JSON.stringify({ error: `bootstrap proxy error: ${message}` }));
    }
    return;
  }

  // MCP Apps relay — forwards iframe-issued `tools/call` (postMessage)
  // to the ggui MCP server over HTTP. The iframe holds no auth
  // credential; this host (running in Node) is the protocol-defined
  // relay party. The browser-side <McpAppIframe onToolCall> calls
  // POST /relay/tools-call which proxies to opts.mcpUrl.
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
      const mcpReq = await fetch(opts.mcpUrl, {
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

    // Per-tab chat-session id from the browser's `X-Chat-Session-Id`
    // header — keys per-chat agent state (conversation history,
    // resume tokens, ggui sessionId continuity) so multi-turn flows
    // preserve context across `/chat` POSTs. Auto-mint when missing
    // (non-browser callers like curl get single-turn isolation).
    const chatSessionHeader = req.headers['x-chat-session-id'];
    const chatSessionId =
      typeof chatSessionHeader === 'string' && chatSessionHeader.length > 0
        ? chatSessionHeader
        : (() => {
            const minted = randomUUID();
            console.warn(
              `[sample-agent] /chat missing X-Chat-Session-Id header — minted ${minted} (single-turn isolation; clients should set the header to preserve multi-turn context)`,
            );
            return minted;
          })();

    console.log(
      `[sample-agent] /chat received — chat=${chatSessionId} prompt: ${JSON.stringify(prompt.slice(0, 80))}`,
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

    const startedAt = Date.now();
    let msgCount = 0;
    try {
      for await (const msg of runAgent({
        prompt,
        chatSessionId,
        mcpUrl: opts.mcpUrl,
        abortController,
        ...(opts.todoMcpUrl !== undefined
          ? { todoMcpUrl: opts.todoMcpUrl }
          : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.systemPrompt !== undefined
          ? { systemPrompt: opts.systemPrompt }
          : {}),
      })) {
        msgCount += 1;
        console.log(`[sample-agent] sdk message #${msgCount}: ${msg.type}`);
        // Surface every tool call so failure logs show what the agent
        // actually did (the test's tool-name harvest only runs on
        // success — without this, a stalled round-trip is invisible).
        if (msg.type === 'assistant') {
          const m = msg as { message?: { content?: ReadonlyArray<{ type?: string; name?: string }> } };
          for (const c of m.message?.content ?? []) {
            if (c.type === 'tool_use' && typeof c.name === 'string') {
              console.log(`[sample-agent]   → tool_use: ${c.name}`);
            }
          }
        }
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

  if (req.method === 'GET') {
    const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (filename.includes('..')) {
      res.writeHead(403);
      res.end();
      return;
    }
    const ext = filename.match(/\.[^.]+$/)?.[0] ?? '';
    const mime = MIME[ext] ?? 'application/octet-stream';
    try {
      const content = await readFile(join(PUBLIC_DIR, filename));
      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
    return;
  }

  res.writeHead(405);
  res.end();
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
