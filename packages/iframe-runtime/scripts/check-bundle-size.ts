/* eslint-disable no-console -- CLI build script; stdout is its output channel. */
/**
 * Bundle-size gate for `@ggui-ai/iframe-runtime`.
 *
 * Measures the gzipped size of `dist/iframe-runtime.js` (the iframe runtime
 * artifact) and fails the build when it exceeds the budget recorded in
 * `bundle-size.budget.json` next to this script's package root.
 *
 * Why a separate JSON file rather than a literal in this script: the
 * budget number is the AUTHORITATIVE shape-lock for what we're willing
 * to ship to operator iframes. Keeping it in a one-line JSON file makes
 * intentional widening visible in `git diff` (the file changes; the
 * script doesn't) and makes the value machine-readable for CI tooling
 * that wants to graph trend.
 *
 * Bootstrapping rule (C7a, plan §C7a Deliverable 5):
 *
 *   - The first commit that sources the bundle MEASURES the gzipped
 *     output and writes the result + 20% headroom into
 *     `bundle-size.budget.json`. That commit's value becomes the
 *     baseline.
 *   - Subsequent commits that grow the bundle past the budget FAIL
 *     this script. Authors either trim the addition or, if the growth
 *     is intentional (C7b ports React + wire in), update the budget
 *     in the same commit. Lifting silently is the drift this gate
 *     exists to prevent.
 *
 * The hard cap codified in plan §C7a is `current + 20%`. Plan §47
 * accepts a realistic ~140-150 KB gzipped post-C7b once React + wire
 * ship inside; the C7a baseline is much smaller because component-code
 * eval hasn't landed yet. The +20% headroom keeps us honest between
 * intentional ports and accidental growth.
 *
 * ─── Second gate: no package bundled twice ───
 *
 * The size budget alone reports a symptom ("381 KB exceeds 310 KB") and
 * leaves the cause to be excavated by hand. That excavation happened
 * once, on Dependabot PR #376: the bundle had grown 85 KB gz because it
 * carried TWO complete copies of zod v4 — 4.3.6 hoisted at the workspace
 * root (what `@ggui-ai/protocol` declares) plus 4.4.3 nested under
 * `@modelcontextprotocol/ext-apps` and `@modelcontextprotocol/sdk`,
 * locale tables and all.
 *
 * The mechanism is structural, not a one-off. Both MCP packages take
 * `zod` as a PEER (`^3.25.0 || ^4.0.0`), and this workspace runs
 * `autoInstallPeers: true`, so pnpm resolves that peer independently of
 * whatever the workspace already declares. When a lockfile is only
 * PARTIALLY regenerated — exactly what a Dependabot group bump does —
 * the frozen entry (protocol's zod) and the freshly-resolved peer can
 * land on different 4.x minors, and esbuild then inlines both. Nothing
 * about that is visible in the diff; it surfaces only as bundle bytes.
 * `pnpm dedupe` is the remedy, and this gate is how you learn you need
 * it. Note that a size budget can never be a substitute here: two zod
 * copies would sail through unnoticed on any day the budget happened to
 * have 85 KB of headroom.
 *
 * Run `tsx scripts/check-bundle-size.ts --self-test` to verify the
 * duplicate detector still fires (seeded mutations, no build required).
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const pkgRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const bundlePath = path.join(pkgRoot, 'dist/iframe-runtime.js');
const budgetPath = path.join(pkgRoot, 'bundle-size.budget.json');
const metaPath = path.join(pkgRoot, 'dist/iframe-runtime.meta.json');

const NODE_MODULES = 'node_modules/';

/** One npm package as it appears at a single install location. */
interface PackageAtLocation {
  /** Package name, scope included (`zod`, `@modelcontextprotocol/sdk`). */
  readonly name: string;
  /**
   * Path up to and including `node_modules/<name>` — the install
   * location. Two locations for one name is the duplicate we're after:
   * a root hoist plus a nested peer copy.
   */
  readonly location: string;
}

