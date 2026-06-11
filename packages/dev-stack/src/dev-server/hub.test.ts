/**
 * Hub shell route + render tests. Exercises both the pure HTML
 * renderer and the live HTTP route through `startDevServer` —
 * including the crucial "served without Authorization" path that
 * makes the hub actually openable in a browser.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GguiJsonV1 } from '@ggui-ai/project-config';
import { LocalUiRegistry } from '../local-registry/local-registry.js';
import { startDevServer, type DevServerHandle } from './http.js';
import { createSecurityPolicy } from './auth.js';
import { renderHubHtml } from './hub.js';

function makeGgui(name: string, slug: string): GguiJsonV1 {
  return {
    schema: '1',
    protocol: '1.1',
    app: { name, slug },
    blueprints: { include: [] },
    primitives: { packages: ['@ggui-ai/design/primitives'], local: [] },
    mcpMounts: [],
  };
}

describe('renderHubHtml (pure)', () => {
  it('renders a complete HTML document with app name in the title', () => {
    const html = renderHubHtml({
      token: 'abc123',
      manifest: makeGgui('Weather Bot', 'weather'),
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>ggui dev — Weather Bot</title>');
    expect(html).toContain('slug: weather');
    expect(html).toContain('protocol: 1.1');
  });

  it('embeds the bearer token in the window.__GGUI_DEV__ bootstrap', () => {
    const html = renderHubHtml({
      token: 'secret-token',
      manifest: makeGgui('App', 'app'),
    });
    // Matches "window.__GGUI_DEV__ = {…\"token\":\"secret-token\"…}"
    expect(html).toMatch(/window\.__GGUI_DEV__ = \{[^<]*"token":"secret-token"/);
  });

  it('embeds token:null when the server has no security policy', () => {
    const html = renderHubHtml({
      token: null,
      manifest: makeGgui('App', 'app'),
    });
    expect(html).toMatch(/"token":null/);
  });

  it('HTML-escapes the manifest fields so name/slug can contain special chars', () => {
    const html = renderHubHtml({
      token: null,
      manifest: makeGgui('<script>alert(1)</script>', 'x-y'),
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('JSON-escapes `<` in the bootstrap so a name cannot break out of the script', () => {
    const html = renderHubHtml({
      token: null,
      // Name containing "</script" tries to close the bootstrap tag.
      manifest: makeGgui('Bad</script><img>', 'x'),
    });
    // Extract the JSON payload between `<script>` and its matching
    // `</script>`. The payload MUST NOT contain a literal `</script>`.
    const match = /<script>([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const payload = match![1] ?? '';
    expect(payload).not.toContain('</script>');
    // Unicode escape should be present instead of the raw `<`.
    expect(payload).toContain('\\u003c');
  });

  it('sets noindex + loopback-only framing hints via CSS reset', () => {
    const html = renderHubHtml({
      token: null,
      manifest: makeGgui('App', 'app'),
    });
    expect(html).toContain('name="robots"');
    expect(html).toContain('noindex');
  });

  it('includes the four dashboard panel containers', () => {
    const html = renderHubHtml({
      token: null,
      manifest: makeGgui('App', 'app'),
    });
    expect(html).toContain('data-panel="runtime"');
    expect(html).toContain('data-panel="registry"');
    expect(html).toContain('data-panel="uis"');
    expect(html).toContain('data-panel="events"');
    expect(html).toContain('id="runtime-body"');
    expect(html).toContain('id="registry-body"');
    expect(html).toContain('id="uis-body"');
    expect(html).toContain('id="events-body"');
  });

  it('embeds the dashboard JS that polls the four known endpoints', () => {
    const html = renderHubHtml({
      token: null,
      manifest: makeGgui('App', 'app'),
    });
    expect(html).toContain("'/health'");
    expect(html).toContain("'/uis'");
    expect(html).toContain("'/runtime/status'");
    expect(html).toContain("'/runtime/events'");
    // Poll interval + tick updater wire.
    expect(html).toMatch(/setInterval\(tick,\s*POLL_MS\)/);
  });

  it('renders the Preview panel + selection wiring', () => {
    const html = renderHubHtml({
      token: null,
      manifest: makeGgui('App', 'app'),
    });
    // Panel container.
    expect(html).toContain('data-panel="preview"');
    expect(html).toContain('id="preview-body"');
    expect(html).toContain('id="preview-label"');
    expect(html).toContain('id="preview-clear"');
    // UI rows become real buttons with aria-pressed so focus + a11y work.
    expect(html).toMatch(/button[^>]+class="ui-row"/);
    expect(html).toMatch(/aria-pressed="/);
    // Selection state is tracked and the preview helper is in scope.
    expect(html).toMatch(/renderPreview/);
    expect(html).toMatch(/setSelectedUi/);
    // Iframe src computed from the selected id + JS attaches the
    // preview-frame class before mounting.
    expect(html).toContain("'/hub/preview?ui='");
    expect(html).toMatch(/frame\.className = 'preview-frame'/);
    // CSS rule for the frame exists.
    expect(html).toMatch(/\.preview-frame \{/);
    // URL persistence so a reload lands back on the same selection.
    expect(html).toMatch(/readSelectedFromUrl/);
    expect(html).toMatch(/writeSelectedToUrl/);
    // Diagnostics panel advertises the preview endpoint too.
    expect(html).toContain("/hub/preview?ui=<id>");
  });

  it('renders the Diagnostics panel and the keyboard-refresh hint', () => {
    const html = renderHubHtml({
      token: null,
      manifest: makeGgui('App', 'app'),
    });
    expect(html).toContain('data-panel="diagnostics"');
    expect(html).toContain('id="diagnostics-body"');
    expect(html).toMatch(/renderDiagnostics/);
    expect(html).toMatch(/copyToClipboard/);
    expect(html).toContain('<kbd>r</kbd>');
    // Keyboard 'r' handler installed.
    expect(html).toMatch(/installKeyboardShortcuts/);
  });

  it('subscribes to /events via fetch-stream and renders a live indicator', () => {
    const html = renderHubHtml({
      token: null,
      manifest: makeGgui('App', 'app'),
    });
    // Live indicator slot + initial state.
    expect(html).toContain('id="live"');
    expect(html).toContain("setLive('live'");
    expect(html).toContain("setLive('reconnecting'");
    // SSE subscription path: fetch to /events + parse SSE frames.
    expect(html).toContain("fetch('/events'");
    expect(html).toMatch(/subscribeRegistry/);
    expect(html).toMatch(/readSse/);
    // Only `event: ui` frames dispatch; keep-alive comments are skipped.
    expect(html).toMatch(/startsWith\(':'\)/);
    // On UI event, refresh registry panels immediately.
    expect(html).toMatch(/refreshRegistry/);
  });
});

describe('GET /hub served from the dev server', () => {
  let tmp: string;
  let handle: DevServerHandle | null = null;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-hub-http-'));
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  async function boot(options: { withSecurity: boolean }): Promise<DevServerHandle> {
    const manifest = makeGgui('Weather Bot', 'weather');
    const registry = new LocalUiRegistry({ projectRoot: tmp, manifest });
    const security = options.withSecurity
      ? createSecurityPolicy({ token: 'fixed-test-token', env: {} })
      : undefined;
    const h = await startDevServer({ registry, manifest, port: 0, security });
    handle = h;
    return h;
  }

  function url(h: DevServerHandle, p: string): string {
    return `http://${h.host}:${h.port}${p}`;
  }

  it('returns the hub HTML with 200 + text/html and no Authorization needed', async () => {
    const h = await boot({ withSecurity: true });
    const res = await fetch(url(h, '/hub'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.text();
    expect(body).toContain('<title>ggui dev — Weather Bot</title>');
    expect(body).toContain('"token":"fixed-test-token"');
  });

  it('treats /hub/ (trailing slash) identically', async () => {
    const h = await boot({ withSecurity: true });
    const res = await fetch(url(h, '/hub/'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>ggui dev — Weather Bot</title>');
  });

  it('embeds token:null when the server was started without security', async () => {
    const h = await boot({ withSecurity: false });
    const res = await fetch(url(h, '/hub'));
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/"token":null/);
  });

  it('still requires bearer on the data endpoints used by the hub', async () => {
    const h = await boot({ withSecurity: true });
    // Hub HTML is public — the JS inside uses the embedded token
    // to call `/uis`, `/runtime/status`, etc. Those MUST still
    // refuse unauthenticated XHRs.
    const bare = await fetch(url(h, '/uis'));
    expect(bare.status).toBe(401);
    const authed = await fetch(url(h, '/uis'), {
      headers: { Authorization: 'Bearer fixed-test-token' },
    });
    expect(authed.status).toBe(200);
  });

  it('does not leak /hub as a wildcard prefix', async () => {
    // /hub/unknown should fall through to the 404 branch, not
    // serve the shell. This guards against accidental
    // prefix-matching when we grow /hub/app.js later.
    const h = await boot({ withSecurity: true });
    const res = await fetch(url(h, '/hub/unknown'), {
      headers: { Authorization: 'Bearer fixed-test-token' },
    });
    expect(res.status).toBe(404);
  });
});
