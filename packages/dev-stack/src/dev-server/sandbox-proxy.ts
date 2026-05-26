/**
 * `startSandboxProxyServer` — MCP-Apps spec-compliant sandbox proxy host
 * for `<AppRenderer>`.
 *
 * # Why this exists
 *
 * The MCP Apps spec (specification/2026-01-26/apps.mdx, double-iframe
 * sandbox architecture) mandates that the host and the sandbox iframe
 * live on DIFFERENT origins. The host wraps the sandbox iframe; the
 * sandbox iframe wraps the untrusted app HTML. Separating origins
 * means a compromise of the app cannot reach host APIs via
 * same-origin DOM access.
 *
 * `@mcp-ui/client`'s `<AppRenderer>` accepts a `sandbox: { url }` prop
 * pointing at a public URL serving `sandbox.html`. We ship that file +
 * its message-relay JS as a self-contained HTML string and serve it
 * over plain Node `http` on a separate port. Samples (and any consumer
 * of the dev-stack) boot this alongside their agent server.
 *
 * # Reference impl
 *
 * Adapted from
 * `github.com/modelcontextprotocol/ext-apps/examples/basic-host/`
 * (sandbox.html + src/sandbox.ts + serve.ts). Inlined into a single
 * HTML so the dev-stack doesn't need to bundle a static asset.
 *
 * # Security
 *
 *   - CSP set via HTTP headers per `?csp=<urlencoded-json>` query
 *     (tamper-proof; meta tags can be overridden by inline scripts).
 *   - Sanitizes CSP domain entries to block `;`, newlines, quotes,
 *     spaces — defends against directive injection.
 *   - Binds to `127.0.0.1` by default. Pass `host: '0.0.0.0'` only
 *     when LAN exposure is required.
 *
 * # Caller pattern
 *
 * ```ts
 * import { startSandboxProxyServer } from '@ggui-ai/dev-stack';
 * const proxy = await startSandboxProxyServer({ port: 7790 });
 * console.log('Sandbox proxy:', proxy.url);
 * // ... pass proxy.url to AppRenderer's sandbox.url prop ...
 * await proxy.close();
 * ```
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

/**
 * Options for {@link startSandboxProxyServer}.
 */
export interface SandboxProxyServerOptions {
  /**
   * Port to bind. `0` asks the OS for a free port — the chosen port
   * is reflected in the returned `url`. Tests pass `0`; samples pass
   * a fixed port so the AppRenderer config is static.
   */
  readonly port: number;
  /**
   * Bind address. Defaults to `127.0.0.1` — loopback-only. Pass
   * `'0.0.0.0'` only if LAN access is required.
   */
  readonly host?: string;
}

/**
 * Handle to a running sandbox proxy server.
 */
export interface SandboxProxyServerHandle {
  /**
   * Absolute URL the AppRenderer's `sandbox.url` prop should point at.
   * Includes scheme, host, and port. Path is `/sandbox.html` — the
   * spec-canonical sandbox entry point.
   */
  readonly url: string;
  /** Actual bound port (resolved when `options.port` was `0`). */
  readonly port: number;
  /** Stops the server and releases the port. */
  readonly close: () => Promise<void>;
}

/**
 * CSP shape mirrored from `@modelcontextprotocol/ext-apps`'s
 * `McpUiResourceCsp`. Re-declared locally so dev-stack doesn't take a
 * peer dep on ext-apps for a single record shape.
 */
interface McpUiResourceCsp {
  readonly resourceDomains?: readonly string[];
  readonly connectDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
  readonly baseUriDomains?: readonly string[];
}

/**
 * Reject CSP entries containing directive-injection characters
 * (`;`, newlines, quotes, spaces). Returns the kept entries.
 */
