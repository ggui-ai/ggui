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

/**
 * One bounded retry for real-npm round-trips: a single re-attempt after a
 * short backoff (a transient registry hiccup at setup time must not kill the
 * whole nightly), then a LOUD final failure. Deliberately not a loop.
 */
const RETRY_BACKOFF_MS = 5_000;
function withOneRetry(label, fn) {
  try {
    return fn();
  } catch (firstErr) {
    console.log(
      `[seed] ${label} failed (${String(firstErr).split('\n')[0]}) — ` +
        `retrying once in ${RETRY_BACKOFF_MS / 1000}s`,
    );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_BACKOFF_MS);
    try {
      return fn();
    } catch (secondErr) {
      throw new Error(`${label} failed after 1 retry: ${String(secondErr)}`);
    }
  }
}

/**
 * dependencies + peerDependencies of <pkg>@<version> on real npm, merged —
 * a peer-declared @ggui-ai/* requirement 404s in the cell exactly like a
 * regular one (npm ≥7 auto-installs peers), so both fields feed the pin
 * scan. Reads the FULL version manifest (`npm view <spec> --json`) rather
 * than field arguments: with 2+ field args npm UNWRAPS the output to the
 * bare value whenever only one of them exists on the package, which
 * silently dropped mcp-apps-host's (dependencies-only) protocol pin during
 * verification of this very script. The manifest shape is unambiguous.
 */
function npmViewDepFields(name, version) {
  const out = withOneRetry(`npm view ${name}@${version} manifest`, () =>
    execFileSync('npm', ['view', `${name}@${version}`, '--json', '--registry', REAL_NPM], {
      encoding: 'utf8',
    }),
  ).trim();
  if (out === '') {
    throw new Error(`npm view ${name}@${version} returned no manifest — version absent on ${REAL_NPM}?`);
  }
  const manifest = JSON.parse(out);
  if (Array.isArray(manifest)) {
    throw new Error(
      `npm view ${name}@${version} returned ${manifest.length} manifests — ` +
        'expected an exact version to match exactly one',
    );
  }
  return { ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}) };
}

/**
 * PURE semver compare (core triple, then absent-prerelease > present, then
 * per-identifier prerelease rules: numeric < alphanumeric, numeric compared
 * numerically, shorter identifier set lower). Hand-rolled because this
 * script must run stdlib-only (repo-guards + the cell run it without a pnpm
 * install). Throws on non-semver input — self-tested below.
 */
export function compareSemver(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(v);
    if (!m) throw new Error(`compareSemver: "${v}" is not a semver version`);
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const ia = pa.pre.split('.');
  const ib = pb.pre.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * PURE: highest version in a list (order-independent — npm packuments keep
 * PUBLISH order, and a backport patch published after a newer minor would
 * make "take the last element" wrong). Throws on an empty list: reachable
 * from main() when a transitive range matches nothing on real npm.
 */
export function pickHighestVersion(versions) {
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error('pickHighestVersion: empty version list — the range matched no published version');
  }
  return versions.reduce((hi, v) => (compareSemver(v, hi) > 0 ? v : hi));
}

/** Resolve a (possibly ranged) spec to the highest satisfying real-npm version. */
function resolveVersionOnNpm(name, spec) {
  if (EXACT_VERSION.test(spec)) return spec;
  const out = withOneRetry(`npm view ${name}@${spec} version`, () =>
    execFileSync('npm', ['view', `${name}@${spec}`, 'version', '--json', '--registry', REAL_NPM], {
      encoding: 'utf8',
    }),
  ).trim();
  if (out === '') {
    throw new Error(`no published version of ${name} satisfies "${spec}" on ${REAL_NPM}`);
  }
  const parsed = JSON.parse(out);
  return pickHighestVersion(Array.isArray(parsed) ? parsed : [parsed]);
}

/**
 * BFS the @guuey/* dependency closure on real npm (a pinned @guuey/cli pulls
 * further @guuey/* packages — any of them may carry an exact @ggui-ai pin),
 * returning every @ggui-ai/* dep spec found along the way.
 *
 * Two spec regimes, deliberately different:
 *   - TOP-LEVEL pins (declared by the samples) must be exact — that is the
 *     samples' own design contract (their dirs are excluded from the
 *     workspaces precisely so the pins stay exact).
 *   - TRANSITIVE @guuey/* deps are upstream's ordinary publishing choice —
 *     a range there is legitimate and resolves to the highest satisfying
 *     real-npm version (what npm itself would install).
 *
 * The walk is deliberately NARROW: only @guuey/* edges are traversed and
 * only @ggui-ai/* deps are collected — @guuey/* is the SDK family the
 * compose installs and today's only carrier of exact @ggui-ai pins. Any
 * other scope (e.g. @silverprotocol/*) COULD in principle grow an exact
 * @ggui-ai pin the cell's scoped .npmrc would route to the local-only
 * registry, so every declined edge is logged (one line per scope, below) —
 * the loud line is the tripwire that says the walk needs widening.
 */
