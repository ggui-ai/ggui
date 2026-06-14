#!/usr/bin/env node

/**
 * CLI Benchmark Runner
 *
 * The variant matrix is the canonical 3-tier × 3-provider grid defined in
 * `src/multi-sdk/variants.ts#getDefaultVariants()` — 9 cells, each pinned to
 * a real per-tier SKU. `--provider` and `--tier` SUBSET this grid; they do
 * NOT synthesize ad-hoc variants. The nightly run passes neither, so it runs
 * the full 9-cell matrix.
 *
 * Usage:
 *   pnpm bench                                          # defaults: google, weather-card
 *   pnpm bench --commit weather-card                    # all 9 matrix cells, one commit
 *   pnpm bench --provider claude --commit survey-form   # claude's 3 tiers
 *   pnpm bench --tier fast --commit kanban-board        # fast tier across all 3 providers
 *   pnpm bench --provider google,claude --commit weather-card,survey-form
 *   pnpm bench --preset quick         # google flash-lite, weather-card
 *   pnpm bench --preset full          # all providers, all commits
 *
 * Options:
 *   --provider, -p   Provider(s): claude, openai, google (comma-separated).
 *                    Subsets the matrix by SDK. Default: all three.
 *   --tier           Tier(s): fast, balanced, premium (comma-separated).
 *                    Subsets the matrix by tier. Default: all three.
 *   --commit, -c     Commit ID(s): weather-card, survey-form, etc. (comma-separated)
 *   --model, -m      IGNORED when running the matrix — the per-tier SKUs are
 *                    the point of the grid, so a single coding-model override
 *                    would flatten every tier onto one model. Kept only as a
 *                    no-op alias for back-compat / preset wiring.
 *   --think          Model override for planning phase
 *   --eval           Model override for the IN-LOOP evaluation agent (LLM eval
 *                    rounds + eval-fix). Does NOT change the post-gen aesthetic
 *                    judge — that is pinned and disclosed in the report's
 *                    meta.judge (see src/multi-sdk/post-eval.ts).
 *   --max-turns      Max coding attempts (default: 30)
 *   --max-eval       Max evaluation rounds (default: 3)
 *   --timeout        Timeout in ms (default: 300000)
 *   --threshold      Pass threshold 0-100 (default: 70)
 *   --no-eval        Skip ALL evaluation: zeroes in-loop eval rounds AND skips
 *                    the post-gen aesthetic judge (no Anthropic call, no score)
 *   --visual         Enable in-loop visual evaluation (screenshot + multimodal
 *                    LLM scoring during eval rounds). The visual judge is the
 *                    in-loop evaluation agent (--eval), not a separate model.
 *   --quality        Quality mode: fast (default), auto-improve, high-quality
 *   --preset         Named preset: quick, full, coding-agent
 *   --list           List available commits and exit
 *   --help, -h       Show help
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Two layouts to support — script must work in both:
//   1. Workspace dev:    scripts/ is at packages/benchmark/scripts/
//                        BENCHMARKS_DIR = packages/benchmark
//                        UI_GEN_DIR    = packages/ui-gen (sibling)
//   2. Container deploy: scripts/ is at /app/scripts/ (pnpm deploy flattened)
//                        BENCHMARKS_DIR = /app
//                        UI_GEN_DIR    = /app/node_modules/@ggui-ai/ui-gen
//
// Resolution: BENCHMARKS_DIR is always `scripts/..`. UI_GEN_DIR tries the
// workspace-sibling path first, falls back to the deployed node_modules path.
const BENCHMARKS_DIR = resolve(__dirname, '..');
const SIBLING_UI_GEN = resolve(BENCHMARKS_DIR, '../ui-gen');
const NODE_MODULES_UI_GEN = resolve(
  BENCHMARKS_DIR,
  'node_modules/@ggui-ai/ui-gen',
);
const UI_GEN_DIR = existsSync(SIBLING_UI_GEN) ? SIBLING_UI_GEN : NODE_MODULES_UI_GEN;
// WORKSPACE_ROOT only matters for .env loading; pick whichever layout
// resolves to a real directory containing `.env`.
const WORKSPACE_ROOT = existsSync(SIBLING_UI_GEN)
  ? resolve(BENCHMARKS_DIR, '../..')
  : BENCHMARKS_DIR;

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(names, defaultValue) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i]) && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return defaultValue;
}

function hasFlag(names) {
  return args.some(a => names.includes(a));
}

if (hasFlag(['--help', '-h'])) {
  // Print the docstring from the top of this file
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf-8');
  const docMatch = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (docMatch) console.log(docMatch[1].replace(/^ \* ?/gm, '').trim());
  process.exit(0);
}

if (hasFlag(['--list'])) {
  // Derived from BENCHMARK_COMMITS so the list never drifts from the
  // actual fixtures (a hand-maintained list previously omitted the
  // gadget commits and mislabelled kanban-board).
  const { BENCHMARK_COMMITS } = await import(
    resolve(BENCHMARKS_DIR, 'src/multi-sdk/commits.ts')
  );
  console.log('Available commits:');
  for (const c of BENCHMARK_COMMITS) {
    console.log(`  ${c.id.padEnd(18)} ${c.description ?? ''}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const PRESETS = {
  quick: {
    providers: ['google'],
    commits: ['weather-card'],
    model: 'gemini/gemini-3.1-flash-lite',
    maxAttempts: 5,
    maxEvalRounds: 0,
    timeout: 120000,
  },
  'coding-agent': {
    providers: ['google'],
    commits: ['weather-card'],
    model: 'gemini/gemini-3-flash-preview',
    maxAttempts: 10,
    maxEvalRounds: 0,
    timeout: 300000,
  },
  full: {
    providers: ['claude', 'openai', 'google'],
    // Every benchmark commit — includes the two gadget commits
    // (leaflet-map: registered <LeafletMap> component gadget;
    // revenue-chart: <Chart> component + useChartTheme hook gadget)
    // so a "full" run measures gadget generation, not just
    // design-system primitives.
    commits: [
      'weather-card',
      'survey-form',
      'kanban-board',
      'periodic-table',
      'product-page',
      'chat-interface',
      'stock-ticker',
      'onboarding-wizard',
      'leaflet-map',
      'revenue-chart',
    ],
    maxAttempts: 15,
    maxEvalRounds: 3,
    timeout: 600000,
  },
};

const presetName = getArg(['--preset'], null);
const preset = presetName ? PRESETS[presetName] : null;

if (presetName && !preset) {
  console.error(`Unknown preset: ${presetName}. Available: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build config
// ---------------------------------------------------------------------------

const providers = (getArg(['--provider', '-p'], null) || preset?.providers?.join(',') || 'google').split(',');
// Tier subset of the matrix. Default = all three tiers (the full grid).
const tiers = (getArg(['--tier'], null) || 'fast,balanced,premium').split(',');
const commits = (getArg(['--commit', '-c'], null) || preset?.commits?.join(',') || 'weather-card').split(',');
// --model is intentionally a no-op when running the matrix — the per-tier
// SKUs from getDefaultVariants() are the point of the grid. Parsed only so
// preset wiring / old invocations don't error; never injected into variants.
const codingModel = getArg(['--model', '-m'], preset?.model || null);
const thinkModel = getArg(['--think'], null);
const evalModel = getArg(['--eval'], null);
const maxAttempts = parseInt(getArg(['--max-turns'], String(preset?.maxAttempts ?? 30)), 10);
// --no-eval kills BOTH evaluation surfaces: the in-loop eval rounds
// (maxEvalRounds=0) and the post-gen aesthetic judge (skipEvaluation).
// Pre-fix it only zeroed the rounds, so the judge still ran + billed.
const skipEvaluation = hasFlag(['--no-eval']);
const maxEvalRounds = skipEvaluation ? 0 : parseInt(getArg(['--max-eval'], String(preset?.maxEvalRounds ?? 3)), 10);
const timeoutMs = parseInt(getArg(['--timeout'], String(preset?.timeout ?? 300000)), 10);
const passThreshold = parseInt(getArg(['--threshold'], '70'), 10);
const visualEnabled = hasFlag(['--visual']);
const qualityMode = getArg(['--quality'], 'fast');

// Harness selector retired 2026-04-27 (Step 4 of the cloud→OSS
// migration). Pre-step-4 the bench dual-routed through cloud's hardened
// `dispatchGeneration` OR the bare `createUiGenerator` via a `--harness`
// flag. After Step 3's wholesale move, both implementations live in
// `@ggui-ai/ui-gen` and the n=3 bench confirmed the bare path is ~half
// as good (76% valid-gen / 19% score≥70 vs hardened 92% / ~70%). One
// canonical bench path now: `dispatchGeneration` from
// `@ggui-ai/ui-gen/adapters/generation-dispatch`.

// Role overrides applied to EVERY matrix variant. `coding` is deliberately
// excluded — the per-tier SKU (variant.modelId) IS the coding model, and
// letting --model override it would collapse the grid. --think (planning)
// and --eval (in-loop evaluation agent) are orthogonal roles, so they layer
// on without flattening the tiers.
const sharedModelRoles = {};
if (thinkModel) sharedModelRoles.thinking = thinkModel;
if (evalModel) sharedModelRoles.evaluation = evalModel;

// ---------------------------------------------------------------------------
// Display config
// ---------------------------------------------------------------------------

console.log('\n┌─────────────────────────────────────────────┐');
console.log('│           ggui Benchmark Runner              │');
console.log('└─────────────────────────────────────────────┘\n');
console.log(`  Providers:    ${providers.join(', ')}`);
console.log(`  Tiers:        ${tiers.join(', ')}`);
console.log(`  Commits:      ${commits.join(', ')}`);
if (codingModel) console.log(`  Coding model: ${codingModel} (IGNORED — matrix pins per-tier SKUs)`);
if (thinkModel) console.log(`  Think model:  ${thinkModel}`);
if (evalModel) console.log(`  In-loop eval model: ${evalModel} (post-gen judge stays pinned)`);
console.log(`  Max turns:    ${maxAttempts}`);
console.log(`  Eval rounds:  ${maxEvalRounds}`);
if (skipEvaluation) console.log(`  Evaluation:   SKIPPED (--no-eval: no eval rounds, no aesthetic judge)`);
console.log(`  Timeout:      ${timeoutMs}ms`);
console.log(`  Threshold:    ${passThreshold}`);
console.log(`  Quality:      ${qualityMode}`);
if (visualEnabled) console.log(`  Visual eval:  enabled (judge = in-loop evaluation agent)`);
console.log('');

// ---------------------------------------------------------------------------
// Load .env files (no dotenv dependency)
// ---------------------------------------------------------------------------

function loadEnvFile(filepath) {
  try {
    const content = readFileSync(filepath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* file not found — ok */ }
}

