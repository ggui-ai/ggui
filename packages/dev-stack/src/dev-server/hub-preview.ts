/**
 * Local dev hub — preview iframe shell.
 *
 * The hub at `/hub` is a code-first observability dashboard (vanilla
 * JS, no framework). Rendering a React component there would drag the
 * whole renderer stack into the hub's surface and violate the charter.
 * Instead, the hub embeds `<iframe src="/hub/preview?ui=<id>">` and
 * this module owns the iframe's HTML shell.
 *
 * Shape (locked 2026-04-18):
 *
 *   - One self-contained HTML document per iframe. Dep-free at this
 *     layer — the React-based renderer arrives in the next commit and
 *     mounts against a root node this shell already provides.
 *   - Public path (bearer-exempt) for the same reason `/hub` is
 *     public: a browser loads the HTML before it has the token. The
 *     origin allowlist in `auth.ts` still blocks cross-origin reads,
 *     and the shell embeds the bearer so same-origin XHRs carry it.
 *   - Bootstrap globals sit at `window.__GGUI_DEV_PREVIEW__` (distinct
 *     from the hub's `window.__GGUI_DEV__`) so the two pages never
 *     accidentally alias each other's state.
 *   - `noindex` / `no-store` / `X-Frame-Options: SAMEORIGIN` — hub
 *     loads this iframe from the same origin; any other framing is
 *     rejected.
 *
 * Invariants for this commit:
 *
 *   - No component rendering yet. The shell shows a loading placeholder
 *     and the selected UI id. The actual DynamicComponent-based render
 *     lands as the next commit on top of this plumbing.
 *   - Selected id is validated defensively (non-empty, no control
 *     chars, no slashes) so a crafted URL can't inject HTML into the
 *     shell even though the server escapes it.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Context the preview shell needs at boot. */
export interface HubPreviewShellContext {
  /** Bearer token the preview's own JS sends on data XHRs. `null`
   * when the server was started without a security policy (tests). */
  readonly token: string | null;
  /** Selected UI id from the `?ui=` query param. Empty string for
   * the no-selection state — the shell renders a tiny "pick a UI"
   * hint rather than a blank frame. */
  readonly selectedId: string;
}

/**
 * Build the preview iframe's HTML document. Pure function so tests
 * can exercise the rendered shape without binding a port.
 */
