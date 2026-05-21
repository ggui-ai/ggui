#!/usr/bin/env node
/**
 * Build the `@ggui-ai/iframe-runtime` iframe runtime into a single
 * self-contained ESM bundle at `dist/iframe-runtime.js`.
 *
 * The bundle is what the thin-shell HTML loads via
 * `<script type="module" src="/_ggui/iframe-runtime.js">`. It MUST
 * run inside the iframe with zero external imports at runtime —
 * every dependency the runtime needs is bundled in.
 *
 * C7b scope: WS lifecycle + bootstrap parse + placeholder render +
 * globals/__ggui__ registry + adapter injection, growing across
 * Commits 2–5 into full triad (RCR port + PR port + stack-item
 * renderer + mcp-apps iframe host). Heavy deps (React + ReactDOM +
 * `@ggui-ai/wire` + `@ggui-ai/design` + `@ggui-ai/preview-a2ui`) are
 * declared in package.json and bundle inline — `external: []` is a
 * hard constraint because the thin shell's `<script type="module">`
 * does not run a bundler at load time.
 *
 * Builds in well under a second at C7a; C7b bundle grows toward
 * ~140–150 KB gzipped per plan §C7a:47. Minification stays off
 * through C7b; C8 re-measures + re-locks budget with `measured + 20%`.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname);

const entry = join(pkgRoot, 'src/runtime.ts');
const outfile = join(pkgRoot, 'dist/iframe-runtime.js');

await mkdir(dirname(outfile), { recursive: true });

// Build-id stamp injected into the bundle via esbuild `define`. Used
// by user-visible debug surfaces (no-credentials card badge) so we
// can tell at a glance whether the iframe is running the latest
// build or a stale-cached one. Format: `<pkg-version>+<git-sha>` or
// `<pkg-version>+nogit` when not in a git tree.
const pkgJson = JSON.parse(
  await readFile(join(pkgRoot, 'package.json'), 'utf-8'),
);
let gitSha = 'nogit';
try {
  gitSha = execSync('git rev-parse --short=8 HEAD', {
    cwd: pkgRoot,
    encoding: 'utf-8',
  }).trim();
} catch {
  // Not a git checkout (npm tarball install, container build without
  // .git); fall back to the package version alone. The bundle still
  // surfaces a useful identifier — just not the commit-precise one.
}
const buildId = `${pkgJson.version}+${gitSha}`;

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  // Protocol types are type-only — erased at compile time. The bundle
  // must NOT pull `@ggui-ai/protocol` runtime code in. Marking it as
  // external would defeat the self-contained-bundle invariant the
  // thin-shell HTML relies on; instead, the renderer source uses
  // `import type` exclusively for protocol imports so esbuild emits no
  // runtime requires for it.
  external: [],
  // Sourcemaps disabled in the published bundle — operators shouldn't
  // ship a 2x-sized artifact. Re-enable locally with the
  // `RENDERER_SOURCEMAP=1` env var when debugging boot regressions.
  sourcemap: process.env.RENDERER_SOURCEMAP === '1',
  // Minification enabled from C7b Commit 4 — the bundle grew to ~265
  // KB gz unminified (React + design + wire + preview-a2ui + protocol
  // transitives), exceeding the plan §C7a:47 ~140–150 KB gz ceiling.
  // Minification brings us into budget (~190 KB gz measured). The
  // earlier C7a posture (minify off for readable artifacts) no
  // longer applies — C7b IS the shape-stabilization pass, and from
  // here readability serves no diagnostic that the sourcemap env var
  // doesn't cover.
  minify: true,
  absWorkingDir: pkgRoot,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
    __GGUI_RUNTIME_BUILD_ID__: JSON.stringify(buildId),
  },
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
  },
  jsx: 'automatic',
});

if (result.errors.length > 0) {
  for (const err of result.errors) {
    console.error('[iframe-runtime:esbuild]', err);
  }
  process.exit(1);
}

console.log(`[iframe-runtime:esbuild] wrote ${outfile}`);
