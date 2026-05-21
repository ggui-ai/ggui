/**
 * Server-side export for `@ggui-ai/console`.
 *
 * This module is imported by `@ggui-ai/mcp-server` to locate the built
 * SPA bundle on disk. It contains **no browser code** — never import
 * React, DOM types, or anything from `src/App.tsx` here.
 *
 * Rationale for the `./server` export split:
 *
 *   - The SPA lives in `dist/` (Vite output: HTML + JS + CSS).
 *   - The server helper ships from `dist-server/server.js` (tsc output).
 *   - mcp-server only needs a path string (`CONSOLE_DIST_DIR`) +
 *     a type. Keeping those apart from the SPA bundle lets consumers
 *     import `@ggui-ai/console/server` without pulling the whole
 *     Vite output through their module graph.
 *
 * If you add more server-side helpers (e.g. CSP-policy factories),
 * land them here — NOT in `src/App.tsx`.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Resolve the directory where this compiled module ends up at runtime.
 * `dist-server/server.js` is the canonical location (see
 * `tsconfig.server.json#compilerOptions.outDir`); `dist/` is its sibling.
 *
 * Computed via `import.meta.url` so the resolver is independent of
 * CWD — consumers mount this server inside CLIs, Lambdas, and tests
 * with arbitrary working directories.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute filesystem path to the built SPA's `dist/` directory.
 *
 *   - Contents: `index.html`, `assets/*`.
 *   - Written by `vite build` (`pnpm --filter @ggui-ai/console build:spa`).
 *   - Consumed by `express.static(CONSOLE_DIST_DIR)` inside
 *     `@ggui-ai/mcp-server`'s `console: true` branch.
 *
 * If the directory does not exist at runtime, the console mount
 * should surface a clear "run `pnpm build`" error rather than silently
 * 404ing — that decision lives in mcp-server, not here.
 */
export const CONSOLE_DIST_DIR: string = path.resolve(here, '..', 'dist');
