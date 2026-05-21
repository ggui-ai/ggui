#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const entry = join(pkgRoot, 'src/fixture-runtime.ts');
const outfile = join(pkgRoot, 'fixture/fixture-runtime.js');

await mkdir(dirname(outfile), { recursive: true });

// pnpm workspace hoisting often exposes React at two resolution paths
// (`node_modules/react` and `node_modules/.pnpm/react@.../node_modules/react`).
// Without an alias esbuild treats them as separate modules and bundles
// BOTH — one becomes Wire's React (the one createContext + WireProvider
// run against), the other becomes the render-fiber React (the one
// ReactDOMClient and the test component's hooks run against). When the
// hook reads `ReactSharedInternals.H` it asks the wrong copy and gets
// null → "Cannot read properties of null (reading 'useContext')".
//
// Pin every react / react-dom / jsx-runtime specifier to one canonical
// path so esbuild dedupes.
const req = createRequire(import.meta.url);
const alias = {
  react: req.resolve('react'),
  'react-dom': req.resolve('react-dom'),
  'react-dom/client': req.resolve('react-dom/client'),
  'react/jsx-runtime': req.resolve('react/jsx-runtime'),
  'react/jsx-dev-runtime': req.resolve('react/jsx-dev-runtime'),
};

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  external: [],
  alias,
  sourcemap: false,
  minify: false,
  absWorkingDir: pkgRoot,
  logLevel: 'warning',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
  },
  jsx: 'automatic',
});

if (result.errors.length > 0) {
  for (const err of result.errors) {
    console.error('[ui-visual-tester:esbuild]', err);
  }
  process.exit(1);
}

console.log(`[ui-visual-tester:esbuild] wrote ${outfile}`);
