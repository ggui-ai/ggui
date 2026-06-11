#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI; stdout is its UI. */
/**
 * check-template-pins — npm-publishability preflight for assembled
 * agentic-app templates.
 *
 * Walks every package.json under the given assembled-templates root,
 * collects every `@ggui-ai/*` dependency spec (dependencies /
 * devDependencies / peerDependencies), and verifies each unique
 * `(name, spec)` pair matches AT LEAST ONE version published on npm
 * (`npm view "<name>@<spec>" version`).
 *
 * Why this exists: the assembler derives its default pin range from the
 * COMMITTED lockstep base (see build-templates.mjs#gguiAiPinRange). After
 * a version bump, that range matches nothing on npm until the new cohort
 * is published — and a template pinned to an unsatisfiable range fails
 * `pnpm install` for every user who scaffolds it. This preflight gates
 * the public-mirror push in
 * `.github/workflows/sync-agentic-app-templates.yml`: an unpublishable
 * pin fails the assemble job, so the mirror at
 * github.com/ggui-ai/agentic-app-templates can never receive a
 * non-installable snapshot. Remediation is always "publish the @ggui-ai/*
 * cohort first, then re-dispatch the sync".
 *
 * Usage:
 *   node oss/scripts/check-template-pins.mjs <assembled-root>
 *
 * Exit codes: 0 = every pin satisfiable, 1 = bad args / no package.json
 * found, 2 = at least one unsatisfiable pin.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];

function collectPackageJsons(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      collectPackageJsons(p, out);
    } else if (entry === 'package.json') {
      out.push(p);
    }
  }
  return out;
}

function main() {
  const rootArg = process.argv[2];
  if (!rootArg) {
    console.error('✗ usage: node oss/scripts/check-template-pins.mjs <assembled-root>');
    process.exit(1);
  }
  const root = resolve(rootArg);
  if (!existsSync(root)) {
    console.error(`✗ assembled root does not exist: ${root}`);
    process.exit(1);
  }

  const pkgJsons = collectPackageJsons(root, []);
  if (pkgJsons.length === 0) {
    console.error(`✗ no package.json found under ${root} — nothing assembled?`);
    process.exit(1);
  }

  /** Map "name@spec" → [file, …] for the failure report. */
  const pins = new Map();
  for (const file of pkgJsons) {
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    for (const field of DEP_FIELDS) {
      const deps = pkg[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (!name.startsWith('@ggui-ai/')) continue;
        if (typeof spec !== 'string' || spec.startsWith('link:')) continue;
        const key = `${name}@${spec}`;
        const files = pins.get(key) ?? [];
        files.push(file);
        pins.set(key, files);
      }
    }
  }

  if (pins.size === 0) {
    console.error(
      `✗ no @ggui-ai/* deps found in ${pkgJsons.length} package.json files under ${root} — ` +
        'the assembler rewrite did not run?',
    );
    process.exit(1);
  }

  console.log(`check-template-pins: ${pins.size} unique @ggui-ai/* pin(s) across ${pkgJsons.length} package.json files`);

  const failures = [];
  for (const [key, files] of pins) {
    try {
      // `npm view <name>@<spec> version` exits non-zero (E404) when no
      // published version satisfies the spec — exactly the signal we gate on.
      execFileSync('npm', ['view', key, 'version', '--json'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
      });
      console.log(`  ✓ ${key}`);
    } catch {
      failures.push({ key, files });
      console.log(`  ✗ ${key} — NO published version satisfies this range`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} unsatisfiable @ggui-ai/* pin(s):`);
    for (const { key, files } of failures) {
      console.error(`  - ${key}`);
      for (const f of files) console.error(`      ${f}`);
    }
    console.error(
      '\nThe assembled templates would fail `pnpm install` for every user.\n' +
        'Publish the @ggui-ai/* cohort for this base version first, then\n' +
        're-run the template sync.',
    );
    process.exit(2);
  }
  console.log('\n✓ every @ggui-ai/* pin resolves to a published npm version');
}

main();
