#!/usr/bin/env node
/**
 * Whether a change can move what the Expo export smoke checks. Prints
 * `1` (run it) or `0` (skip it).
 *
 *   git diff --name-only <base> <head> | node expo-fixture-scope.mjs <oss-root>
 *
 * Paths are read from stdin, relative to the monorepo root
 * (`oss/packages/…`). A path outside `oss/` is out of scope, except the
 * workflow that runs this gate.
 *
 * The smoke bundles @ggui-ai/mcp-apps-react-native, so it is in scope
 * when a change touches:
 *   - that package, or any @ggui-ai/* package it reaches through
 *     `workspace:` dependencies, peer dependencies, or (for the package
 *     itself) dev dependencies, which its build bundles;
 *   - the lockfile or the workspace manifest, which move what installs;
 *   - the smoke itself: the fixture app, its scripts, the gate harness.
 *
 * The closure is read from the package.json files under <oss-root>, so
 * a new dependency puts its package in scope with no list to update.
 * An empty change list prints `1`: with nothing to compare, run it.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ossRoot = resolve(process.argv[2] ?? '.');
const packagesDir = join(ossRoot, 'packages');

const byName = new Map();
for (const dir of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  byName.set(manifest.name, { dir, manifest });
}

const ROOT_PACKAGE = '@ggui-ai/mcp-apps-react-native';
const closure = new Set();
function visit(name, withDev) {
  const entry = byName.get(name);
  if (entry === undefined || closure.has(entry.dir)) return;
  closure.add(entry.dir);
  const { manifest } = entry;
  const deps = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...(withDev ? manifest.devDependencies : {}),
  };
  for (const [dep, range] of Object.entries(deps)) {
    if (String(range).startsWith('workspace:')) visit(dep, false);
  }
}
visit(ROOT_PACKAGE, true);
if (closure.size === 0) {
  console.error(`expo-fixture-scope: ${ROOT_PACKAGE} not found under ${packagesDir}`);
  process.exit(1);
}

const prefixes = [
  ...[...closure].map((dir) => `packages/${dir}/`),
  'e2e/clean-room-consumer/',
];
const files = new Set(['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', '.npmrc']);

const WORKFLOW = '.github/workflows/clean-room-consumer.yml';

const changed = readFileSync(0, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '');

function inScopePath(path) {
  if (path === WORKFLOW) return true;
  if (!path.startsWith('oss/')) return false;
  const ossPath = path.slice('oss/'.length);
  return files.has(ossPath) || prefixes.some((prefix) => ossPath.startsWith(prefix));
}

const inScope = changed.length === 0 || changed.some(inScopePath);

console.error(`expo-fixture-scope: closure ${[...closure].sort().join(', ')}`);
console.log(inScope ? '1' : '0');
