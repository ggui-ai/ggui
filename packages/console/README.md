# @ggui-ai/console

Server-served operator landing page + minimal render viewer for a
self-hosted `@ggui-ai/mcp-server` instance. Single-origin, static
bundle, Vite + React 19.

## Boundary

- **IS:** the page an operator sees when they open
  `http://localhost:<port>/` against the server they just started.
  Shows the server's name / version + the currently pending pair-code
  (if any), and — when opened at `/s/<shortCode>` — a minimal live
  view of the render bound to that short-code.
- **IS NOT:** a multi-origin hosted product dashboard, the MCP Apps
  iframe thin shell (`GGUI_RENDER_SHELL_HTML`), or any cross-origin
  control surface. No server switcher, no cross-origin anything.

## Surface

- **Landing + render viewer** — landing page at `/`,
  `POST /ggui/console/render-cookie` (third token kind), `/s/<shortCode>`
  viewer, cookie-authenticated live-channel WebSocket, scope isolation
  from `/mcp` + `/ggui/auth-check`. CSP + security-header hardening on
  every console response path; bundle stress cap at 400 KB (hard cap
  500 KB).
- **`/admin/*` operator chrome** — admin-cookie-gated sub-shell:
  status, renders, blueprints (declared + cached + variants),
  config, tools, LLM keys, connector keys, OAuth providers, clients,
  theme. `admin-login` for token paste; `/` and `/admin` both land on
  the status page.
- **`/devtools/*` debug surface** — gated by `GGUI_MODE=dev` (server
  stamps the mode into `window.__GGUI_CONSOLE__`); same admin-cookie
  gate as `/admin/*`. Surfaces: LLM trace, validator, blueprint cache,
  timeline, payloads, benchmarks.

## Usage (operator)

Minimal enable:

```ts
import { createGguiServer } from "@ggui-ai/mcp-server";

const server = createGguiServer({
  pairing: true,
  console: true,
});
await server.listen(4567);
// → http://127.0.0.1:4567/ serves the landing page.
```

With the render viewer (requires `renderChannel` + a
`shortCodeIndex`):

```ts
import { createGguiServer } from "@ggui-ai/mcp-server";
import { InMemoryShortCodeIndex } from "@ggui-ai/mcp-server-core/in-memory";

const shortCodeIndex = new InMemoryShortCodeIndex();

const server = createGguiServer({
  pairing: true,
  renderChannel: true,
  shortCodeIndex,
  console: { sessionCookie: true },
  // bootstrapSecret: process.env.GGUI_SECRET — use a deterministic
  //   secret in multi-host / production deployments.
});
await server.listen(4567);
// → http://127.0.0.1:4567/           landing page
// → http://127.0.0.1:4567/s/<code>   render viewer
```

Path override:

```ts
createGguiServer({ console: { path: "/ui" } });
// → http://127.0.0.1:4567/ui         landing page (out of root)
```

## Auth planes (distinct by design)

The console cookie is a **third token kind**, NOT a
rebadge of bootstrap/session tokens:

| Ingress          | Credential                    | Who mints it                       |
| ---------------- | ----------------------------- | ---------------------------------- |
| `/mcp`           | `Authorization: Bearer …`     | AuthAdapter / pairing              |
| `/ws` (MCP Apps) | `?bootstrap=<token>`          | `ggui_render` bootstrap mint       |
| `/ws` (console)  | `ggui_console_session` cookie | `POST /ggui/console/render-cookie` |

The cookie authenticates **only** the live-channel `/ws` upgrade. It is
invisible to `/mcp`, `/pair`, `/threads`, `/ggui/auth-check` — the
tests in `@ggui-ai/mcp-server` pin that boundary. See
`console-auth.ts` for the isolation invariant.

## Security posture

Every console response (landing HTML, static assets, SPA
fallback, cookie endpoint, info endpoint, 503 distDir-missing
fallback) carries:

- `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Cross-Origin-Opener-Policy: same-origin`

Header set is surgical — `/mcp`, `/pair`, `/threads`, `/ggui/health`,
`/ggui/auth-check` remain headerless (those are JSON API contracts,
not browser-rendered HTML).

`'unsafe-inline'` is scoped to `style-src` only (React `style={...}`
props emit inline attribute styles). Scripts use only `'self'` — no
inline scripts, no `eval`.

HSTS is deliberately NOT set — operators own TLS + HSTS at their
reverse proxy. The OSS server stays HTTP-friendly for local dev.

## Bundle budget

Two thresholds, both fail-closed in `scripts/check-bundle-size.ts`
(runs after `vite build`):

- **Stress cap — 400 KB gzipped.** Crossing this forces a
  conversation before the absolute ceiling fires.
- **Hard cap — 500 KB gzipped.** Absolute ceiling.

Current bundle: ~161 KB gzipped (40% of stress, 32% of hard).
