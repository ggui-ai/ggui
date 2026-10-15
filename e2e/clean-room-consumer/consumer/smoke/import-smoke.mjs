#!/usr/bin/env node
/**
 * Clean-room import smoke.
 *
 * Runs INSIDE the consumer project, whose node_modules came entirely
 * from Verdaccio. For every @ggui-ai/* dependency:
 *
 *   1. installed?   — node_modules/<name>/package.json exists. Proves
 *                     npm fetched + extracted the tarball and resolved
 *                     its full declared dependency tree.
 *   2. entry loads? — for packages that expose a `.` entry point, a
 *                     dynamic `import()` of the bare specifier. This is
 *                     ESM resolution (the `import`/`node`/`default`
 *                     conditions) — the @ggui-ai/* packages are
 *                     ESM-only (`"type": "module"`, `exports["."]`
 *                     declares only the `import` condition), so a CJS
 *                     `require.resolve` would wrongly reject them.
 *
 * Packages with no `.` entry (bin-only CLIs, built apps, file-asset
 * corpora) are verified installed-only — they expose nothing to
 * `import` by design.
 *
 * A package that declares `react-native` as a peer is a React Native
 * host helper. Plain Node cannot run React Native itself (its source is
 * Flow, not JavaScript), so that package's `.` entry is resolved, never
 * loaded. A resolve still fails a missing or mis-pointed entry. Whether
 * a React Native app can bundle the package is a separate question,
 * answered by bundling it with Metro.
 *
 * A DOM-only package may legitimately throw in plain Node
 * (`window is not defined`). Those are reported as warnings, not gate
 * failures — real runtime exercise of browser packages is the
 * Playwright e2e lane (see ../../README.md).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const consumerRoot = dirname(here);
const nodeModules = join(consumerRoot, 'node_modules');

const pkgJson = JSON.parse(readFileSync(join(consumerRoot, 'package.json'), 'utf8'));
const names = Object.keys(pkgJson.dependencies ?? {})
  .filter((n) => n.startsWith('@ggui-ai/'))
  .sort();

/** Does this package expose an importable `.` entry point? */
function hasDotEntry(meta) {
  const ex = meta.exports;
  if (typeof ex === 'string') return true;
  if (ex && typeof ex === 'object') return '.' in ex;
  // No `exports` map — fall back to the classic main/module fields.
  return Boolean(meta.main || meta.module);
}

// Error signature that means "fine for its real target, just not plain
// Node": a browser global.
const SOFT = [
  /\bis not defined\b/, // window / document / self / navigator
];

let hardFail = 0;
let softWarn = 0;

for (const name of names) {
  const installedManifest = join(nodeModules, name, 'package.json');
  if (!existsSync(installedManifest)) {
    hardFail++;
    console.error(`  FAIL  ${name}  — not installed (no node_modules entry)`);
    continue;
  }
  const meta = JSON.parse(readFileSync(installedManifest, 'utf8'));

  if (!hasDotEntry(meta)) {
    console.log(`  ok    ${name}  — installed (no '.' entry: bin / app / asset, by design)`);
    continue;
  }

  if (meta.peerDependencies && 'react-native' in meta.peerDependencies) {
    let entry;
    try {
      entry = fileURLToPath(import.meta.resolve(name));
    } catch (err) {
      hardFail++;
      console.error(`  FAIL  ${name}  — '.' entry does not resolve: ${String(err && err.message)}`);
      continue;
    }
    if (!existsSync(entry)) {
      hardFail++;
      console.error(`  FAIL  ${name}  — '.' entry resolves to a missing file: ${entry}`);
      continue;
    }
    console.log(`  ok    ${name}  — React Native host helper: '.' entry resolves, not loaded in plain Node`);
    continue;
  }

  try {
    await import(name);
    console.log(`  ok    ${name}`);
  } catch (err) {
    const msg = String(err && err.message);
    if (SOFT.some((re) => re.test(msg))) {
      softWarn++;
      console.warn(`  warn  ${name}  — '.' entry not loadable in plain Node: ${msg}`);
    } else {
      hardFail++;
      console.error(`  FAIL  ${name}  — import() of '.' entry threw: ${msg}`);
    }
  }
}

console.log('');
console.log(
  `  ${names.length - hardFail}/${names.length} packages passed` +
    (softWarn ? `  (${softWarn} browser warning${softWarn > 1 ? 's' : ''})` : ''),
);

if (hardFail > 0) {
  console.error(`\n  import smoke FAILED — ${hardFail} package(s)`);
  process.exit(1);
}
console.log('  import smoke passed');
