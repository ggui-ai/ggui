#!/usr/bin/env node
// A2UI v0 entry — runs each corpus case n times, writes JSON,
// prints compact summary. CLI flags deliberately minimal.
//
//   --runs <n>    runs per case (default: 3)
//   --cases <csv> subset of case ids (default: all)

import { runA2uiCase } from '../src/a2ui/runner.ts';
import { A2UI_V0_CASES } from '../src/a2ui/corpus.ts';
import {
  formatA2uiTable,
  writeA2uiReport,
} from '../src/a2ui/reporter.ts';

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
    ? A2UI_V0_CASES.filter((c) => args.cases.includes(c.id))
    : A2UI_V0_CASES;
  if (selected.length === 0) {
    throw new Error(`no matching cases for --cases=${args.cases?.join(',')}`);
  }

  console.log(
    `[a2ui-v0] running ${selected.length} case(s) × ${args.runs} run(s) = ${selected.length * args.runs} total`,
  );

  const results = [];
  for (const kase of selected) {
    for (let i = 0; i < args.runs; i++) {
      const r = await runA2uiCase(kase, i);
      results.push(r);
      if (r.errors.length > 0) {
        console.warn(`  [${kase.id} #${i}] errors: ${r.errors.join('; ')}`);
      }
      if (r.frames.parseFailCount > 0) {
        console.warn(
          `  [${kase.id} #${i}] parse fails: ${r.frames.parseFailCount}/${r.frames.frameCount} — samples: ${r.parseIssueSamples.join(' | ')}`,
        );
      }
    }
  }

  const { path, report } = writeA2uiReport(results);
  console.log();
  console.log(formatA2uiTable(report));
  console.log();
  console.log(`[a2ui-v0] wrote ${path}`);
}

main().catch((err) => {
  console.error('[a2ui-v0] fatal:', err);
  process.exit(1);
});