/**
 * Resolve an esbuild metafile input path to the package that owns it.
 *
 * The INNERMOST `node_modules/` segment wins, so a nested peer copy
 * (`node_modules/@modelcontextprotocol/sdk/node_modules/zod/index.js`)
 * attributes to `zod` at its nested location rather than to the parent
 * that happens to contain it. Returns null for first-party sources,
 * which live outside any `node_modules/`.
 */
function identifyPackage(inputPath: string): PackageAtLocation | null {
  const idx = inputPath.lastIndexOf(NODE_MODULES);
  if (idx === -1) return null;
  const segments = inputPath.slice(idx + NODE_MODULES.length).split('/');
  const [first, second] = segments;
  if (first === undefined || first === '') return null;
  // Scoped packages spend two segments on the name; an `@scope` with no
  // following segment is not a resolvable package path.
  if (first.startsWith('@')) {
    if (second === undefined || second === '') return null;
    const name = `${first}/${second}`;
    return { name, location: inputPath.slice(0, idx + NODE_MODULES.length) + name };
  }
  return {
    name: first,
    location: inputPath.slice(0, idx + NODE_MODULES.length) + first,
  };
}

/** One package found bundled from more than one install location. */
interface DuplicateFinding {
  readonly name: string;
  /** Install locations, largest byte contribution first. */
  readonly locations: readonly { readonly location: string; readonly bytes: number }[];
  /** Bytes attributable to every copy beyond the first — the waste. */
  readonly wastedBytes: number;
}

/**
 * Find every package the bundle inlines from two or more install
 * locations, worst waste first.
 *
 * Pure over the metafile's input map so `--self-test` can drive it with
 * seeded mutations and assert on specific findings.
 */
function findDuplicatePackages(
  inputs: Readonly<Record<string, { readonly bytesInOutput: number }>>,
): DuplicateFinding[] {
  const byName = new Map<string, Map<string, number>>();
  for (const [inputPath, { bytesInOutput }] of Object.entries(inputs)) {
    const pkg = identifyPackage(inputPath);
    if (pkg === null) continue;
    const locations = byName.get(pkg.name) ?? new Map<string, number>();
    locations.set(pkg.location, (locations.get(pkg.location) ?? 0) + bytesInOutput);
    byName.set(pkg.name, locations);
  }

  const findings: DuplicateFinding[] = [];
  for (const [name, locations] of byName) {
    if (locations.size < 2) continue;
    const ranked = [...locations]
      .map(([location, bytes]) => ({ location, bytes }))
      .sort((a, b) => b.bytes - a.bytes);
    // Charge everything past the largest copy as waste — keeping one copy
    // is unavoidable, keeping N is the defect.
    const wastedBytes = ranked.slice(1).reduce((sum, c) => sum + c.bytes, 0);
    findings.push({ name, locations: ranked, wastedBytes });
  }
  return findings.sort((a, b) => b.wastedBytes - a.wastedBytes);
}

interface BudgetFile {
  /**
   * Maximum allowed gzipped size of `dist/iframe-runtime.js` in bytes.
   * Written by the C7a baseline commit; updated only when an
   * intentional bundle growth is being ratified (e.g. C7b React +
   * wire port). See script docstring for the rule.
   */
  readonly gzipBytesMax: number;
  /**
   * Free-form note explaining what slice / commit established this
   * budget. Helps operators reading `git blame` understand why the
   * number is what it is.
   */
  readonly note: string;
}

function readBudget(): BudgetFile {
  const raw = readFileSync(budgetPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { gzipBytesMax?: unknown }).gzipBytesMax !== 'number' ||
    typeof (parsed as { note?: unknown }).note !== 'string'
  ) {
    throw new Error(
      `[check-bundle-size] ${budgetPath} is malformed; expected { gzipBytesMax: number, note: string }.`,
    );
  }
  return parsed as BudgetFile;
}