loadEnvFile(resolve(WORKSPACE_ROOT, '.env'));
loadEnvFile(resolve(WORKSPACE_ROOT, '.env.local'));

// ---------------------------------------------------------------------------
// Run directly via dynamic import (tsx loader)
// ---------------------------------------------------------------------------

// Bench imports cross two workspace packages:
//   * benchmark fixtures + harness corpora live in @ggui-ai/benchmark (this package)
//   * provider adapters live in @ggui-ai/ui-gen
// Use direct path resolution because tsx loader needs filesystem URLs.

const run = async () => {
  // Dynamic imports of TypeScript modules (via tsx loader)
  const { BenchmarkRunner } = await import(resolve(BENCHMARKS_DIR, 'src/multi-sdk/runner.ts'));
  const { LocalStorage } = await import(resolve(BENCHMARKS_DIR, 'src/multi-sdk/storage/local.ts'));
  const { BENCHMARK_COMMITS } = await import(resolve(BENCHMARKS_DIR, 'src/multi-sdk/commits.ts'));
  const { toDisplayReport } = await import(resolve(BENCHMARKS_DIR, 'src/multi-sdk/reporter.ts'));
  const { getDefaultVariants } = await import(resolve(BENCHMARKS_DIR, 'src/multi-sdk/variants.ts'));
  const {
    ClaudeRawAdapter,
    OpenAiRawAdapter,
    GoogleRawAdapter,
  } = await import(resolve(UI_GEN_DIR, 'src/adapters/index.ts'));

  // Build output dir and storage
  const outputDir = resolve(BENCHMARKS_DIR, 'benchmark-results');
  const storage = new LocalStorage(outputDir);
  // Append PID + provider + a 4-byte random suffix so concurrent invocations
  // (bench:n parallel cells, multiple operators) never collide on the same
  // report filename. Pre-fix, 9-cell parallel runs occasionally saw two
  // siblings write to the same `benchmark-<timestamp>.json` and one of them
  // got overwritten — losing an entire run's data invisibly.
  const tsStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const providerTag = providers.join('-');
  const uniq = `${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const reportId = `benchmark-${tsStamp}-${providerTag}-${uniq}`;

  // Build variants from the canonical 3-tier × 3-provider matrix, then
  // subset by --provider and --tier. The runner already does
  // `variants × commits`, so feeding it the full 9-cell grid "just works".
  // Apply --think / --eval role overrides (NOT --model: the per-tier SKU on
  // each variant IS the coding model; overriding it would flatten the grid).
  const hasSharedRoles = Object.keys(sharedModelRoles).length > 0;
  const variants = getDefaultVariants()
    .filter((v) => providers.includes(v.sdkName) && tiers.includes(v.tier))
    .map((v) => (hasSharedRoles ? { ...v, modelRoles: { ...v.modelRoles, ...sharedModelRoles } } : v));

  if (variants.length === 0) {
    console.error(`  ✗ No matrix cells for providers [${providers.join(', ')}] × tiers [${tiers.join(', ')}]`);
    console.error(`  Providers: claude, openai, google.  Tiers: fast, balanced, premium.`);
    process.exit(1);
  }

  console.log(`  Matrix cells: ${variants.length} (${variants.map((v) => v.id).join(', ')})`);
  console.log(`  Total runs:   ${variants.length * commits.length}\n`);

  // Filter commits — FAIL LOUDLY on unknown names. Previously the filter
  // silently dropped unmatched IDs, leading to "3/3 passed" on a 4-commit
  // request and hiding missing fixtures. Registered fixture drift (e.g.
  // flight-status.fixture.ts existing but never wired into commits.ts)
  // surfaces here rather than getting swallowed.
  const knownIds = new Set(BENCHMARK_COMMITS.map(c => c.id));
  const unknown = commits.filter(id => !knownIds.has(id));
  if (unknown.length > 0) {
    console.error(`  ✗ Unknown commit ID(s): ${unknown.join(', ')}`);
    console.error(`  Available: ${[...knownIds].sort().join(', ')}`);
    process.exit(1);
  }
  const selectedCommits = BENCHMARK_COMMITS.filter(c => commits.includes(c.id));
  if (selectedCommits.length === 0) {
    console.error(`  No matching commits for: ${commits.join(', ')}`);
    process.exit(1);
  }

  // Build runner
  const runner = new BenchmarkRunner({
    storage,
    concurrency: 36,
    timeoutMs,
    passThreshold,
    maxAttempts,
    maxEvalRounds,
    skipEvaluation,
    qualityMode,
    onProgress: (event) => {
      const pct = event.total ? Math.round((event.completed / event.total) * 100) : 0;
      console.log(`  [${pct}%] ${event.completed}/${event.total} ${event.message || ''}`);
    },
    ...(visualEnabled ? {
      visualEvaluation: {
        enabled: true,
        passThreshold: Math.max(passThreshold - 20, 60),
      },
    } : {}),
  });

  // Register adapters per provider
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
  const hasGeminiKey = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

  if (providers.includes('claude')) {
    if (!hasAnthropicKey) console.log('  WARNING: ANTHROPIC_API_KEY not set');
    const cfg = { apiKey: process.env.ANTHROPIC_API_KEY };
    runner.registerAdapter(new ClaudeRawAdapter(cfg), cfg);
  }

  if (providers.includes('openai')) {
    if (!hasOpenAiKey) console.log('  WARNING: OPENAI_API_KEY not set');
    const cfg = { apiKey: process.env.OPENAI_API_KEY };
    runner.registerAdapter(new OpenAiRawAdapter(cfg), cfg);
  }

  if (providers.includes('google')) {
    if (!hasGeminiKey) console.log('  WARNING: GEMINI_API_KEY not set');
    // Minimize Gemini 3.x Flash's default-on thinking — it dominates
    // UI-gen latency without improving contract-bounded code emission.
    // The Interactions API floor is 'minimal' (no true off). Override
    // via GGUI_BENCH_THINKING_LEVEL=low|medium|high. See
    // adapters/google/raw.ts.
    const cfg = {
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      thinkingLevel: process.env.GGUI_BENCH_THINKING_LEVEL || 'minimal',
    };
    runner.registerAdapter(new GoogleRawAdapter(cfg), cfg);
  }

  // Run benchmark
  const report = await runner.run({ variants, commits: selectedCommits });

  // Convert to display format and save. version = the runner image's build
  // SHA (Dockerfile sets ENV GIT_SHA); 'local' only for uncontainerized runs.
  const displayReport = toDisplayReport(report, reportId, process.env.GIT_SHA || 'local');

  // Extract compiled components from results
  const compiledComponents = new Map();
  for (const result of report.results) {
    if (result.generation?.compiledCode) {
      compiledComponents.set(
        `${result.variant.id}-${result.commit.id}`,
        {
          source: result.generation.sourceCode || '',
          compiled: result.generation.compiledCode,
        }
      );
    }
  }

  await storage.saveReport({ reportId, report: displayReport, compiledComponents });

  const { meta } = report;
  // successCount = generation produced output without erroring — not a
  // quality-threshold pass count.
  console.log(`\n  ✓ Complete! ${meta.successCount}/${meta.totalRuns} generated in ${(meta.totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`  Report: ${outputDir}/${reportId}.json`);
};

run().catch((err) => {
  console.error(`\n  ✗ ${err.message}\n`);
  process.exit(1);
});
