#!/usr/bin/env node
/**
 * Seed upstream-pinned @ggui-ai/* versions into the samples-render Verdaccio.
 *
 * WHY THIS EXISTS — the exact-upstream-pin 404 hazard: the with-guuey compose
 * installs published @guuey/* packages from REAL npm, and those packages pin
 * @ggui-ai/* deps EXACTLY (e.g. @guuey/mcp-apps-host@0.3.1 →
 * @ggui-ai/protocol@0.6.3). The composed cell's .npmrc scopes @ggui-ai:registry
 * to the harness Verdaccio, whose config serves @ggui-ai/* LOCAL-ONLY — no
 * npm uplink, ON PURPOSE: a package missing from the local publish must fail
 * loudly, never silently resolve to the npm-published version (false green).
 * The moment the local cohort version moves past an upstream pin, that exact
 * pin 404s inside the cell — a harness artifact, not a real-world failure
 * (real npm always has the pinned version). The ruled fix is to SEED: publish
 * the exact pinned versions from real npm into the run's Verdaccio alongside
 * the cohort, keeping the local-only anti-fallthrough guarantee intact for
 * everything that ISN'T a known upstream pin.
 *
 * Flow (setup.sh step 4, after the cohort publish):
 *   1. Scan oss/samples/**\/package.json for @guuey/* pins (exact by design —
 *      the samples deliberately never share a hoist with workspace HEAD).
 *   2. BFS the @guuey/* dependency closure against real npm (`npm view`),
 *      collecting every @ggui-ai/* dep spec it requires.
 *   3. Read the locally-published cohort (same derivation as the publisher:
 *      clean-room-consumer's compute-order.mjs).
 *   4. computeSeedList (pure, network-free — self-tested below) decides which
 *      exact pins the cohort does NOT cover.
 *   5. `npm pack` each from real npm and publish the tarball into Verdaccio.
 *
 * Loud in both directions:
 *   - seeds  → "[seed] seeded @ggui-ai/protocol@0.6.3 (upstream pin from
 *               @guuey/mcp-apps-host@0.3.1 ≠ local cohort 0.7.0)"
 *   - no-op  → "[seed] no upstream-pin seeding needed (cohort == all pins)"
 *
 * Usage:
 *   node seed-upstream-pins.mjs --registry=http://localhost:4873
 *   node seed-upstream-pins.mjs --self-test     (pure logic only, no network)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../../..');
const OSS_ROOT = resolve(REPO_ROOT, 'oss');
const SAMPLES_ROOT = resolve(OSS_ROOT, 'samples');
const PACKAGES_ROOT = resolve(OSS_ROOT, 'packages');
const COMPUTE_ORDER = resolve(OSS_ROOT, 'e2e/clean-room-consumer/scripts/compute-order.mjs');

/** The one registry upstream pins are resolved from and packed out of. */
const REAL_NPM = 'https://registry.npmjs.org';

/** Exact semver (optionally prerelease) — the only spec shape npm 404s on. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/**
 * PURE decision function (no network, no fs) — which @ggui-ai/* pins must be
 * seeded into the local-only Verdaccio alongside the published cohort.
 *
 * @param {Array<{name: string, spec: string, requiredBy: string}>} pins
 *   Every @ggui-ai/* dep spec required by the @guuey/* closure the compose
 *   installs (`requiredBy` names the @guuey pkg@version for the log line).
 * @param {Record<string, string>} cohort
 *   Locally-published cohort: @ggui-ai/* package name → version.
 * @returns {{
 *   seed: Array<{name: string, version: string, requiredBy: string[], cohortVersion: string | null}>,
 *   satisfied: Array<{name: string, spec: string, requiredBy: string}>,
 *   indeterminate: Array<{name: string, spec: string, requiredBy: string}>,
 * }}
 *   `seed` — exact pins the cohort does not carry (dedup by name@version);
 *   `satisfied` — exact pins the cohort covers verbatim;
 *   `indeterminate` — non-exact specs (ranges resolve against whatever the
 *   local-only registry holds; flagged for a loud warning, never seeded).
 */
export function computeSeedList(pins, cohort) {
  const seedByKey = new Map();
  const satisfied = [];
  const indeterminate = [];

  for (const pin of pins) {
    if (!pin.name.startsWith('@ggui-ai/')) {
      throw new Error(
        `computeSeedList: pin "${pin.name}" is not @ggui-ai/* — the seeder ` +
          'only ever seeds the local-only scope (everything else proxies to npm)',
      );
    }
    if (!EXACT_VERSION.test(pin.spec)) {
      indeterminate.push(pin);
      continue;
    }
    const cohortVersion = Object.hasOwn(cohort, pin.name) ? cohort[pin.name] : null;
    if (cohortVersion === pin.spec) {
      satisfied.push(pin);
      continue;
    }
    const key = `${pin.name}@${pin.spec}`;
    const existing = seedByKey.get(key);
    if (existing) {
      existing.requiredBy.push(pin.requiredBy);
    } else {
      seedByKey.set(key, {
        name: pin.name,
        version: pin.spec,
        requiredBy: [pin.requiredBy],
        cohortVersion,
      });
    }
  }

  return { seed: [...seedByKey.values()], satisfied, indeterminate };
}

