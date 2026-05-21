#!/usr/bin/env node
// SLO v0 entry point — runs each corpus case n times, writes JSON,
// prints summary. CLI flags are intentionally minimal (see README).
//
//   --runs <n>    runs per case (default: 3)
//   --cases <csv> subset of case ids (default: all)

import { runSloCase } from '../src/slo/runner.ts';
import { SLO_V0_CASES } from '../src/slo/corpus.ts';
import {
  formatReportTable,
  writeReport,
} from '../src/slo/reporter.ts';

function parseArgs(argv) {
  const args = { runs: 3, cases: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') args.runs = Number(argv[++i]);
    else if (a === '--cases') args.cases = String(argv[++i]).split(',');
  }
  if (!Number.isFinite(args.runs) || args.runs < 1) {
    throw new Error(`--runs must be a positive integer, got ${args.runs}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const selected = args.cases
    ? SLO_V0_CASES.filter((c) => args.cases.includes(c.id))
    : SLO_V0_CASES;
  if (selected.length === 0) {
    throw new Error(`no matching cases for --cases=${args.cases?.join(',')}`);
  }

  console.log(
    `[slo-v0] running ${selected.length} case(s) × ${args.runs} run(s) = ${selected.length * args.runs} total`,
  );

  const results = [];
  for (const kase of selected) {
    for (let i = 0; i < args.runs; i++) {
      const r = await runSloCase(kase, i);
      results.push(r);
      if (r.errors.length > 0) {
        console.warn(`  [${kase.id} #${i}] errors: ${r.errors.join('; ')}`);
      }
    }
  }

  const { path, report } = writeReport(results);
  console.log();
  console.log(formatReportTable(report));
  console.log();
  console.log(`[slo-v0] wrote ${path}`);
}

main().catch((err) => {
  console.error('[slo-v0] fatal:', err);
  process.exit(1);
});
