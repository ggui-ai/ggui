#!/usr/bin/env node
/**
 * Leaf-first publish order for the clean-room consumer.
 *
 * Reads every publishable `@ggui-ai/*` package under <packages-root>
 * and topologically sorts them so a package always appears AFTER the
 * workspace packages it depends on. This is computed from the actual
 * dependency graph every run, so it can never drift from reality —
 * unlike a hand-maintained ORDER array.
 *
 * `release.yml` currently keeps its own hardcoded `ORDER`. When the
 * gate is folded into `release.yml` (see ../README.md "Roadmap"),
 * that array should be replaced with a call to this script.
 *
 * Usage:
 *   node compute-order.mjs <packages-root>
 *       → JSON array of { dir, name, version }, leaf-first.
 *   node compute-order.mjs <packages-root> --consumer-pkg
 *       → a consumer package.json with every package as a dependency.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: compute-order.mjs <packages-root> [--consumer-pkg]');
  process.exit(1);
}
const consumerMode = process.argv.includes('--consumer-pkg');

const dirs = readdirSync(root).filter((d) => {
  try {
    return (
      statSync(join(root, d)).isDirectory() &&
      existsSync(join(root, d, 'package.json'))
    );
  } catch {
    return false;
  }
});

/** name -> { dir, name, version, deps: string[] } */
const pkgs = {};
for (const dir of dirs) {
  const pj = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  if (pj.private || !pj.name || !pj.name.startsWith('@ggui-ai/')) continue;
  const deps = [];
  for (const [d, v] of Object.entries({
    ...(pj.dependencies || {}),
    ...(pj.peerDependencies || {}),
  })) {
    if (String(v).startsWith('workspace:')) deps.push(d);
  }
  pkgs[pj.name] = { dir, name: pj.name, version: pj.version, deps };
}

const order = [];
const done = new Set();
const visit = (name, stack) => {
  if (done.has(name)) return;
  if (stack.includes(name)) {
    throw new Error('dependency cycle: ' + [...stack, name].join(' -> '));
  }
  for (const dep of pkgs[name]?.deps ?? []) {
    if (pkgs[dep]) visit(dep, [...stack, name]);
  }
  done.add(name);
  order.push(name);
};
for (const name of Object.keys(pkgs).sort()) visit(name, []);

const ordered = order.map((n) => ({
  dir: pkgs[n].dir,
  name: pkgs[n].name,
  version: pkgs[n].version,
}));

if (consumerMode) {
  const dependencies = {};
  for (const p of ordered) dependencies[p.name] = p.version;
  // A realistic React consumer ships react/react-dom; pinning them
  // gives npm a concrete version to satisfy the SDK packages' peers.
  dependencies['react'] = '^19.0.0';
  dependencies['react-dom'] = '^19.0.0';
  console.log(
    JSON.stringify(
      {
        name: '@ggui-gate/consumer',
        version: '0.0.0',
        private: true,
        description:
          'Clean-room consumer — installs every published @ggui-ai/* package from Verdaccio with zero workspace linkage.',
        type: 'module',
        dependencies,
      },
      null,
      2,
    ),
  );
} else {
  console.log(JSON.stringify(ordered, null, 2));
}
