/* eslint-disable no-console */
/**
 * Minimal HTTP server: static chat shell + SSE-streamed agent loop.
 *
 *   GET  /                serves dist-ui/index.html
 *   GET  /<asset>         dist-ui static
 *   POST /chat            { prompt } → SSE stream of normalized RunMessage events
 *   POST /relay/tools-call  iframe → ggui MCP JSON-RPC proxy
 *   GET  /api/bootstrap/<shortCode>  ggui bootstrap JSON proxy
 *
 * Identical in shape to the Claude sample's server — the SDK-specific
 * differences are confined to `agent.ts`. This server is dumb pipe + auth
 * relay; it doesn't care which LLM is driving the loop.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
  readonly todoMcpUrl?: string;
  readonly model?: string;
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

  // Bootstrap proxy — forwards the browser's `/api/bootstrap/<shortCode>`
  // fetch to the ggui MCP server. The iframe needs the bootstrap envelope
  // to re-apply props on update; recovering it via a host-side JSON
  // endpoint is SDK-agnostic and works whether or not the LLM SDK strips
  // `_meta` from tool_result blocks (Anthropic does; OpenAI's behavior
  // varies by transport — fetching is the safe baseline).
  const bootstrapMatch = url.pathname.match(/^\/api\/bootstrap\/([^/]+)$/);
  if (req.method === 'GET' && bootstrapMatch) {
    const shortCode = bootstrapMatch[1] ?? '';
    try {
      const mcpOrigin = new URL(opts.mcpUrl);
      mcpOrigin.pathname = `/api/bootstrap/${encodeURIComponent(shortCode)}`;
      // Forward the browser's `?sig=...&exp=...` to the MCP server's
      // render-signing gate. Stripping the query was a real bug: when
      // the MCP server boots with render-signing on (the default),
      // every `/r/<code>` URL the agent receives carries a sig+exp,
      // and the matching `/api/bootstrap/<code>` route enforces the
      // same signature. Dropping the query forced a 403.
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

  // MCP Apps relay — iframe-issued tools/call (postMessage) → ggui MCP.
  // The iframe holds no auth credential of its own; this host is the
  // protocol-defined relay party. Keeps the browser on a single same-
  // origin endpoint and avoids CORS on the MCP server.
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

    console.log(
      `[sample-agent] /chat received — prompt: ${JSON.stringify(prompt.slice(0, 80))}`,
    );

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

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
        console.log(`[sample-agent] msg #${msgCount}: ${msg.type}`);
        if (aborted) break;
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      }
      console.log(
        `[sample-agent] /chat complete — ${msgCount} messages in ${Date.now() - startedAt}ms`,
      );
    } catch (err) {
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
 * The ggui MCP server speaks Streamable HTTP — depending on the
 * negotiated Accept, the response is either:
 *   - `application/json` — a single JSON-RPC envelope; just parse it.
 *   - `text/event-stream` — one or more `event: message\ndata: <JSON>`
 *     frames; we expect exactly one for a tools/call.
 */
function parseMcpResponse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { jsonrpc: '2.0', error: { message: 'empty MCP response' } };
  }
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