/* ────────────────────────── gather (fs + network) ────────────────────────── */

/** Walk oss/samples for package.json files; collect @guuey/* dep pins. */
function collectGuueyPins(root) {
  const pins = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === 'node_modules') continue;
        visit(p);
      } else if (entry === 'package.json') {
        const pkg = JSON.parse(readFileSync(p, 'utf8'));
        for (const field of ['dependencies', 'devDependencies']) {
          for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
            if (name.startsWith('@guuey/')) {
              pins.push({ name, spec, requiredBy: pkg.name ?? p });
            }
          }
        }
      }
    }
  };
  visit(root);
  return pins;
}

/** `npm view <pkg>@<version> dependencies --json` against real npm. */
function npmViewDependencies(name, version) {
  const out = execFileSync(
    'npm',
    ['view', `${name}@${version}`, 'dependencies', '--json', '--registry', REAL_NPM],
    { encoding: 'utf8' },
  ).trim();
  if (out === '') return {};
  return JSON.parse(out);
}

/**
 * BFS the @guuey/* dependency closure on real npm (a pinned @guuey/cli pulls
 * further @guuey/* packages — any of them may carry an exact @ggui-ai pin),
 * returning every @ggui-ai/* dep spec found along the way.
 */
function resolveGguiPinsFromGuueyClosure(guueyPins) {
  const queue = [...guueyPins];
  const visited = new Set();
  const gguiPins = [];

  while (queue.length > 0) {
    const { name, spec } = queue.shift();
    if (!EXACT_VERSION.test(spec)) {
      // The samples' design contract is exact @guuey pins (their dirs are
      // excluded from the workspaces precisely so the pins stay exact) — a
      // range here means the contract broke upstream of this script.
      throw new Error(
        `@guuey pin "${name}@${spec}" is not an exact version — the with-guuey ` +
          'samples pin @guuey/* exactly by design; fix the sample, not the seeder',
      );
    }
    const key = `${name}@${spec}`;
    if (visited.has(key)) continue;
    visited.add(key);

    for (const [dep, depSpec] of Object.entries(npmViewDependencies(name, spec))) {
      if (dep.startsWith('@ggui-ai/')) {
        gguiPins.push({ name: dep, spec: depSpec, requiredBy: key });
      } else if (dep.startsWith('@guuey/')) {
        queue.push({ name: dep, spec: depSpec });
      }
    }
  }
  return gguiPins;
}

/** Local cohort via the SAME derivation the publisher uses (compute-order). */
function readCohort() {
  const out = execFileSync('node', [COMPUTE_ORDER, PACKAGES_ROOT], { encoding: 'utf8' });
  const cohort = {};
  for (const { name, version } of JSON.parse(out)) cohort[name] = version;
  return cohort;
}

/* ─────────────────────────────── seed (network) ───────────────────────────── */

/** Is name@version already present in the target registry? (404 ⇒ absent) */
function presentInRegistry(name, version, registry) {
  const res = spawnSync(
    'npm',
    ['view', `${name}@${version}`, 'version', '--json', '--registry', registry],
    { encoding: 'utf8' },
  );
  return res.status === 0 && res.stdout.trim() !== '';
}

/**
 * Pack each seed entry from real npm and publish the tarball into `registry`.
 * Exported so the live pack→publish path is drivable in isolation (scratch
 * Verdaccio) without faking a cohort bump.
 */