function sanitizeCspDomains(
  domains: readonly string[] | undefined,
): readonly string[] {
  if (!domains) return [];
  return domains.filter(
    (d) => typeof d === 'string' && !/[;\r\n'" ]/.test(d),
  );
}

/**
 * Build the `Content-Security-Policy` header value from an
 * (already-sanitized) CSP record. Mirrors `serve.ts` in the upstream
 * basic-host example so behavior matches the spec reference.
 */
function buildCspHeader(csp: McpUiResourceCsp | undefined): string {
  const resourceDomains = sanitizeCspDomains(csp?.resourceDomains).join(' ');
  const connectDomains = sanitizeCspDomains(csp?.connectDomains).join(' ');
  const frameDomains = sanitizeCspDomains(csp?.frameDomains).join(' ');
  const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains).join(' ');

  const directives = [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resourceDomains}`.trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
    `img-src 'self' data: blob: ${resourceDomains}`.trim(),
    `font-src 'self' data: blob: ${resourceDomains}`.trim(),
    `media-src 'self' data: blob: ${resourceDomains}`.trim(),
    `connect-src 'self' ${connectDomains}`.trim(),
    `worker-src 'self' blob: ${resourceDomains}`.trim(),
    frameDomains.length > 0
      ? `frame-src ${frameDomains}`
      : "frame-src 'none'",
    "object-src 'none'",
    baseUriDomains.length > 0
      ? `base-uri ${baseUriDomains}`
      : "base-uri 'none'",
  ];

  return directives.join('; ');
}

/**
 * The self-contained sandbox.html body. Inlines the message-relay JS
 * from `examples/basic-host/src/sandbox.ts` so we ship one file and
 * don't need a build step. The script is a verbatim port that:
 *
 *   1. Asserts iframe isolation (throws if it can reach `window.top`).
 *   2. Creates an inner iframe sandboxed with `allow-scripts
 *      allow-same-origin allow-forms`.
 *   3. Intercepts `ui/notifications/sandbox-resource-ready` from the
 *      parent to write the app HTML into the inner iframe.
 *   4. Relays every other postMessage bidirectionally between parent
 *      and inner.
 *   5. Posts `ui/notifications/sandbox-proxy-ready` once attached.
 */
const SANDBOX_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light dark">
    <title>ggui sandbox proxy</title>
    <style>
      html, body { margin: 0; height: 100vh; width: 100vw; background-color: transparent; }
      body { display: flex; flex-direction: column; }
      * { box-sizing: border-box; }
      iframe {
        background-color: transparent;
        border: 0px none transparent;
        padding: 0px;
        overflow: hidden;
        flex-grow: 1;
        color-scheme: inherit;
      }
    </style>
  </head>
  <body>
    <script>
(function(){
  'use strict';
  if (window.self === window.top) {
    throw new Error('This file is only to be used in an iframe sandbox.');
  }
  if (!document.referrer) {
    throw new Error('No referrer, cannot validate embedding site.');
  }
  var EXPECTED_HOST_ORIGIN = new URL(document.referrer).origin;
  var OWN_ORIGIN = new URL(window.location.href).origin;
  // Security self-test: top access MUST throw (sandbox attribute strips same-origin).
  try {
    window.top.alert('If you see this, the sandbox is not setup securely.');
    throw 'FAIL';
  } catch (e) {
    if (e === 'FAIL') {
      throw new Error('The sandbox is not setup securely.');
    }
  }
  // Inner iframe — the untrusted app HTML lands here.
  var inner = document.createElement('iframe');
  inner.style = 'width:100%; height:100%; border:none;';
  inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  document.body.appendChild(inner);
  var RESOURCE_READY = 'ui/notifications/sandbox-resource-ready';
  var PROXY_READY = 'ui/notifications/sandbox-proxy-ready';
  window.addEventListener('message', function(event) {
    if (event.source === window.parent) {
      if (event.origin !== EXPECTED_HOST_ORIGIN) {
        console.error('[Sandbox] Rejecting parent message from unexpected origin:', event.origin);
        return;
      }
      if (event.data && event.data.method === RESOURCE_READY) {
        var params = event.data.params || {};
        var html = params.html;
        var sandboxAttr = params.sandbox;
        if (typeof sandboxAttr === 'string') {
          inner.setAttribute('sandbox', sandboxAttr);
        }
        if (typeof html === 'string') {
          var doc = inner.contentDocument || (inner.contentWindow && inner.contentWindow.document);
          if (doc) {
            doc.open();
            doc.write(html);
            doc.close();
          } else {
            inner.srcdoc = html;
          }
        }
      } else {
        if (inner && inner.contentWindow) {
          inner.contentWindow.postMessage(event.data, '*');
        }
      }
    } else if (event.source === inner.contentWindow) {
      if (event.origin !== OWN_ORIGIN) {
        console.error('[Sandbox] Rejecting inner message from unexpected origin:', event.origin);
        return;
      }
      window.parent.postMessage(event.data, EXPECTED_HOST_ORIGIN);
    }
  });
  window.parent.postMessage({
    jsonrpc: '2.0',
    method: PROXY_READY,
    params: {},
  }, EXPECTED_HOST_ORIGIN);
})();
    </script>
  </body>
</html>`;

/**
 * Start an HTTP server serving `sandbox.html` for use as
 * `<AppRenderer>`'s `sandbox.url`. The server has exactly two
 * behaviors:
 *
 *   - `GET /` and `GET /sandbox.html` → sandbox HTML + CSP header
 *     derived from `?csp=<urlencoded-json>` (mirrors upstream
 *     basic-host serve.ts).
 *   - Anything else → 404.
 *
 * Returns immediately once the server is listening; the handle's
 * `close()` releases the port.
 */
export function startSandboxProxyServer(
  options: SandboxProxyServerOptions,
): Promise<SandboxProxyServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      // Resolve URL relative to a synthetic base so we can use
      // URL parsing (req.url is path+query only).
      const url = new URL(req.url ?? '/', 'http://placeholder');
      if (
        req.method === 'GET' &&
        (url.pathname === '/' || url.pathname === '/sandbox.html')
      ) {
        let csp: McpUiResourceCsp | undefined;
        const cspParam = url.searchParams.get('csp');
        if (cspParam !== null) {
          try {
            const parsed: unknown = JSON.parse(cspParam);
            if (parsed !== null && typeof parsed === 'object') {
              csp = parsed as McpUiResourceCsp;
            }
          } catch {
            // Ignore malformed CSP — fall through to the default
            // (`'self' 'unsafe-inline'`) header. Visible in the
            // browser's console as a CSP violation if the app loads
            // external resources.
          }
        }
        res.setHeader('Content-Security-Policy', buildCspHeader(csp));
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        // CORS: AppRenderer fetches the sandbox HTML cross-origin
        // (parent vs. sandbox-proxy origin); the browser still
        // navigates the iframe even without explicit CORS, but the
        // header is harmless and unblocks any future fetch() probes.
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.statusCode = 200;
        res.end(SANDBOX_HTML);
        return;
      }
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('sandbox proxy: only GET /sandbox.html is served here\n');
    },
  );
  return new Promise<SandboxProxyServerHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(
          new Error(
            `startSandboxProxyServer: address() returned ${String(addr)}; expected AddressInfo`,
          ),
        );
        return;
      }
      const url = `http://${host}:${addr.port}/sandbox.html`;
      resolve({
        url,
        port: addr.port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => {
              if (err) rejectClose(err);
              else resolveClose();
            });
          }),
      });
    });
  });
}