/**
 * Seeded-mutation self-test for the duplicate detector.
 *
 * A gate nobody exercises is a gate that can rot silently (see
 * docs/principles/no-silent-block.md). Each case below asserts a
 * SPECIFIC finding, not merely "something failed", so a detector that
 * regressed into reporting the wrong package or mis-attributing bytes
 * fails here rather than passing vacuously.
 */
function selfTest(): number {
  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail: string) => {
    if (!ok) failures.push(`${label}: ${detail}`);
  };

  // The real #376 shape: zod hoisted at the root AND nested under each
  // MCP package that takes it as a peer.
  const duplicated = findDuplicatePackages({
    '../../../node_modules/zod/v4/core/schemas.js': { bytesInOutput: 32156 },
    '../../../node_modules/zod/v4/classic/schemas.js': { bytesInOutput: 22601 },
    '../../../node_modules/@modelcontextprotocol/ext-apps/node_modules/zod/v4/core/schemas.js':
      { bytesInOutput: 30000 },
    '../../../node_modules/@modelcontextprotocol/sdk/node_modules/zod/v4/core/schemas.js':
      { bytesInOutput: 5000 },
    '../../../node_modules/@modelcontextprotocol/ext-apps/dist/src/app.js': {
      bytesInOutput: 29646,
    },
    'src/runtime.ts': { bytesInOutput: 4096 },
  });
  check(
    'duplicate zod detected',
    duplicated.length === 1 && duplicated[0]?.name === 'zod',
    `expected exactly one finding for "zod", got ${JSON.stringify(duplicated.map((d) => d.name))}`,
  );
  check(
    'all three zod locations attributed',
    duplicated[0]?.locations.length === 3,
    `expected 3 locations, got ${duplicated[0]?.locations.length}`,
  );
  check(
    'waste excludes the largest copy',
    duplicated[0]?.wastedBytes === 35000,
    `expected 35000 wasted bytes (30000 + 5000, root copy's 54757 kept), got ${duplicated[0]?.wastedBytes}`,
  );
  check(
    'ext-apps itself is not reported',
    !duplicated.some((d) => d.name === '@modelcontextprotocol/ext-apps'),
    'a nested copy must attribute to the inner package, not the parent that contains it',
  );

  // The healthy shape: every package resolved from exactly one place.
  const clean = findDuplicatePackages({
    '../../../node_modules/zod/v4/core/schemas.js': { bytesInOutput: 32156 },
    '../../../node_modules/zod/v4/classic/schemas.js': { bytesInOutput: 22601 },
    '../../../node_modules/@modelcontextprotocol/ext-apps/dist/src/app.js': {
      bytesInOutput: 29646,
    },
    '../../../node_modules/react-dom/cjs/react-dom.production.js': {
      bytesInOutput: 174055,
    },
    'src/runtime.ts': { bytesInOutput: 4096 },
  });
  check(
    'clean bundle reports nothing',
    clean.length === 0,
    `expected no findings, got ${JSON.stringify(clean.map((d) => d.name))}`,
  );

  // Scoped-package duplication must be detected on the FULL name — a
  // detector splitting on the first segment would collapse every
  // `@scope/*` package into one bucket and report false duplicates.
  const scoped = findDuplicatePackages({
    '../../../node_modules/@modelcontextprotocol/sdk/dist/index.js': {
      bytesInOutput: 28888,
    },
    '../../../node_modules/@modelcontextprotocol/ext-apps/node_modules/@modelcontextprotocol/sdk/dist/index.js':
      { bytesInOutput: 9000 },
    '../../../node_modules/@ggui-ai/design/dist/index.js': { bytesInOutput: 1000 },
  });
  check(
    'scoped duplicate detected on the full name',
    scoped.length === 1 && scoped[0]?.name === '@modelcontextprotocol/sdk',
    `expected one finding for "@modelcontextprotocol/sdk", got ${JSON.stringify(scoped.map((d) => d.name))}`,
  );

  if (failures.length > 0) {
    console.error('[check-bundle-size] SELF-TEST FAILED');
    for (const f of failures) console.error(`  ✗ ${f}`);
    return 1;
  }
  console.log(
    '[check-bundle-size] self-test PASS — duplicate detector fires on the #376 shape, stays quiet on a clean bundle, and keeps scoped names intact.',
  );
  return 0;
}