export function seedPackages(seed, registry) {
  const hostPort = registry.replace(/^https?:\/\//, '').replace(/\/$/, '');
  // Verdaccio accepts any non-empty token on `publish: $all` packages; the
  // npm CLI still refuses to attempt a publish without one configured.
  execFileSync('npm', ['config', 'set', `//${hostPort}/:_authToken`, 'samples-render-seed-token']);

  const workDir = mkdtempSync(join(tmpdir(), 'ggui-seed-'));
  try {
    for (const entry of seed) {
      const id = `${entry.name}@${entry.version}`;
      if (presentInRegistry(entry.name, entry.version, registry)) {
        console.log(`[seed] ${id} already present in ${registry} — skipping`);
        continue;
      }
      const packed = JSON.parse(
        execFileSync(
          'npm',
          ['pack', id, '--registry', REAL_NPM, '--pack-destination', workDir, '--json'],
          { encoding: 'utf8' },
        ),
      );
      const tarball = join(workDir, packed[0].filename);
      execFileSync(
        'npm',
        ['publish', tarball, '--registry', registry, '--access', 'public'],
        { encoding: 'utf8', stdio: ['ignore', 'ignore', 'inherit'] },
      );
      console.log(
        `[seed] seeded ${id} (upstream pin from ${entry.requiredBy.join(', ')} ` +
          `≠ local cohort ${entry.cohortVersion ?? '<not in cohort>'})`,
      );
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/* ─────────────────────────────────── main ─────────────────────────────────── */

function main() {
  const registryArg = process.argv.find((a) => a.startsWith('--registry='));
  if (!registryArg) {
    console.error('usage: seed-upstream-pins.mjs --registry=<verdaccio-url> | --self-test');
    process.exit(1);
  }
  const registry = registryArg.slice('--registry='.length).replace(/\/$/, '');

  const guueyPins = collectGuueyPins(SAMPLES_ROOT);
  if (guueyPins.length === 0) {
    console.log('[seed] no @guuey/* pins in oss/samples — nothing to resolve');
    return;
  }
  console.log(
    `[seed] resolving @ggui-ai/* deps of ${guueyPins.length} @guuey/* sample pins against real npm`,
  );
  const gguiPins = resolveGguiPinsFromGuueyClosure(guueyPins);
  const cohort = readCohort();
  const { seed, satisfied, indeterminate } = computeSeedList(gguiPins, cohort);

  for (const pin of indeterminate) {
    console.log(
      `[seed] WARNING: non-exact @ggui-ai pin "${pin.name}@${pin.spec}" from ` +
        `${pin.requiredBy} — a range resolves against the local-only registry's ` +
        'published versions; cannot statically verify it is satisfiable',
    );
  }
  for (const pin of satisfied) {
    console.log(`[seed] ${pin.name}@${pin.spec} (from ${pin.requiredBy}) == local cohort — ok`);
  }
  if (seed.length === 0) {
    console.log('[seed] no upstream-pin seeding needed (cohort == all pins)');
    return;
  }
  seedPackages(seed, registry);
}

/* ────────────────────────────────  self-test ──────────────────────────────── */

/**
 * `--self-test`: prove the pure decision logic can FAIL (evidence-tier parity
 * with compose-app.mjs's self-test — every assembly/drift gate carries one).
 * No network, no fs writes. Run per-PR by samples-render.yml.
 */
function selfTest() {
  const fail = (msg) => {
    console.error(`✗ seed-upstream-pins self-test: ${msg}`);
    process.exit(1);
  };

  // No-op: every exact pin matches the cohort → nothing seeds.
  const noop = computeSeedList(
    [{ name: '@ggui-ai/protocol', spec: '0.6.3', requiredBy: '@guuey/mcp-apps-host@0.3.1' }],
    { '@ggui-ai/protocol': '0.6.3' },
  );
  if (noop.seed.length !== 0 || noop.satisfied.length !== 1 || noop.indeterminate.length !== 0) {
    fail('cohort==pin must be a no-op (nothing to seed)');
  }

  // Cohort moved past the pin → seed the exact pinned version.
  const bumped = computeSeedList(
    [{ name: '@ggui-ai/protocol', spec: '0.6.3', requiredBy: '@guuey/mcp-apps-host@0.3.1' }],
    { '@ggui-ai/protocol': '0.7.0' },
  );
  if (
    bumped.seed.length !== 1 ||
    bumped.seed[0].name !== '@ggui-ai/protocol' ||
    bumped.seed[0].version !== '0.6.3' ||
    bumped.seed[0].cohortVersion !== '0.7.0'
  ) {
    fail('cohort bump past an exact pin must seed the pinned version');
  }

  // Pin on a package the cohort no longer publishes at all → still seeds.
  const gone = computeSeedList(
    [{ name: '@ggui-ai/retired', spec: '0.5.0', requiredBy: '@guuey/x@1.0.0' }],
    { '@ggui-ai/protocol': '0.7.0' },
  );
  if (gone.seed.length !== 1 || gone.seed[0].cohortVersion !== null) {
    fail('a pin on a package absent from the cohort must seed (cohortVersion null)');
  }

  // Non-exact spec → indeterminate (warned), NEVER seeded.
  const range = computeSeedList(
    [{ name: '@ggui-ai/protocol', spec: '^0.6.0', requiredBy: '@guuey/y@1.0.0' }],
    { '@ggui-ai/protocol': '0.7.0' },
  );
  if (range.seed.length !== 0 || range.indeterminate.length !== 1) {
    fail('a range spec must land in indeterminate, never in seed');
  }

  // Two requirers of the same exact pin → ONE seed entry, both attributed.
  const dedup = computeSeedList(
    [
      { name: '@ggui-ai/protocol', spec: '0.6.3', requiredBy: '@guuey/a@1.0.0' },
      { name: '@ggui-ai/protocol', spec: '0.6.3', requiredBy: '@guuey/b@1.0.0' },
    ],
    { '@ggui-ai/protocol': '0.7.0' },
  );
  if (dedup.seed.length !== 1 || dedup.seed[0].requiredBy.length !== 2) {
    fail('duplicate pins must dedupe to one seed entry with merged requiredBy');
  }

  // Seeded negative: a non-@ggui-ai pin must THROW (the seeder must never
  // widen past the local-only scope).
  let threw = false;
  try {
    computeSeedList([{ name: '@guuey/host', spec: '0.3.0', requiredBy: 'x' }], {});
  } catch {
    threw = true;
  }
  if (!threw) {
    fail('computeSeedList must THROW on a non-@ggui-ai pin (seeded negative did not fire)');
  }

  console.log('✓ seed-upstream-pins self-test: decision logic (6 cases incl. seeded negative)');
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes('--self-test')) selfTest();
  else main();
}
