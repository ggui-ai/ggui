/**
 * Minimal MCP-Apps HOST stand-in for browser scenarios.
 *
 * The R5 retirement (2026-05-26) removed the bearer-by-obscurity
 * `/r/<shortCode>` HTTP fallback, and `ggui_render`'s wire output
 * carries no renderer URL — the spec-canonical mount handle is the
 * `resourceUri` (`ui://ggui/render/...`) resolved via MCP
 * `resources/read`. Resolving + framing that resource is a HOST
 * responsibility (claude.ai, the sample frontend, …), so a browser
 * test needs a host party.
 *
 * This fixture is that party, reduced to the protocol-mandated
 * minimum. It serves three same-origin routes from an ephemeral
 * `node:http` server:
 *
 *   GET  /          — wrapper page: mounts the resource document in an
 *                     `<iframe data-ggui-mcp-app-iframe>` and runs the
 *                     host bridge:
 *                       - `ui/initialize` → spec-shaped result
 *                         (`protocolVersion`/`hostInfo`/
 *                         `hostCapabilities`/`hostContext` — same shape
 *                         the iframe-runtime's own boot tests pin in
 *                         `iframe-runtime/src/__tests__/boot-helpers.ts`)
 *                       - `tools/call` → forwarded to `POST /mcp`
 *                       - anything else with an id → `-32601`
 *   GET  /resource  — the MCP-App resource document verbatim
 *                     (`resources/read` `contents[0].text`).
 *   POST /mcp       — same-origin JSON-RPC proxy to the real ggui MCP
 *                     endpoint, with the host's bearer attached. Keeps
 *                     the wrapper page free of cross-origin concerns —
 *                     exactly the relay role a production host plays.
 *
 * The iframe is load-bearing: the iframe-runtime negotiates
 * `ui/initialize` over `postMessage` to `window.parent`. Serving the
 * resource document top-level makes `parent === window`, the runtime
 * receives its own request, answers `-32601`, and treats that as the
 * host's response — boot fails. (Observed live 2026-06-11.)
 */
import { createServer, type Server } from 'node:http';
import { readResource } from './mcp-client.js';

/**
 * Playwright selector for the host's app iframe — pair with
 * `page.frameLocator(MCP_APP_IFRAME_SELECTOR)` to reach the rendered
 * UI inside the resource document.
 */
export const MCP_APP_IFRAME_SELECTOR = 'iframe[data-ggui-mcp-app-iframe]';

export interface McpAppHostOptions {
  /** Full ggui MCP endpoint `tools/call` is proxied to. */
  readonly mcpUrl: string;
  /** MCP-App resource document (`text/html` from `resources/read`). */
  readonly resourceHtml: string;
  /**
   * Bearer attached to proxied `tools/call`. Defaults to the same
   * resolution `@ggui-ai/agent-server` uses for its MCP connections
   * (`GGUI_MCP_BEARER`, then `'dev'` — paired with
   * `ggui serve --dev-allow-all`), so iframe-issued calls carry the
   * same identity as the agent that created the render.
   */
  readonly bearer?: string;
  /**
   * `Content-Security-Policy` header value stamped on BOTH the
   * wrapper page and the resource document (ggui#522 slice 3). Lets a
   * scenario mount the render under a strict-CSP host posture — no
   * `blob:`, no `data:`, no `'unsafe-eval'` — the way the ggui.ai
   * landing (and any hardened embedder) serves its pages. Absent ⇒ no
   * header, the permissive default every other scenario runs under.
   */
  readonly csp?: string;
  /**
   * A `CallToolResult` the host forwards to the app as
   * `ui/notifications/tool-result` right after answering
   * `ui/initialize` — the spec-canonical delivery a real host performs
   * (claude.ai, Claude Desktop). Optional: the per-render self-contained
   * shell needs no tool result (its envelope is inlined); the
   * DECLARATION-level static shell does, and under the read-plane-only
   * posture that result carries only the view's locator, which the
   * shell resolves through the `resources/read` proxy below (ggui#537).
   */
  readonly toolResult?: Record<string, unknown>;
}

export interface McpAppHostHandle {
  /** URL of the wrapper page (open this in the browser). */
  readonly url: string;
  close(): Promise<void>;
}

/**
 * `ui/initialize` protocol version the host advertises. Matches the
 * version the iframe-runtime's boot fixtures pin
 * (`boot-helpers.ts: PROTOCOL_VERSION`).
 */
const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';

