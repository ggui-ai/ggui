/**
 * Security headers for console responses.
 *
 * Scope: applied ONLY to surfaces the console SPA itself owns —
 * the `/ggui/console/*` API routes + the static mount + its SPA
 * fallback. Deliberately NOT applied to `/mcp`, `/pair`, `/threads`,
 * `/ggui/auth-check`, `/ggui/health` — those are API contract that
 * browsers don't interpret as HTML, and bleeding CSP onto them adds
 * noise without security value.
 *
 * The policy is the NARROWEST that keeps the current viewer working.
 * Lifting any directive carries a real product decision; do NOT widen
 * casually.
 *
 *   - `default-src 'none'` — deny by default, opt into every source.
 *   - `script-src 'self' blob: data: <ggui-shell-hash>` — Vite emits
 *     `<script type="module" src="/assets/...">` with no inline scripts
 *     or eval (`'self'` covers that). `blob:` covers the outer dynamic
 *     `import(blob:URL)` call in `ReactComponentRenderer`'s
 *     `loadModule`: the renderer wraps compiled ESM in a Blob,
 *     `URL.createObjectURL`s it, and dynamically imports the resulting
 *     blob URL. `data:` covers the INNER bare-specifier rewrite path
 *     in `@ggui-ai/design/rendering/rewrite-imports.ts`: `import React
 *     from 'react'` inside the generated module becomes `import
 *     React from 'data:text/javascript,…shim…'`, and the browser
 *     imports that `data:` URL as a script subresource. Stripping
 *     either directive silently breaks the renderer — jsdom tests
 *     can't detect this because jsdom doesn't enforce CSP; the
 *     `live-generation.spec.ts` browser proof is what catches it.
 *     Both sources are produced by code running in THIS
 *     origin; neither permits third-party script loading, and
 *     neither enables `eval` / `new Function` (that needs
 *     `'unsafe-eval'`, which is explicitly absent).
 *
 *     `<ggui-shell-hash>` is `GGUI_RENDER_SHELL_SCRIPT_HASH` from
 *     `mcp-apps-outbound.ts` — the sha-256 source-expression
 *     authorising the inline `<script>` block of the production thin
 *     shell `<McpAppIframe>` mounts via `srcdoc`. `srcdoc` iframes
 *     inherit the parent's CSP, so without the hash the shell's
 *     bootstrap script is blocked at parse time and the renderer is
 *     never fetched (lifecycle stuck at `mounting`, specs pinning
 *     `code-ready` time out). Hash CSP is the right shape because the
 *     shell body is static + known at build time; binding the policy
 *     to the exact bytes is narrower than `'unsafe-inline'` and
 *     narrower than a runtime nonce. Drift between this CSP and the
 *     actual script body is caught by `mcp-apps-outbound.test.ts` —
 *     edit the script, regenerate the hash.
 *
 *     `'unsafe-inline'` is still NEVER allowed for scripts; the hash
 *     mechanism preserves the strict-no-inline posture for everything
 *     except the one known shell body whose bytes are pinned.
 *   - `style-src 'self' 'unsafe-inline'` — React `style={...}` props
 *     produce inline `style=""` attributes. `'unsafe-inline'` is
 *     required for those attribute-level styles; it does NOT open the
 *     door to inline `<script>` or `<style>` blocks (different CSP
 *     directive). Scoped, not dangerous.
 *   - `connect-src 'self'` — covers both same-origin `fetch()` to
 *     `/ggui/console/session-cookie` and the `new WebSocket('/ws')`
 *     upgrade. CSP Level 3 treats `'self'` as matching the document's
 *     origin across http/https/ws/wss, which is exactly the scope.
 *   - `img-src 'self' data:` — no images in the minimal viewer today,
 *     but data: URIs are a common future need (inline SVG, favicons).
 *     `'self'` alone would reject a minor future surface; adding data:
 *     now avoids a churn commit later.
 *   - `font-src 'self'` — no custom fonts in-tree, but a future design
 *     pass likely adds one. `'self'` matches that future without
 *     permissively allowing third-party font CDNs.
 *   - `frame-ancestors 'none'` — the console is NOT a frame target.
 *     The MCP Apps iframe shell is the framed surface (lives at a
 *     different URL with its own CSP); embedding THIS page inside
 *     another document would always be a clickjacking concern. Pairs
 *     with `X-Frame-Options: DENY` for legacy-browser coverage.
 *   - `base-uri 'none'` — no `<base>` tag in `index.html`; deny
 *     injection.
 *   - `form-action 'self'` — if a future slice adds a form, restrict
 *     submissions to same origin. Today there are no forms.
 *
 * What's deliberately NOT here:
 *
 *   - `upgrade-insecure-requests` — operators run console on plain
 *     HTTP during local dev; forcing HTTPS would break that. TLS is
 *     the operator's choice via reverse proxy.
 *   - `report-uri` / `report-to` — no CSP telemetry ingestion today.
 *     A future hardening slice can add one; keeping this off avoids
 *     tying the OSS server to a specific reporting endpoint.
 *   - `Strict-Transport-Security` — same reasoning: operator owns HSTS
 *     via their reverse proxy / load balancer. The OSS server must
 *     stay HTTP-friendly for dev and self-hosted loopback.
 *
 * Header shape (in the order `setHeader` applies):
 *
 *   Content-Security-Policy: <policy>
 *   X-Content-Type-Options: nosniff
 *   X-Frame-Options: DENY
 *   Referrer-Policy: strict-origin-when-cross-origin
 *   Cross-Origin-Opener-Policy: same-origin
 */
import type { Response } from 'express';
import type { ServerResponse } from 'node:http';
import { GGUI_RENDER_SHELL_SCRIPT_HASH } from './mcp-apps-outbound.js';

/**
 * The CSP directive string. Exported so tests can assert against the
 * exact shape without hard-coding the directive order inside the test
 * file. Change this string and a focused header test catches the
 * regression.
 */
export const DEVTOOL_CSP: string = [
  "default-src 'none'",
  `script-src 'self' blob: data: ${GGUI_RENDER_SHELL_SCRIPT_HASH}`,
  // Google Fonts CDN allowlisted for the brand-kit Inter + Geist Mono
  // pair used by the public welcome page (`/`). The same allowlist
  // applies to every console-served HTML — every page may opt to load
  // these fonts; pages that don't reference them pay zero cost.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/**
 * Other security headers applied alongside CSP. Split from `DEVTOOL_CSP`
 * so tests can enumerate them separately. Keep this list small +
 * well-justified — every header is a compat risk on the operator's
 * browser matrix.
 */
export const DEVTOOL_SECURITY_HEADERS: ReadonlyArray<
  readonly [string, string]
> = [
  ['Content-Security-Policy', DEVTOOL_CSP],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
];

/**
 * Apply the console security header set to a response. Pure
 * side-effect on `res`; returns `void`. Safe to call multiple times on
 * the same response — `setHeader` overwrites.
 *
 * Accepts both Express `Response` and raw Node `ServerResponse` so the
 * `express.static` `setHeaders(res, path, stat)` callback (which passes
 * `ServerResponse`) can reuse the same helper.
 */
export function applyDevtoolSecurityHeaders(
  res: Response | ServerResponse,
): void {
  for (const [name, value] of DEVTOOL_SECURITY_HEADERS) {
    res.setHeader(name, value);
  }
}
