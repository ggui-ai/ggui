/**
 * Preview iframe shell tests. Exercises both the pure HTML renderer
 * (escaping + bootstrap shape + empty-state copy) and the live HTTP
 * route — including the crucial "served without Authorization"
 * invariant that makes the iframe loadable inside `/hub`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GguiJsonV1 } from '@ggui-ai/project-config';
import { LocalUiRegistry } from '../local-registry/local-registry.js';
import { startDevServer, type DevServerHandle } from './http.js';
import { createSecurityPolicy } from './auth.js';
import {
  __setHubPreviewBundlePathForTest,
  extractSelectedId,
  renderHubPreviewHtml,
} from './hub-preview.js';

function makeGgui(name: string, slug: string): GguiJsonV1 {
  return {
    schema: '1',
    protocol: '1.1',
    app: { name, slug },
    blueprints: { include: [] },
    primitives: { packages: ['@ggui-ai/design/primitives'], local: [] },
    adapters: [],
  };
}

describe('extractSelectedId', () => {
  it('returns a plain id unchanged', () => {
    expect(extractSelectedId('ui=weather-card')).toBe('weather-card');
    expect(extractSelectedId('ui=blueprints.card')).toBe('blueprints.card');
  });

  it('returns empty string when `ui` is absent or empty', () => {
    expect(extractSelectedId('')).toBe('');
    expect(extractSelectedId('ui=')).toBe('');
    expect(extractSelectedId('ui=%20')).toBe('');
    expect(extractSelectedId('foo=bar')).toBe('');
  });

  it('rejects ids containing HTML / control chars', () => {
    expect(extractSelectedId('ui=%3Cscript%3E')).toBe('');
    expect(extractSelectedId('ui=a b')).toBe('');
    // Surrounding whitespace is trimmed off (harmless) — so a
    // trailing newline leaves 'a' behind, not ''. The real guard
    // is that an interior newline gets rejected:
    expect(extractSelectedId('ui=ab%0Acd')).toBe('');
  });

  it('caps overlong values', () => {
    const big = 'a'.repeat(201);
    expect(extractSelectedId(`ui=${big}`)).toBe('');
  });
});

describe('renderHubPreviewHtml (pure)', () => {
  it('renders a complete HTML document with the selected id in the title', () => {
    const html = renderHubPreviewHtml({ token: 'tkn', selectedId: 'weather-card' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Preview: weather-card</title>');
  });

  it('shows the no-selection hint when `selectedId` is empty', () => {
    const html = renderHubPreviewHtml({ token: 'tkn', selectedId: '' });
    expect(html).toContain('<title>Preview</title>');
    expect(html).toContain('No UI selected');
    expect(html).toContain('Pick a UI');
  });

  it('embeds the bearer token + selectedId in window.__GGUI_DEV_PREVIEW__', () => {
    const html = renderHubPreviewHtml({ token: 'secret', selectedId: 'card' });
    expect(html).toMatch(/window\.__GGUI_DEV_PREVIEW__ = \{[^<]*"token":"secret"/);
    expect(html).toContain('"selectedId":"card"');
  });

  it('embeds token:null when the server has no security policy', () => {
    const html = renderHubPreviewHtml({ token: null, selectedId: 'card' });
    expect(html).toMatch(/"token":null/);
  });

  it('HTML-escapes the selected id when echoed into the body', () => {
    const html = renderHubPreviewHtml({
      token: null,
      selectedId: '<script>alert(1)</script>',
    });
    // The raw `<script>` from the input must not appear (apart from
    // the bootstrap `<script>` tag the shell itself emits).
    const bodyMatch = /<body>([\s\S]*?)<\/body>/.exec(html);
    expect(bodyMatch).not.toBeNull();
    const body = bodyMatch![1] ?? '';
    expect(body).not.toContain('<script>alert(1)');
    expect(body).toContain('&lt;script&gt;');
  });

  it('JSON-escapes `<` in the bootstrap so a tricky id cannot break out of the script', () => {
    // extractSelectedId rejects this value in practice, but the
    // renderer must still be safe if a caller passes an already-
    // validated id that happens to contain HTML-ish characters.
    const html = renderHubPreviewHtml({
      token: null,
      selectedId: 'bad</script><img>',
    });
    const match = /<script>([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const payload = match![1] ?? '';
    expect(payload).not.toContain('</script>');
    expect(payload).toContain('\\u003c');
  });

  it('sets noindex meta so search crawlers leave the preview alone', () => {
    const html = renderHubPreviewHtml({ token: null, selectedId: '' });
    expect(html).toContain('name="robots"');
    expect(html).toContain('noindex');
  });

  it('includes compile-failure CSS so multi-error renders look clean', () => {
    const html = renderHubPreviewHtml({ token: null, selectedId: 'x' });
    // These classes are applied by the React client when the
    // preview state is `compile`. Their presence in the shell
    // CSS means the paints arrive styled without a FOUC.
    expect(html).toContain('ul.errors');
    expect(html).toContain('pre.location');
    expect(html).toContain('pre.error');
    expect(html).toContain('pre.line-text');
    expect(html).toContain('.surface');
  });

  it('loads the compiled preview bundle as a module script', () => {
    const html = renderHubPreviewHtml({ token: null, selectedId: 'card' });
    expect(html).toContain('<script type="module" src="/hub/preview.js">');
    // The bootstrap sits BEFORE the module script so the bundle can
    // read window.__GGUI_DEV_PREVIEW__ on first evaluation.
    const bootIdx = html.indexOf('__GGUI_DEV_PREVIEW__');
    const moduleIdx = html.indexOf('/hub/preview.js');
    expect(bootIdx).toBeGreaterThan(-1);
    expect(moduleIdx).toBeGreaterThan(bootIdx);
  });
});

describe('GET /hub/preview served from the dev server', () => {
  let tmp: string;
  let handle: DevServerHandle | null = null;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-hub-preview-'));
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

  it('returns 200 text/html and no Authorization is required', async () => {
    const h = await boot({ withSecurity: true });
    const res = await fetch(url(h, '/hub/preview?ui=weather-card'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    const body = await res.text();
    expect(body).toContain('<title>Preview: weather-card</title>');
    expect(body).toContain('"token":"fixed-test-token"');
    expect(body).toContain('"selectedId":"weather-card"');
  });

  it('handles the no-selection case (no `?ui=` param)', async () => {
    const h = await boot({ withSecurity: true });
    const res = await fetch(url(h, '/hub/preview'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('No UI selected');
    expect(body).toContain('"selectedId":""');
  });

  it('treats /hub/preview/ (trailing slash) identically', async () => {
    const h = await boot({ withSecurity: true });
    const res = await fetch(url(h, '/hub/preview/?ui=card'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Preview: card</title>');
  });

  it('drops hostile selectedId before echoing it', async () => {
    const h = await boot({ withSecurity: true });
    const res = await fetch(url(h, `/hub/preview?ui=${encodeURIComponent('<script>alert(1)</script>')}`));
    expect(res.status).toBe(200);
    const body = await res.text();
    // Sanitiser rejected the value → the page rendered the
    // no-selection hint, not the raw string.
    expect(body).toContain('No UI selected');
    expect(body).not.toContain('<script>alert(1)');
  });

  it('does not leak /hub/preview as a wildcard prefix', async () => {
    // /hub/preview/unknown should still fall through to 404 —
    // only the exact `/hub/preview[/]` paths are whitelisted.
    const h = await boot({ withSecurity: true });
    const res = await fetch(url(h, '/hub/preview/unknown'), {
      headers: { Authorization: 'Bearer fixed-test-token' },
    });
    expect(res.status).toBe(404);
  });

  it('embeds token:null when the server was started without security', async () => {
    const h = await boot({ withSecurity: false });
    const res = await fetch(url(h, '/hub/preview?ui=x'));
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/"token":null/);
  });
});

describe('GET /hub/preview.js served from the dev server', () => {
  let tmp: string;
  let handle: DevServerHandle | null = null;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-hub-preview-js-'));
  });

  afterEach(async () => {
    __setHubPreviewBundlePathForTest(null);
    if (handle) {
      await handle.close();
      handle = null;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  async function boot(): Promise<DevServerHandle> {
    const manifest = makeGgui('Weather Bot', 'weather');
    const registry = new LocalUiRegistry({ projectRoot: tmp, manifest });
    const security = createSecurityPolicy({ token: 'fixed-test-token', env: {} });
    const h = await startDevServer({ registry, manifest, port: 0, security });
    handle = h;
    return h;
  }

  function url(h: DevServerHandle, p: string): string {
    return `http://${h.host}:${h.port}${p}`;
  }

  it('serves the bundled client with 200 application/javascript + no bearer required', async () => {
    const bundlePath = join(tmp, 'client.js');
    await writeFile(bundlePath, 'export const marker = "hub-preview-bundle";\n');
    __setHubPreviewBundlePathForTest(bundlePath);

    const h = await boot();
    const res = await fetch(url(h, '/hub/preview.js'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/javascript/);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.text()).toContain('hub-preview-bundle');
  });

  it('returns 503 preview-bundle-missing when the build step has not run', async () => {
    // Point at a path that does not exist. The CLI will never see
    // this in practice — `pnpm build` is the install step — but the
    // fallback matters the first time someone checks out the repo.
    __setHubPreviewBundlePathForTest(join(tmp, 'does-not-exist', 'client.js'));

    const h = await boot();
    const res = await fetch(url(h, '/hub/preview.js'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('preview-bundle-missing');
    expect(body.message).toContain('pnpm --filter @ggui-ai/dev-stack build');
  });
});