export function renderHubPreviewHtml(ctx: HubPreviewShellContext): string {
  const idForDisplay = escapeHtml(ctx.selectedId);
  const bootstrap = JSON.stringify({
    token: ctx.token,
    selectedId: ctx.selectedId,
  }).replace(/</g, '\\u003c');

  const title = ctx.selectedId.length > 0
    ? `Preview: ${idForDisplay}`
    : 'Preview';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<style>${PREVIEW_CSS}</style>
</head>
<body>
<main id="preview-root">
  <div class="frame" data-state="loading">
    <div class="pane">
      ${ctx.selectedId.length > 0
        ? `<div class="meta">Preview of <code>${idForDisplay}</code></div>
           <div class="status">Loading renderer…</div>`
        : `<div class="meta">No UI selected</div>
           <div class="status">Pick a UI from the Discovered UIs panel to preview it here.</div>`}
    </div>
  </div>
</main>
<script>window.__GGUI_DEV_PREVIEW__ = ${bootstrap};</script>
<script type="module" src="/hub/preview.js"></script>
</body>
</html>
`;
}

/**
 * Read the `?ui=` query param and sanitise it. A UI id coming from
 * the URL bar is untrusted; the shell already escapes when it renders,
 * but stripping obviously-hostile characters keeps the accepted
 * surface tight. IDs produced by the registry are plain kebab/dot
 * strings, so any control char or slash is a sign of tampering.
 */
export function extractSelectedId(rawQuery: string): string {
  const params = new URLSearchParams(rawQuery);
  const value = (params.get('ui') ?? '').trim();
  // Reject anything that isn't plain identifier-ish text. Registry ids
  // are kebab/snake with dots at most; this keeps the accepted shape
  // narrow without needing to cross-check against the live registry
  // (the renderer's bundle fetch will 404 honestly anyway).
  if (value.length === 0) return '';
  if (value.length > 200) return '';
  if (!/^[a-zA-Z0-9._\-:@/]+$/.test(value)) return '';
  return value;
}

/**
 * Write the preview shell to `res` with no-cache headers.
 *
 * `X-Frame-Options: SAMEORIGIN` — the hub is the only expected
 * embedder. A different origin trying to frame this page is blocked
 * so the iframe's bearer-embedded bootstrap can't leak to a hostile
 * parent.
 */
export function serveHubPreviewShell(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HubPreviewShellContext,
): void {
  const html = renderHubPreviewHtml(ctx);
  const body = Buffer.from(html, 'utf-8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.byteLength.toString(),
    'cache-control': 'no-store',
    'x-frame-options': 'SAMEORIGIN',
  });
  res.end(body);
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Absolute path to the compiled preview-client bundle. The bundle is
 * produced by `scripts/build-hub-preview.mjs` during `pnpm build` and
 * lives at `dist/hub-preview/client.js`.
 *
 * Resolution is relative to this module's compiled location in `dist/`
 * via `import.meta.url`:
 *
 *   dist/dev-server/hub-preview.js
 *        ↓ dirname
 *   dist/dev-server
 *        ↓ ../hub-preview/client.js
 *   dist/hub-preview/client.js
 *
 * Computed once at module load and cached. Tests override via
 * `__setHubPreviewBundlePathForTest` (export below) so they can
 * assert serving logic without a real build being in place.
 */
let bundlePathOverride: string | null = null;

export function resolveHubPreviewBundlePath(): string {
  if (bundlePathOverride !== null) return bundlePathOverride;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, '..', 'hub-preview', 'client.js');
}

/** Test seam — set an explicit bundle path (usually a temp file) so
 * the HTTP layer can be exercised without running the esbuild step. */
export function __setHubPreviewBundlePathForTest(path: string | null): void {
  bundlePathOverride = path;
}

/**
 * Serve the compiled preview-client bundle at `/hub/preview.js`.
 *
 * The iframe's `<script type="module" src="/hub/preview.js">` tag
 * cannot attach an `Authorization` header — browsers don't allow it
 * on a plain script load. Matching the HTML shell's approach, this
 * route is public; the existing origin allowlist blocks cross-origin
 * reads, and the bundle itself is harmless code (reads from the
 * iframe's same-origin `window.__GGUI_DEV_PREVIEW__`).
 *
 * On first boot + before `pnpm build` has run, the file may not
 * exist. We return a 503 with an actionable message rather than a
 * bare stack trace so the developer knows the build step is
 * missing — the HTML shell in the iframe will paint a "Loading
 * renderer…" placeholder and the console error will point to this
 * response.
 */
export async function serveHubPreviewBundle(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = resolveHubPreviewBundlePath();
  try {
    await stat(path);
  } catch {
    const message =
      'hub preview bundle is missing. Run `pnpm --filter @ggui-ai/dev-stack build` to produce it.';
    const body = JSON.stringify({ error: 'preview-bundle-missing', message });
    res.writeHead(503, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body).toString(),
      'cache-control': 'no-store',
    });
    res.end(body);
    return;
  }

  const buffer = await readFile(path);
  res.writeHead(200, {
    'content-type': 'application/javascript; charset=utf-8',
    'content-length': buffer.byteLength.toString(),
    'cache-control': 'no-store',
  });
  res.end(buffer);
}

/**
 * Preview CSS. Matches the hub's dark-terminal palette so the iframe
 * blends seamlessly with the surrounding panel. Kept minimal — once
 * the renderer mounts, the compiled UI brings its own theme.
 */
const PREVIEW_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #0a0a0a; color: #e7e7e7;
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
body { min-height: 100vh; display: flex; }
main { flex: 1; display: flex; }
.frame { flex: 1; display: flex; align-items: center; justify-content: center;
  padding: 24px; }
.pane { max-width: 480px; display: flex; flex-direction: column; gap: 10px;
  text-align: center; }
.meta { font-size: 12px; color: #8a8a8a; text-transform: uppercase;
  letter-spacing: 0.06em; }
.meta code { color: #7cb2e8; font-family: inherit; text-transform: none;
  letter-spacing: 0; }
.status { color: #b8b8b8; font-size: 13px; }
.status .dim { color: #666; }
.tried { background: #141414; color: #8a8a8a; padding: 8px 12px;
  border-radius: 3px; font-size: 11px; text-align: left;
  white-space: pre-wrap; word-break: break-all; margin: 8px 0 0; }
ul.errors { list-style: none; margin: 0; padding: 0; text-align: left; }
ul.errors li { padding: 6px 0; border-top: 1px solid #181818; }
ul.errors li:first-child { border-top: none; }
pre.location { margin: 0; color: #7cb2e8; font-size: 11px;
  font-family: inherit; text-align: left; }
pre.error { margin: 2px 0 0; color: #e57373; font-size: 12px;
  font-family: inherit; white-space: pre-wrap; text-align: left; }
pre.line-text { margin: 4px 0 0; background: #141414; color: #ccc;
  padding: 4px 8px; border-radius: 3px; font-size: 11px;
  font-family: inherit; text-align: left; overflow-x: auto; }
.surface { flex: 1; display: flex; align-items: stretch; padding: 16px; }
.surface > div { flex: 1; min-width: 0; }
`;
