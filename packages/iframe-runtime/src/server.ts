/**
 * Server-side export for `@ggui-ai/iframe-runtime`.
 *
 * This module is imported by `@ggui-ai/mcp-server` to locate the built
 * iframe-runtime bundle on disk — exposed via an `express.static`-style
 * file handler at `/_ggui/iframe-runtime.js`. It contains **no browser
 * code** — never import React, DOM types, or anything from
 * `src/runtime.ts` here.
 *
 * Rationale for the `./server` export split mirrors `@ggui-ai/console`:
 *
 *   - The iframe runtime bundle lives in `dist/iframe-runtime.js`
 *     (esbuild output: single self-contained ESM module).
 *   - The server helper ships from `dist/server.js` (tsc output).
 *   - mcp-server only needs a path string
 *     ({@link RUNTIME_BUNDLE_FILE}) plus a type. Keeping those
 *     apart from the iframe runtime lets consumers import
 *     `@ggui-ai/iframe-runtime/server` without pulling React / ReactDOM /
 *     the full browser graph through their module graph.
 *
 * If you add more server-side helpers (e.g. CSP directives, SRI hash
 * pre-computation), land them here — NOT in `src/runtime.ts` or
 * `src/index.ts`.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Resolve the directory where this compiled module ends up at runtime.
 * `dist/server.js` is the canonical location (tsc's `outDir`); the
 * bundle (`dist/iframe-runtime.js`) is a sibling written by esbuild.
 *
 * Computed via `import.meta.url` so the resolver is independent of
 * CWD — consumers mount this server inside CLIs, Lambdas, and tests
 * with arbitrary working directories.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute filesystem path to the built iframe-runtime bundle
 * (`dist/iframe-runtime.js`).
 *
 *   - Contents: single self-contained ESM module — React + ReactDOM +
 *     `@ggui-ai/wire` + `@ggui-ai/design` + `@ggui-ai/preview-a2ui` +
 *     protocol zod transitives all bundled in.
 *   - Written by `esbuild.config.mjs`
 *     (`pnpm --filter @ggui-ai/iframe-runtime build`).
 *   - Served by `@ggui-ai/mcp-server` at `/_ggui/iframe-runtime.js`
 *     under the `runtime: true` config branch.
 *
 * If the file does not exist at runtime (operator forgot to run
 * `pnpm build`), the mcp-server's static route should surface a
 * clear "run `pnpm build`" 503 rather than silently 404ing — that
 * decision lives in mcp-server, not here.
 */
export const RUNTIME_BUNDLE_FILE: string = path.resolve(
  here,
  'iframe-runtime.js',
);

/**
 * The same path exposed as a directory for
 * `express.static(RUNTIME_DIST_DIR)` — when the mcp-server mount
 * prefers the static-middleware shape over explicit `sendFile`.
 * Either approach works; both point at the same bundle file.
 */
export const RUNTIME_DIST_DIR: string = path.dirname(RUNTIME_BUNDLE_FILE);

/**
 * The default same-origin URL under which the mcp-server publishes
 * the bundle. Canonical string so producers (server config) and
 * consumers (shell HTML) agree on one spelling.
 *
 * Operators who serve the bundle from a different origin (CDN,
 * proxy) override this by setting the MCP server's `runtime.path`
 * config — the shell always reads the URL from
 * `bootstrap.runtimeUrl`, never hardcodes it.
 */
export const RUNTIME_BUNDLE_URL_PATH = '/_ggui/iframe-runtime.js' as const;
