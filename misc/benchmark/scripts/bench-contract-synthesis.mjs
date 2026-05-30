// oss/misc/benchmark/scripts/bench-contract-synthesis.mjs
//
// Contract-synthesis convergence benchmark CLI.
//
// Measures how quickly the REAL `synthesizeContract` (@ggui-ai/negotiator)
// converges on a spec-conforming DataContract — the pre-UI-gen step — across
// the SAME three models the ui-gen bench uses.
//
//   pnpm --filter @ggui-ai/benchmark bench:contract
//   pnpm --filter @ggui-ai/benchmark bench:contract -p claude
//   pnpm --filter @ggui-ai/benchmark bench:contract -p claude,openai,google
//   pnpm --filter @ggui-ai/benchmark bench:contract --case repair-redundant-action
//   pnpm --filter @ggui-ai/benchmark bench:contract -n 3   # avg over 3 runs/case
//
// Reuses the production LLM path: `buildLlmCaller` (the exact factory the OSS
// server hands to the negotiator) → `synthesizeContract`. No reimplementation.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARKS_DIR = resolve(__dirname, '..');
// Sibling packages under oss/packages (dev) — same resolution bench.mjs uses.
const WORKSPACE_ROOT = resolve(BENCHMARKS_DIR, '../../..');
const MCP_SERVER_DIR = resolve(BENCHMARKS_DIR, '../../packages/mcp-server');

// ── Minimal .env loader (mirrors bench.mjs) ─────────────────────────────
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf-8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvFile(resolve(WORKSPACE_ROOT, '.env'));
loadEnvFile(resolve(WORKSPACE_ROOT, '.env.local'));

// ── Args ────────────────────────────────────────────────────────────────
function getArg(flags, fallback) {
  for (const f of flags) {
    const i = process.argv.indexOf(f);
    if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  }
  return fallback;
}
const hasFlag = (f) => process.argv.includes(f);

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`Contract-Synthesis Convergence Benchmark

Usage:
  bench:contract                       # all 3 models, full corpus
  bench:contract -p claude             # one provider
  bench:contract -p claude,openai,google
  bench:contract --case <id>           # single case
  bench:contract --mode cold|repair    # one half of the corpus
  bench:contract -n 3                  # repeat each case N times (avg out LLM noise)

Options:
  --provider, -p   claude, openai, google (comma-separated)   [default: all 3]
  --case           run only the case with this id
  --mode           cold | repair                              [default: both]
  -n               runs per case                              [default: 1]
  --help, -h
`);
  process.exit(0);
}

// Same three models as the ui-gen bench (DEFAULT_MODELS), in LlmRoute form.
const MODELS = {
  claude: 'anthropic/claude-haiku-4-5-20251001',
  openai: 'openai/gpt-5.4-mini',
  google: 'gemini/gemini-3.1-flash-lite',
};
const KEY_ENV = {
  claude: () => process.env.ANTHROPIC_API_KEY,
  openai: () => process.env.OPENAI_API_KEY,
  google: () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
};

const providers = (getArg(['--provider', '-p'], 'claude,openai,google'))
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);
const caseFilter = getArg(['--case'], null);
const modeFilter = getArg(['--mode'], null);
const runsPerCase = Math.max(1, Number(getArg(['-n'], '1')) || 1);
const via = getArg(['--via'], 'ensure');
if (via !== 'ensure' && via !== 'synth') {
  console.error(`--via must be 'ensure' or 'synth' (got '${via}')`);
  process.exit(1);
}

const run = async () => {
  // Path-import the TS modules via the tsx loader (same trick as bench.mjs).
  const { parseAnyLlmRoute } = await import(
    resolve(WORKSPACE_ROOT, 'oss/packages/protocol/src/types/llm-route.ts')
  );
  const { buildLlmCaller } = await import(
    resolve(MCP_SERVER_DIR, 'src/llm-backed-negotiator.ts')
  );
  const { CONTRACT_SYNTH_CORPUS } = await import(
    resolve(BENCHMARKS_DIR, 'src/contract-synthesis/corpus.ts')
  );
  const { runModel } = await import(
    resolve(BENCHMARKS_DIR, 'src/contract-synthesis/runner.ts')
  );
  const { buildReport, renderReport } = await import(
    resolve(BENCHMARKS_DIR, 'src/contract-synthesis/reporter.ts')
  );

  // Select corpus.
  let corpus = CONTRACT_SYNTH_CORPUS;
  if (caseFilter) corpus = corpus.filter((c) => c.id === caseFilter);
  if (modeFilter) corpus = corpus.filter((c) => c.mode === modeFilter);
  if (corpus.length === 0) {
    console.error(`No cases match (case=${caseFilter} mode=${modeFilter}).`);
    process.exit(1);
  }
  // Expand by -n.
  const cases =
    runsPerCase === 1
      ? corpus
      : corpus.flatMap((c) =>
          Array.from({ length: runsPerCase }, (_unused, i) => ({
            ...c,
            id: `${c.id}#${i + 1}`,
          })),
        );

  console.log('┌─────────────────────────────────────────────┐');
  console.log('│   Contract-Synthesis Convergence Benchmark   │');
  console.log('└─────────────────────────────────────────────┘');
  console.log(`  Providers:  ${providers.join(', ')}`);
  console.log(`  Cases:      ${corpus.length}${runsPerCase > 1 ? ` × ${runsPerCase} runs` : ''}`);
  console.log(`  Path:       ${via}${via === 'ensure' ? ' (production-faithful: normalize + draftFindings)' : ' (raw synthesizeContract loop)'}`);
  console.log(`  Conformance gate: lintContract (deterministic)`);
  console.log('');

  const allResults = [];
  for (const provider of providers) {
    const routeStr = MODELS[provider];
    if (!routeStr) {
      console.log(`  ⚠ unknown provider '${provider}' — skipping`);
      continue;
    }
    const apiKey = KEY_ENV[provider]?.();
    if (!apiKey) {
      console.log(`  ⚠ ${provider}: no API key in env — skipping`);
      continue;
    }
    const route = parseAnyLlmRoute(routeStr);
    if (!route) {
      console.log(`  ⚠ ${provider}: could not parse route '${routeStr}' — skipping`);
      continue;
    }
    // LlmSelection = LlmRoute & {optional inference params}; LlmRoute is
    // assignable directly. providerKey.provider must be the route provider.
    const providerKey = { provider: route.provider, key: apiKey };
    const llm = buildLlmCaller(route, providerKey);

    process.stdout.write(`  Running ${provider} (${route.model})... `);
    const started = Date.now();
    const rows = await runModel(llm, route.model, provider, cases, via);
    allResults.push(...rows);
    const conv = rows.filter((r) => r.converged).length;
    console.log(`done ${conv}/${rows.length} converged in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  if (allResults.length === 0) {
    console.error('\nNo runs executed (no providers had keys?).');
    process.exit(1);
  }

  // Stamp timestamp here (Date is fine in the CLI, unlike workflow scripts).
  const timestamp = new Date().toISOString();
  const report = buildReport(allResults, via, timestamp);
  console.log(renderReport(report));

  const outDir = resolve(BENCHMARKS_DIR, 'benchmark-results');
  mkdirSync(outDir, { recursive: true });
  const stamp = timestamp.replace(/[:.]/g, '-');
  const outPath = resolve(outDir, `contract-synthesis-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`  Report saved: ${outPath}\n`);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
