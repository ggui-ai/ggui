#!/usr/bin/env node
/**
 * Bundle the hub preview client (React app) into a single ESM asset
 * that the dev server serves at `/hub/preview.js`.
 *
 * Source:  packages/dev-stack/hub-preview-client/main.tsx
 * Output:  packages/dev-stack/dist/hub-preview/client.js
 *
 * Everything (React, ReactDOM, @ggui-ai/react, @ggui-ai/design,
 * @ggui-ai/wire) is bundled in — the iframe is a standalone page
 * with no import map, and the user's compiled UI expects these
 * modules to be resolvable through the renderer's data-URL shim
 * (which DynamicComponent sets up against `globalThis.__ggui__`,
 * populated by @ggui-ai/react at render time).
 *
 * Run via `pnpm build` (added to the package.json build script).
 * Runs in ~200-500ms locally.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const entry = join(pkgRoot, 'hub-preview-client/main.tsx');
const outfile = join(pkgRoot, 'dist/hub-preview/client.js');

await mkdir(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: false,
  sourcemap: false,
  // The preview iframe is a standalone page — nothing is external.
  // `@ggui-ai/react` pulls in react, react-dom, and (transitively)
  // the design system; bundling everything keeps the delivery shape
  // a single GET, no import map, no surprises.
  jsx: 'automatic',
  jsxImportSource: 'react',
  absWorkingDir: pkgRoot,
  logLevel: 'info',
  // Production-ish inlining without minification so stack traces
  // land on meaningful symbols while we stabilise the feature.
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  loader: {
    '.tsx': 'tsx',
    '.ts': 'ts',
  },
});

if (result.errors.length > 0) {
  // esbuild's error objects already print via logLevel:'info'; throw
  // so the build script exits non-zero and `pnpm build` propagates
  // the failure to callers.
  throw new Error(`hub preview bundle failed (${result.errors.length} error(s))`);
}

const bytes = (await import('node:fs/promises')).stat(outfile).then((s) => s.size);
// eslint-disable-next-line no-console
console.log(`[dev-stack] hub preview bundle: ${outfile} (${await bytes} bytes)`);
