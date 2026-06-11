/**
 * Tests for `startSandboxProxyServer`.
 *
 * Coverage:
 *   - Server boots on a random port (0) and reports the chosen port.
 *   - `GET /sandbox.html` returns 200 + spec-canonical sandbox HTML.
 *   - `Content-Security-Policy` header is built from the `?csp=` query
 *     param and falls back to a safe default when absent / malformed.
 *   - Domain entries with injection characters (`;`, quotes) are
 *     stripped from the header.
 *   - `close()` releases the port.
 *
 * Lane 1 of the test taxonomy (in-process, no browser).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  startSandboxProxyServer,
  type SandboxProxyServerHandle,
} from './sandbox-proxy.js';

describe('startSandboxProxyServer', () => {
  let handle: SandboxProxyServerHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
  });

  it('boots on an OS-assigned port and reports a usable URL', async () => {
    handle = await startSandboxProxyServer({ port: 0 });
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/sandbox.html`);
  });

  it('GET /sandbox.html returns 200 + HTML body with the proxy script', async () => {
    handle = await startSandboxProxyServer({ port: 0 });
    const res = await fetch(handle.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    // Spec-canonical sandbox markers — same shape as upstream
    // ext-apps/examples/basic-host/sandbox.html.
    expect(body).toContain('ui/notifications/sandbox-proxy-ready');
    expect(body).toContain('ui/notifications/sandbox-resource-ready');
    expect(body).toContain('allow-scripts allow-same-origin allow-forms');
  });

  it('GET / serves the same body as /sandbox.html', async () => {
    handle = await startSandboxProxyServer({ port: 0 });
    const rootRes = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(rootRes.status).toBe(200);
    const rootBody = await rootRes.text();
    const sandboxRes = await fetch(handle.url);
    const sandboxBody = await sandboxRes.text();
    expect(rootBody).toBe(sandboxBody);
  });

  it('returns 404 for any other path', async () => {
    handle = await startSandboxProxyServer({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${handle.port}/some-other`);
    expect(res.status).toBe(404);
  });

  it('sets a default CSP header when ?csp is absent', async () => {
    handle = await startSandboxProxyServer({ port: 0 });
    const res = await fetch(handle.url);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp!).toContain("default-src 'self' 'unsafe-inline'");
    expect(csp!).toContain("frame-src 'none'");
    expect(csp!).toContain("object-src 'none'");
  });

  it('includes resourceDomains in script-src when ?csp passes them', async () => {
    handle = await startSandboxProxyServer({ port: 0 });
    const csp = encodeURIComponent(
      JSON.stringify({ resourceDomains: ['https://cdn.example.com'] }),
    );
    const res = await fetch(`${handle.url}?csp=${csp}`);
    const header = res.headers.get('content-security-policy');
    expect(header).toBeTruthy();
    expect(header!).toContain('https://cdn.example.com');
    expect(header!).toMatch(/script-src[^;]*https:\/\/cdn\.example\.com/);
  });

  it('strips CSP entries containing directive-injection characters', async () => {
    handle = await startSandboxProxyServer({ port: 0 });
    // Injection attempts via `;` (new directive) and `'` (keyword) MUST
    // be filtered before joining into the header.
    const csp = encodeURIComponent(
      JSON.stringify({
        resourceDomains: [
          'https://safe.example.com',
          "https://evil.com'; script-src 'unsafe-eval",
          'https://injected;evil.com',
        ],
      }),
    );
    const res = await fetch(`${handle.url}?csp=${csp}`);
    const header = res.headers.get('content-security-policy');
    expect(header).toBeTruthy();
    expect(header!).toContain('https://safe.example.com');
    expect(header!).not.toContain('evil.com');
    expect(header!).not.toContain('injected');
  });

  it('falls back to default CSP when ?csp is malformed JSON', async () => {
    handle = await startSandboxProxyServer({ port: 0 });
    const res = await fetch(`${handle.url}?csp=not-json`);
    expect(res.status).toBe(200);
    const header = res.headers.get('content-security-policy');
    expect(header).toBeTruthy();
    expect(header!).toContain("default-src 'self' 'unsafe-inline'");
  });

  it('emits no-cache headers so each load resamples CSP', async () => {
    handle = await startSandboxProxyServer({ port: 0 });
    const res = await fetch(handle.url);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('close() releases the port', async () => {
    handle = await startSandboxProxyServer({ port: 0 });
    const portWas = handle.port;
    await handle.close();
    handle = null;
    // Re-bind to the same port — would EADDRINUSE if not released.
    // OS may reuse the port for a new server here, but this proves
    // close() actually shut the previous one down.
    const retry = await startSandboxProxyServer({ port: portWas });
    expect(retry.port).toBe(portWas);
    await retry.close();
  });
});
