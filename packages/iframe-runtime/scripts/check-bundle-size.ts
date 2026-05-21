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

if (gz.byteLength > budget.gzipBytesMax) {
  console.error(
    `[check-bundle-size] FAIL — gzipped ${gzKb} KB exceeds budget ${budgetKb} KB. ` +
      `Either trim the growth or, if intentional (C7b React + wire port), ` +
      `update bundle-size.budget.json in the same commit and explain why.`,
  );
  process.exit(1);
}

console.log(`[check-bundle-size] PASS — ${gzKb} KB / ${budgetKb} KB`);