function resolveGguiPinsFromGuueyClosure(guueyPins) {
  const queue = guueyPins.map((p) => ({ ...p, topLevel: true }));
  const visited = new Set();
  const gguiPins = [];
  /** scope (or "(unscoped)") → Set<dep name> of edges NOT traversed. */
  const declined = new Map();

  while (queue.length > 0) {
    const { name, spec, topLevel } = queue.shift();
    let version;
    if (EXACT_VERSION.test(spec)) {
      version = spec;
    } else if (topLevel) {
      // The samples' design contract is exact @guuey pins — a range on a
      // SAMPLE-DECLARED dep means the sample broke its own contract.
      throw new Error(
        `sample-declared @guuey pin "${name}@${spec}" is not an exact version — ` +
          'the with-guuey samples pin @guuey/* exactly by design; fix the sample, ' +
          'not the seeder',
      );
    } else {
      // A ranged TRANSITIVE dep is upstream's ordinary choice, not a sample
      // defect — resolve it the way npm would.
      version = resolveVersionOnNpm(name, spec);
      console.log(
        `[seed] transitive @guuey range ${name}@${spec} → ${version} ` +
          '(highest satisfying on real npm)',
      );
    }
    const key = `${name}@${version}`;
    if (visited.has(key)) continue;
    visited.add(key);

    for (const [dep, depSpec] of Object.entries(npmViewDepFields(name, version))) {
      if (dep.startsWith('@ggui-ai/')) {
        gguiPins.push({ name: dep, spec: depSpec, requiredBy: key });
      } else if (dep.startsWith('@guuey/')) {
        queue.push({ name: dep, spec: depSpec, topLevel: false });
      } else {
        const scope = dep.startsWith('@') ? dep.split('/')[0] : '(unscoped)';
        if (!declined.has(scope)) declined.set(scope, new Set());
        declined.get(scope).add(dep);
      }
    }
  }

  // Nothing silent: name every dep edge the BFS declined to traverse, one
  // line per scope. If a line ever names a scope known to carry @ggui-ai/*
  // pins, the narrowing above is stale and must widen.
  for (const [scope, names] of [...declined.entries()].sort()) {
    console.log(
      `[seed] declined BFS edges in ${scope} (not @guuey/*, not @ggui-ai/*): ` +
        [...names].sort().join(', '),
    );
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

/**
 * Is name@version already present in the target registry?
 * Only a genuine ABSENT answer may return false: exit 0 with empty output
 * (package exists, version doesn't) or an E404 error (whole package absent —
 * the normal fresh-Verdaccio case). Any OTHER failure (connection refused,
 * 5xx, auth) throws loudly — treating it as "absent" would convert a
 * transient error into an EPUBLISHCONFLICT death one step later.
 */
function presentInRegistry(name, version, registry) {
  const res = spawnSync(
    'npm',
    ['view', `${name}@${version}`, 'version', '--json', '--registry', registry],
    { encoding: 'utf8' },
  );
  const stdout = (res.stdout ?? '').trim();
  if (res.status === 0) return stdout !== '';
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Non-JSON failure output — leave parsed null so the loud throw below
    // fires; the parse miss itself is part of the "not an E404" evidence.
  }
  if (parsed?.error?.code === 'E404') return false;
  throw new Error(
    `presence check for ${name}@${version} against ${registry} failed ` +
      `(exit ${res.status}) and is NOT an E404 — refusing to guess: ` +
      (stdout || res.stderr || '<no output>'),
  );
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
      // Explicit --tag: npm refuses to IMPLICITLY tag a publish as
      // `latest` when the registry already carries a higher version —
      // and seeding older upstream pins after new releases ship is
      // this script's normal case. Consumers install exact versions,
      // so the dist-tag itself is never resolved.
      execFileSync(
        'npm',
        [
          'publish',
          tarball,
          '--registry',
          registry,
          '--access',
          'public',
          '--tag',
          'seed-pin',
        ],
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
 * No network, no fs writes. Runs per-PR in repo-guards.yml (guard 7 — the
 * pure-node guard lane) and as a pre-flight in samples-render.yml's
 * nightly/dispatch run.
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

  // Defensive invariant (NOT reachable from main(), whose BFS only collects
  // @ggui-ai/* names): a non-@ggui-ai pin must THROW so no future caller can
  // widen the seeder past the local-only scope unnoticed.
  let threw = false;
  try {
    computeSeedList([{ name: '@guuey/host', spec: '0.3.0', requiredBy: 'x' }], {});
  } catch {
    threw = true;
  }
  if (!threw) {
    fail('computeSeedList must THROW on a non-@ggui-ai pin (defensive invariant did not fire)');
  }

  // Version comparator — the transitive-range resolution path (FIX for
  // upstream ranged @guuey deps) leans on it, so it gets the same treatment.
  if (pickHighestVersion(['0.6.3', '0.7.0', '0.6.4']) !== '0.7.0') {
    fail('pickHighestVersion must pick the semver max');
  }
  // Order-independent: a backport published AFTER a newer minor must not win.
  if (pickHighestVersion(['0.7.0', '0.6.4']) !== '0.7.0') {
    fail('pickHighestVersion must not depend on list order (backport-after case)');
  }
  if (compareSemver('0.4.0-rc.0', '0.4.0') >= 0) {
    fail('a prerelease must sort below its release');
  }
  if (compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10') >= 0) {
    fail('numeric prerelease identifiers must compare numerically (2 < 10)');
  }
  if (compareSemver('1.0.0-alpha.1', '1.0.0-alpha.1.1') >= 0) {
    fail('a longer prerelease identifier set with equal prefix must sort higher');
  }
  // Reachable negative: a transitive range matching NOTHING on real npm
  // funnels an empty list here from resolveVersionOnNpm.
  threw = false;
  try {
    pickHighestVersion([]);
  } catch {
    threw = true;
  }
  if (!threw) {
    fail('pickHighestVersion must THROW on an empty list (reachable negative did not fire)');
  }
  threw = false;
  try {
    compareSemver('not-a-version', '1.0.0');
  } catch {
    threw = true;
  }
  if (!threw) {
    fail('compareSemver must THROW on non-semver input');
  }

  console.log(
    '✓ seed-upstream-pins self-test: decision logic (5 cases + the ' +
      'non-@ggui-ai defensive invariant) + version comparator (7 cases incl. ' +
      'reachable empty-range negative)',
  );
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes('--self-test')) selfTest();
  else main();
}