function buildWrapperHtml(toolResult: Record<string, unknown> | undefined): string {
  // Script-safe JSON: `<` escaped so a tool result carrying "</script>"
  // in a text block cannot terminate the wrapper's inline script.
  const toolResultJson =
    toolResult === undefined ? 'null' : JSON.stringify(toolResult).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>wire-scenarios MCP-Apps host</title></head><body style="margin:0">
<iframe id="app" data-ggui-mcp-app-iframe src="/resource" style="width:100%;height:600px;border:0"></iframe>
<script>
var TOOL_RESULT = ${toolResultJson};
(function () {
  var iframe = document.getElementById('app');
  window.addEventListener('message', async function (ev) {
    if (!iframe.contentWindow || ev.source !== iframe.contentWindow) return;
    var req = ev.data;
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return;
    if (req.id === undefined) return; // notifications need no response
    if (req.method === 'ui/initialize') {
      iframe.contentWindow.postMessage({ jsonrpc: '2.0', id: req.id, result: {
        protocolVersion: '${MCP_APPS_PROTOCOL_VERSION}',
        hostInfo: { name: 'wire-scenarios-host', version: '1.0' },
        hostCapabilities: {},
        hostContext: { availableDisplayModes: ['inline'] },
      } }, '*');
      // Spec-canonical delivery: the tool result rides
      // ui/notifications/tool-result once the app is initialized.
      if (TOOL_RESULT !== null) {
        iframe.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: TOOL_RESULT }, '*');
      }
      return;
    }
    if (req.method === 'resources/read') {
      // Host-proxied resource read (the App SDK's readServerResource /
      // the shell's read-plane door, ggui#537): the HOST's MCP client
      // performs the read; the sandbox never fetches the server.
      try {
        var rparams = req.params || {};
        var rresp = await fetch('/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'resources/read', params: { uri: rparams.uri || '' } }),
        });
        var rtext = (await rresp.text()).trim();
        var rline = rtext;
        if (rtext.indexOf('event:') === 0 || rtext.indexOf('data:') === 0) {
          var rdata = rtext.split('\\n').find(function (l) { return l.indexOf('data:') === 0; });
          rline = rdata ? rdata.slice('data:'.length).trim() : '{}';
        }
        var rrpc = JSON.parse(rline);
        iframe.contentWindow.postMessage(
          Object.assign({ jsonrpc: '2.0', id: req.id }, rrpc.error !== undefined ? { error: rrpc.error } : { result: rrpc.result }),
          '*',
        );
      } catch (rerr) {
        iframe.contentWindow.postMessage(
          { jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(rerr) } },
          '*',
        );
      }
      return;
    }
    if (req.method === 'tools/call') {
      try {
        var params = req.params || {};
        var resp = await fetch('/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Math.floor(Math.random() * 1e9),
            method: 'tools/call',
            params: { name: params.name || '', arguments: params.arguments || {} },
          }),
        });
        var text = await resp.text();
        var trimmed = text.trim();
        var line = trimmed;
        if (trimmed.indexOf('event:') === 0 || trimmed.indexOf('data:') === 0) {
          var dataLine = trimmed.split('\\n').find(function (l) { return l.indexOf('data:') === 0; });
          line = dataLine ? dataLine.slice('data:'.length).trim() : '{}';
        }
        var rpc = JSON.parse(line);
        iframe.contentWindow.postMessage(
          Object.assign({ jsonrpc: '2.0', id: req.id }, rpc.error !== undefined ? { error: rpc.error } : { result: rpc.result }),
          '*',
        );
      } catch (err) {
        iframe.contentWindow.postMessage(
          { jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(err) } },
          '*',
        );
      }
      return;
    }
    iframe.contentWindow.postMessage(
      { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method_not_supported' } },
      '*',
    );
  });
})();
</script></body></html>`;
}

/**
 * Boot the host on an ephemeral 127.0.0.1 port. Caller owns `close()`.
 */
export async function startMcpAppHost(
  opts: McpAppHostOptions,
): Promise<McpAppHostHandle> {
  const bearer = opts.bearer ?? process.env.GGUI_MCP_BEARER ?? 'dev';
  const wrapperHtml = buildWrapperHtml(opts.toolResult);

  const cspHeader =
    opts.csp !== undefined ? { 'Content-Security-Policy': opts.csp } : {};
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...cspHeader,
      });
      res.end(wrapperHtml);
      return;
    }
    if (req.method === 'GET' && req.url === '/resource') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...cspHeader,
      });
      res.end(opts.resourceHtml);
      return;
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        void (async () => {
          try {
            const upstream = await fetch(opts.mcpUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                Authorization: `Bearer ${bearer}`,
              },
              body,
            });
            const text = await upstream.text();
            res.writeHead(upstream.status, {
              'Content-Type':
                upstream.headers.get('content-type') ?? 'application/json',
            });
            res.end(text);
          } catch (err) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: { code: -32603, message: `mcp proxy failed: ${String(err)}` },
              }),
            );
          }
        })();
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mcp-app-host: server.address() did not return a port');
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Sever keep-alive sockets first — the browser page typically
        // outlives the host handle (afterEach closes it later), and
        // `server.close()` alone would wait on those sockets forever.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export interface MountRenderResourceOptions {
  /** Full ggui MCP endpoint (`resources/read` target + tools/call proxy). */
  readonly mcpUrl: string;
  /** Spec-canonical mount handle from `ggui_render` (`ui://ggui/render/...`). */
  readonly resourceUri: string;
  /** Optional bearer override — see {@link McpAppHostOptions.bearer}. */
  readonly bearer?: string;
  /** Optional strict-CSP header — see {@link McpAppHostOptions.csp}. */
  readonly csp?: string;
}

/**
 * Resolve a render's MCP-App resource document via `resources/read`
 * and boot the host stand-in around it — the full HOST-side mount
 * dance every browser scenario shares. Open the returned handle's
 * `url` in a browser and reach the rendered UI through
 * {@link MCP_APP_IFRAME_SELECTOR}. Caller owns `close()`.
 */
export async function mountRenderResource(
  opts: MountRenderResourceOptions,
): Promise<McpAppHostHandle> {
  const resource = await readResource(opts.mcpUrl, opts.resourceUri);
  const resourceHtml = resource.result?.contents?.[0]?.text;
  if (typeof resourceHtml !== 'string' || resourceHtml.length === 0) {
    throw new Error(
      `resources/read(${opts.resourceUri}) returned no text content: ` +
        JSON.stringify(resource).slice(0, 400),
    );
  }
  return startMcpAppHost({
    mcpUrl: opts.mcpUrl,
    resourceHtml,
    ...(opts.bearer !== undefined ? { bearer: opts.bearer } : {}),
    ...(opts.csp !== undefined ? { csp: opts.csp } : {}),
  });
}
