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
 * Commits 2–5 into the full renderer (RCR port + PR port + render-item
 * mount + mcp-apps iframe host). Heavy deps (React + ReactDOM +
 * `@ggui-ai/wire` + `@ggui-ai/design` + `@ggui-ai/preview-a2ui`) are
 * declared in package.json and bundle inline — `external: []` is a
 * hard constraint because the thin shell's `<script type="module">`
 * does not run a bundler at load time.
 *
 * Builds in well under a second at C7a; C7b bundle grows toward
 * ~140–150 KB gzipped per plan §C7a:47. Minification stays off
 * through C7b; C8 re-measures + re-locks budget with `measured + 20%`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname);

const entry = join(pkgRoot, 'src/runtime.ts');
const outfile = join(pkgRoot, 'dist/iframe-runtime.js');
// Build metadata consumed by `scripts/check-bundle-size.ts`. It needs the
// per-input module list to detect the same npm package bundled twice from
// two different `node_modules/` paths — the failure mode that silently
// added 85 KB gz (two copies of zod v4) and could only be seen as an
// unexplained budget overrun. Not published: `dist/` is gitignored and
// package.json#files ships only the bundle + types.
const metafile = join(pkgRoot, 'dist/iframe-runtime.meta.json');

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
  metafile: true,
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
    // Bare package version (no git sha) — advertised to hosts via the
    // `ggui:renderer-ready` notification and the `ui/initialize`
    // appInfo. Derived from package.json so the bundle can never
    // advertise a version that drifts from the published package.
    __GGUI_RUNTIME_VERSION__: JSON.stringify(pkgJson.version),
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

await writeFile(metafile, JSON.stringify(result.metafile), 'utf-8');

console.log(`[iframe-runtime:esbuild] wrote ${outfile}`);

// ---------------------------------------------------------------------------
// Static shim modules (ggui#522 slice 2) — dist/shims/<name>.js
//
// The `asset-url` delivery mode serves the import-rewrite shims as
// fetchable files instead of `data:` URLs, so strict-CSP host pages
// (script-src limited to the asset origin) can load generated modules.
// The bodies come from the SAME builders the `data-url` mode uses
// (`@ggui-ai/design/rendering::buildStaticShimModules`), emitted here so
// the files ship in the same dist as the runtime bundle: the mcp-server
// keys the shim URL directory on the runtime bundle's content hash, and
// any shim-affecting change (an export-allowlist edit in the design
// package) also changes the bundle bytes — one hash versions both.
//
// The gadgets shim's export surface is enumerated from the REAL
// `@ggui-ai/gadgets` dist at build time — drift-immune by construction,
// same spirit as verify-shim-allowlists.test.ts. A failure here fails
// the build loudly; a missing name in the shim would otherwise surface
// as a SyntaxError blanking the iframe at runtime.
// ---------------------------------------------------------------------------
{
  const { buildStaticShimModules } = await import('@ggui-ai/design/rendering');
  const gadgets = await import('@ggui-ai/gadgets');
  const gadgetExports = Object.keys(gadgets).filter((k) => k !== 'default');
  if (gadgetExports.length === 0) {
    console.error('[iframe-runtime:shims] @ggui-ai/gadgets enumerated ZERO exports — refusing to emit an empty gadgets shim');
    process.exit(1);
  }
  const shims = buildStaticShimModules({ gadgetExports });
  const shimsDir = join(pkgRoot, 'dist/shims');
  await mkdir(shimsDir, { recursive: true });
  for (const [name, source] of Object.entries(shims)) {
    await writeFile(join(shimsDir, `${name}.js`), source, 'utf-8');
  }
  console.log(
    `[iframe-runtime:shims] wrote ${Object.keys(shims).length} shim modules to dist/shims (gadgets surface: ${gadgetExports.length} exports)`,
  );
}
