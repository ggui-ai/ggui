#!/usr/bin/env node
// bench:baseline-diff-triage — classify a `bench-baseline-diff.v0`
// JSON into alert / notice / suppressed / informational buckets.
//
// Usage:
//   pnpm bench:baseline-diff-triage <diff.json>
//   pnpm bench:baseline-diff-triage --out <path> <diff.json>
//
// Exit codes:
//   0 — valid invocation, zero alerts (PASS)
//   1 — valid invocation, ≥ 1 alert (FAIL)
//   2 — invocation error (missing file, malformed JSON, unsupported schema)
//
// Discipline:
//   - Exit 1 is RESERVED for real semantic regressions (any alert).
//   - Exit 2 is tooling/invocation problems. CI code that treats
//     non-zero uniformly will still work but loses the distinction.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { triageDiff } from '../src/baseline-diff-triage/triage.ts';
import {
  formatTriageTable,
  writeTriage,
} from '../src/baseline-diff-triage/reporter.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function printHelp() {
  console.log(
    'Usage: pnpm bench:baseline-diff-triage [--out <path>] <diff.json>',
  );
  console.log('');
  console.log('Classify a baseline-diff JSON into severity buckets.');
  console.log('');
  console.log('Exit codes:');
  console.log('  0  zero alerts (PASS)');
  console.log('  1  one or more alerts (FAIL)');
  console.log('  2  invocation error');
}

function parseArgs(argv) {
  const args = { out: null, input: null };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`[baseline-diff-triage] unknown flag: ${a}`);
      process.exit(2);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) {
    console.error(
      '[baseline-diff-triage] expected exactly 1 positional arg: <diff.json>',
    );
    printHelp();
    process.exit(2);
  }
  args.input = resolve(positional[0]);
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  if (!existsSync(args.input)) {
    console.error(`[baseline-diff-triage] diff file not found: ${args.input}`);
    process.exit(2);
  }

  let diff;
  try {
    const raw = readFileSync(args.input, 'utf8');
    diff = JSON.parse(raw);
  } catch (e) {
    console.error(
      `[baseline-diff-triage] failed to parse diff JSON: ${e.message}`,
    );
    process.exit(2);
  }

  let report;
  try {
    report = triageDiff(diff);
  } catch (e) {
    console.error(`[baseline-diff-triage] triage failed: ${e.message}`);
    process.exit(2);
  }

  const outputPath =
    args.out ??
    resolve(
      REPO_ROOT,
      'tmp-bench-logs',
      `triage-${basename(args.input, '.json')}.json`,
    );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeTriage(report, outputPath);

  console.log(formatTriageTable(report));
  console.log();
  console.log(`[baseline-diff-triage] wrote ${outputPath}`);

  process.exit(report.decision === 'fail' ? 1 : 0);
}

main();
