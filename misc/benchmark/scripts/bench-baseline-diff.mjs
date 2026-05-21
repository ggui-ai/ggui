#!/usr/bin/env node
// bench:baseline-diff — compare two baseline bundles and emit one
// honest diff report.
//
// Usage:
//   pnpm bench:baseline-diff <before-bundle> <after-bundle>
//   pnpm bench:baseline-diff --out <path> <before> <after>
//
// Exit codes:
//   0 — valid invocation (diff printed + JSON written, regardless of
//       whether the after-bundle shows regressions)
//   1 — invalid invocation (missing args, unreadable bundle, malformed
//       manifest)
//
// Design: semantic regressions are in the output JSON, NEVER in the
// exit code. CI wiring decides what to do with `statusChange: regressed`
// entries; this tool is a reporting layer, not a gate.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffManifests, loadBundle } from '../src/baseline-diff/diff.ts';
import {
  formatDiffTable,
  writeDiff,
} from '../src/baseline-diff/reporter.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const args = { out: null, before: null, after: null };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      args.out = argv[++i];
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`[baseline-diff] unknown flag: ${a}`);
      process.exit(1);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) {
    console.error(
      '[baseline-diff] expected exactly 2 positional args: <before-bundle> <after-bundle>',
    );
    printHelp();
    process.exit(1);
  }
  args.before = resolve(positional[0]);
  args.after = resolve(positional[1]);
  return args;
}

function printHelp() {
  console.log('Usage: pnpm bench:baseline-diff [--out <path>] <before-bundle> <after-bundle>');
  console.log('');
  console.log('Compares two baseline bundles produced by `bench:baseline`.');
  console.log('Writes a JSON diff + prints a compact console table.');
  console.log('');
  console.log('Exit codes: 0 on valid invocation, 1 on invalid args or unreadable bundles.');
  console.log('Semantic regressions are recorded in the JSON, NOT the exit code.');
}

function main() {
  const args = parseArgs(process.argv);

  if (!existsSync(args.before)) {
    console.error(`[baseline-diff] before bundle not found: ${args.before}`);
    process.exit(1);
  }
  if (!existsSync(args.after)) {
    console.error(`[baseline-diff] after bundle not found: ${args.after}`);
    process.exit(1);
  }

  let before;
  let after;
  try {
    before = loadBundle(args.before);
  } catch (e) {
    console.error(`[baseline-diff] before bundle failed to load: ${e.message}`);
    process.exit(1);
  }
  try {
    after = loadBundle(args.after);
  } catch (e) {
    console.error(`[baseline-diff] after bundle failed to load: ${e.message}`);
    process.exit(1);
  }

  const diff = diffManifests({ before, after });

  const outputPath =
    args.out ??
    resolve(
      REPO_ROOT,
      'tmp-bench-logs',
      `diff-${basename(args.before)}-vs-${basename(args.after)}.json`,
    );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeDiff(diff, outputPath);

  console.log(formatDiffTable(diff));
  console.log();
  console.log(`[baseline-diff] wrote ${outputPath}`);

  // ALWAYS exit 0 on a valid invocation. Regressions live in the JSON;
  // CI decides what to do with them.
}

main();