if (process.argv.includes('--self-test')) {
  process.exit(selfTest());
}

try {
  statSync(bundlePath);
} catch {
  console.error(
    `[check-bundle-size] ${bundlePath} not found. Run \`node esbuild.config.mjs\` first.`,
  );
  process.exit(2);
}

const budget = readBudget();
const raw = readFileSync(bundlePath);
const gz = gzipSync(raw);
const rawKb = (raw.byteLength / 1024).toFixed(2);
const gzKb = (gz.byteLength / 1024).toFixed(2);
const budgetKb = (budget.gzipBytesMax / 1024).toFixed(2);
const pct = Math.round((gz.byteLength / budget.gzipBytesMax) * 100);

console.log(
  `iframe-runtime bundle — raw ${rawKb} KB · gzipped ${gzKb} KB · budget ${budgetKb} KB (${pct}%)`,
);
console.log(`  budget note: ${budget.note}`);

// Duplicate check runs BEFORE the size check: when both trip, the
// duplicate is the actionable cause and the overrun is its symptom.
// Reporting the symptom first sends the reader off trimming features
// that were never the problem.
let metaRaw: string | null = null;
try {
  metaRaw = readFileSync(metaPath, 'utf8');
} catch {
  console.error(
    `[check-bundle-size] ${metaPath} not found. Run \`node esbuild.config.mjs\` first — ` +
      `the duplicate-package check cannot run without the build metafile.`,
  );
  process.exit(2);
}
const meta = JSON.parse(metaRaw) as {
  outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
};
const bundleOutput = Object.entries(meta.outputs).find(([out]) =>
  out.endsWith('iframe-runtime.js'),
)?.[1];
if (bundleOutput === undefined) {
  console.error(
    `[check-bundle-size] ${metaPath} has no output entry for iframe-runtime.js; ` +
      `the metafile does not describe the bundle being measured.`,
  );
  process.exit(2);
}

const duplicates = findDuplicatePackages(bundleOutput.inputs);
if (duplicates.length > 0) {
  console.error(
    `[check-bundle-size] FAIL — ${duplicates.length} package(s) are bundled from more than one install location. ` +
      `Every copy past the first ships to every iframe for nothing.`,
  );
  for (const dup of duplicates) {
    console.error(
      `\n  ${dup.name} — ${(dup.wastedBytes / 1024).toFixed(1)} KB raw wasted across ${dup.locations.length} copies:`,
    );
    for (const { location, bytes } of dup.locations) {
      console.error(`    ${(bytes / 1024).toFixed(1).padStart(8)} KB  ${location}`);
    }
  }
  console.error(
    `\n  Usual cause: a peer dependency (this workspace runs autoInstallPeers) resolved to a ` +
      `different version than the one a workspace package declares, so pnpm nested a second copy. ` +
      `A partially-regenerated lockfile — e.g. a Dependabot group bump — is the usual trigger. ` +
      `Fix with \`pnpm dedupe\`, then rebuild. If a duplicate is ever genuinely required, ` +
      `say so in bundle-size.budget.json#note in the same commit.`,
  );
  process.exit(1);
}
console.log(
  `  no duplicate packages — every bundled dependency resolves from exactly one install location`,
);

if (gz.byteLength > budget.gzipBytesMax) {
  console.error(
    `[check-bundle-size] FAIL — gzipped ${gzKb} KB exceeds budget ${budgetKb} KB. ` +
      `Either trim the growth or, if intentional (C7b React + wire port), ` +
      `update bundle-size.budget.json in the same commit and explain why.`,
  );
  process.exit(1);
}

console.log(`[check-bundle-size] PASS — ${gzKb} KB / ${budgetKb} KB`);
