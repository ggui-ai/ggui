/* eslint-disable no-console -- CLI build script; stdout is its output channel. */
/**
 * Bundle-size gate for `@ggui-ai/console`.
 *
 * Walks the Vite `dist/` output, gzips every shipped file, sums the
 * compressed bytes, and fails the build when the total exceeds either
 * the stress cap (400 KB, early-warning) or the hard cap (500 KB, the
 * absolute ceiling from the MVP design note).
 *
 * Why total-gzipped rather than per-file: operators load the landing
 * page over one HTTP connection; what they experience is the sum of
 * HTML + JS + CSS + assets. A 450 KB JS bundle + a 100 KB CSS file
 * would each pass a per-file check, but the landing page they see
 * is 550 KB — over budget.
 *
 * Two thresholds, both fail-closed:
 *
 *   - {@link STRESS_CAP_BYTES} (400 KB) — Slice 3 §8.4 stress gate.
 *     Crossing this SHOULD force a conversation before the absolute
 *     ceiling is reached. Failing here is the cheap-to-fix signal:
 *     tree-shake harder, drop an import, or justify the widening by
 *     moving both this threshold and the hard cap together.
 *   - {@link HARD_CAP_BYTES} (500 KB) — MVP §6.3 absolute ceiling.
 *     Failing here is a kill-switch trigger per the design note: the
 *     `@ggui-ai/react` export shape no longer fits the OSS operator
 *     view in its current form.
 *
 * If either cap ever needs to move, update the MVP design note
 * (`docs/plans/2026-04-20-core-server-console-mvp.md` §6.3 and
 * §8.4) FIRST. Lifting these numbers silently is the drift the
 * design note's kill-switch was meant to prevent.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

/** Absolute ceiling from MVP design note §6.3. */
const HARD_CAP_BYTES = 500 * 1024;
/** Stress-gate from MVP design note §8.4 — fails before the ceiling. */
const STRESS_CAP_BYTES = 400 * 1024;

const distDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

try {
  statSync(distDir);
} catch {
  console.error(
    `[check-bundle-size] dist/ not found at ${distDir}. Run \`vite build\` first.`,
  );
  process.exit(2);
}

const files = walk(distDir);
if (files.length === 0) {
  console.error(`[check-bundle-size] dist/ is empty — nothing to measure.`);
  process.exit(2);
}

interface Row {
  readonly file: string;
  readonly rawBytes: number;
  readonly gzipBytes: number;
}
const report: Row[] = [];
let total = 0;
for (const file of files) {
  const raw = readFileSync(file);
  const gz = gzipSync(raw);
  report.push({
    file: path.relative(distDir, file),
    rawBytes: raw.byteLength,
    gzipBytes: gz.byteLength,
  });
  total += gz.byteLength;
}

report.sort((a, b) => b.gzipBytes - a.gzipBytes);
const kb = (n: number): string => `${(n / 1024).toFixed(2)} KB`;

console.log(
  `console bundle — gzipped (stress: ${kb(STRESS_CAP_BYTES)} · hard: ${kb(HARD_CAP_BYTES)})`,
);
for (const row of report) {
  console.log(
    `  ${row.file.padEnd(40)}  raw ${kb(row.rawBytes).padStart(10)}  gz ${kb(row.gzipBytes).padStart(10)}`,
  );
}
console.log(
  `  ${'TOTAL'.padEnd(40)}  ${''.padStart(15)}  gz ${kb(total).padStart(10)}`,
);

if (total > HARD_CAP_BYTES) {
  console.error(
    `[check-bundle-size] FAIL (hard cap) — gzipped total ${kb(total)} exceeds ${kb(HARD_CAP_BYTES)}. This is the MVP design note's kill-switch trigger; read §6.3 + §8.4 before widening.`,
  );
  process.exit(1);
}

if (total > STRESS_CAP_BYTES) {
  console.error(
    `[check-bundle-size] FAIL (stress cap) — gzipped total ${kb(total)} exceeds ${kb(STRESS_CAP_BYTES)}. Tree-shake or drop an import; lift the stress cap only when §8.4 says so. (Hard cap ${kb(HARD_CAP_BYTES)} still holds.)`,
  );
  process.exit(1);
}

console.log(
  `[check-bundle-size] PASS — ${kb(total)} / ${kb(STRESS_CAP_BYTES)} stress (${Math.round(
    (total / STRESS_CAP_BYTES) * 100,
  )}%) · ${kb(HARD_CAP_BYTES)} hard (${Math.round(
    (total / HARD_CAP_BYTES) * 100,
  )}%).`,
);
