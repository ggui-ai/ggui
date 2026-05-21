#!/usr/bin/env node
// Blueprint-negotiation v0 entry — runs each labeled case n times,
// writes JSON, prints compact per-mode summary.
//
//   --runs <n>    runs per case (default: 3)
//   --cases <csv> subset of case ids (default: all)

import { runNegotiationCase } from '../src/blueprint-negotiation/runner.ts';
import { BLUEPRINT_NEGOTIATION_V0_CASES } from '../src/blueprint-negotiation/corpus.ts';
import {
  formatNegotiationTable,
  writeNegotiationReport,
} from '../src/blueprint-negotiation/reporter.ts';

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
    ? BLUEPRINT_NEGOTIATION_V0_CASES.filter((c) => args.cases.includes(c.id))
    : BLUEPRINT_NEGOTIATION_V0_CASES;
  if (selected.length === 0) {
    throw new Error(`no matching cases for --cases=${args.cases?.join(',')}`);
  }

  console.log(
    `[neg-v0] running ${selected.length} case(s) × ${args.runs} run(s) = ${selected.length * args.runs} total`,
  );

  const results = [];
  for (const kase of selected) {
    for (let i = 0; i < args.runs; i++) {
      const r = await runNegotiationCase(kase, i);
      results.push(r);
      if (r.errors.length > 0) {
        console.warn(`  [${kase.id} #${i}] errors: ${r.errors.join('; ')}`);
      }
      if (r.tags.observedOutcome === 'wrong_hit') {
        console.warn(
          `  [${kase.id} #${i}] wrong_hit: expected=${r.tags.expectedBlueprintId} observed=${r.tags.observedBlueprintId}`,
        );
      }
    }
  }

  const { path, report } = writeNegotiationReport(results);
  console.log();
  console.log(formatNegotiationTable(report));
  console.log();
  console.log(`[neg-v0] wrote ${path}`);
}

main().catch((err) => {
  console.error('[neg-v0] fatal:', err);
  process.exit(1);
});
