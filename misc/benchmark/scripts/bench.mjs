#!/usr/bin/env node

/**
 * CLI Benchmark Runner
 *
 * Usage:
 *   pnpm bench                                          # defaults: google, weather-card
 *   pnpm bench --provider google --model gemini-3.1-flash-lite-preview --commit weather-card
 *   pnpm bench --provider claude --commit survey-form
 *   pnpm bench --provider openai --commit kanban-board --max-turns 5
 *   pnpm bench --provider google,claude --commit weather-card,survey-form
 *   pnpm bench --preset quick         # google flash-lite, weather-card
 *   pnpm bench --preset full          # all providers, all commits
 *
 * Options:
 *   --provider, -p   Provider(s): claude, openai, google (comma-separated)
 *   --commit, -c     Commit ID(s): weather-card, survey-form, etc. (comma-separated)
 *   --model, -m      Model override for coding phase (e.g., gemini-3.1-flash-lite-preview)
 *   --think          Model override for planning phase
 *   --eval           Model override for evaluation phase
 *   --max-turns      Max coding attempts (default: 10)
 *   --max-eval       Max evaluation rounds (default: 3)
 *   --timeout        Timeout in ms (default: 300000)
 *   --threshold      Pass threshold 0-100 (default: 70)
 *   --no-eval        Skip evaluation phase
 *   --visual         Enable visual evaluation (screenshot + multimodal LLM scoring)
 *   --visual-provider  Provider for visual eval: claude or google (default: google)
 *   --visual-model   Model override for visual evaluation
 *   --quality        Quality mode: fast (default), auto-improve, high-quality
 *   --preset         Named preset: quick, full, coding-agent
 *   --floor          Floor: oss (default), hosted, both — OSS vs hosted ui-gen path
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
    model: 'google/gemini-3.1-flash-lite-preview',
    maxAttempts: 5,
    maxEvalRounds: 0,
    timeout: 120000,
  },
  'coding-agent': {
    providers: ['google'],
    commits: ['weather-card'],
    model: 'google/gemini-3-flash-preview',
    maxAttempts: 10,
    maxEvalRounds: 0,
    timeout: 300000,
  },
  full: {
    providers: ['claude', 'openai', 'google'],
    // Every benchmark commit — includes the gadget commits
    // (kanban-board / chat-interface hook gadgets, leaflet-map /
    // revenue-chart component gadgets) so a "full" run measures
    // gadget generation, not just design-system primitives.
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
const commits = (getArg(['--commit', '-c'], null) || preset?.commits?.join(',') || 'weather-card').split(',');
const codingModel = getArg(['--model', '-m'], preset?.model || null);
const thinkModel = getArg(['--think'], null);
const evalModel = getArg(['--eval'], null);
const maxAttempts = parseInt(getArg(['--max-turns'], String(preset?.maxAttempts ?? 30)), 10);
const maxEvalRounds = hasFlag(['--no-eval']) ? 0 : parseInt(getArg(['--max-eval'], String(preset?.maxEvalRounds ?? 3)), 10);
const timeoutMs = parseInt(getArg(['--timeout'], String(preset?.timeout ?? 300000)), 10);
const passThreshold = parseInt(getArg(['--threshold'], '70'), 10);
const visualEnabled = hasFlag(['--visual']);
const visualProvider = getArg(['--visual-provider'], 'google');
const visualModel = getArg(['--visual-model'], null);
const qualityMode = getArg(['--quality'], 'fast');

// Floor split (ui-gen bench OSS vs hosted). Default preserves today's
// identical-to-pre-split behavior — OSS floor with no predefined tool.
// `hosted` opts into the v0 divergence (predefined-components tool wired).
// `both` runs every variant twice, once per floor, so the report's
// `floorSummaries` shows side-by-side numbers.
const floorRaw = getArg(['--floor'], 'oss');
const FLOOR_VALUES = ['oss', 'hosted', 'both'];
if (!FLOOR_VALUES.includes(floorRaw)) {
  console.error(`Unknown --floor value: ${floorRaw}. Allowed: ${FLOOR_VALUES.join(', ')}`);
  process.exit(1);
}
const floorsRequested = floorRaw === 'both' ? ['oss', 'hosted'] : [floorRaw];

// Harness selector retired 2026-04-27 (Step 4 of the cloud→OSS
// migration). Pre-step-4 the bench dual-routed through cloud's hardened
// `dispatchGeneration` OR the bare `createUiGenerator` via a `--harness`
// flag. After Step 3's wholesale move, both implementations live in
// `@ggui-ai/ui-gen` and the n=3 bench confirmed the bare path is ~half
// as good (76% valid-gen / 19% score≥70 vs hardened 92% / ~70%). One
// canonical bench path now: `dispatchGeneration` from
// `@ggui-ai/ui-gen/adapters/generation-dispatch`.

// Build model combos per provider
const modelCombos = {};
for (const provider of providers) {
  const combo = { id: '1', enabled: true, thinking: '', coding: '', evaluation: '' };
  if (thinkModel) combo.thinking = thinkModel;
  if (codingModel) combo.coding = codingModel;
  if (evalModel) combo.evaluation = evalModel;
  modelCombos[provider] = [combo];
}

// ---------------------------------------------------------------------------
// Display config
// ---------------------------------------------------------------------------

console.log('\n┌─────────────────────────────────────────────┐');
console.log('│           ggui Benchmark Runner              │');
console.log('└─────────────────────────────────────────────┘\n');
console.log(`  Providers:    ${providers.join(', ')}`);
console.log(`  Commits:      ${commits.join(', ')}`);
if (codingModel) console.log(`  Coding model: ${codingModel}`);
if (thinkModel) console.log(`  Think model:  ${thinkModel}`);
if (evalModel) console.log(`  Eval model:   ${evalModel}`);
console.log(`  Max turns:    ${maxAttempts}`);
console.log(`  Eval rounds:  ${maxEvalRounds}`);
console.log(`  Timeout:      ${timeoutMs}ms`);
console.log(`  Threshold:    ${passThreshold}`);
console.log(`  Quality:      ${qualityMode}`);
if (visualEnabled) console.log(`  Visual eval:  ${visualProvider}${visualModel ? ` (${visualModel})` : ''}`);
console.log('');

const totalRuns = providers.length * commits.length;
console.log(`  Total runs: ${totalRuns}\n`);

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

const DEFAULT_MODELS = {
  claude: 'anthropic/claude-haiku-4-5',
  openai: 'openai/gpt-5.4-mini',
  google: 'google/gemini-3.1-flash-lite-preview',
  openrouter: 'openrouter/anthropic/claude-haiku-4-5',
};

const SCREEN_MAP = {
  'mobile-chat': { device: 'mobile', shell: 'chat', viewport: { width: 390, height: 844 } },
  'mobile-fullscreen': { device: 'mobile', shell: 'fullscreen', viewport: { width: 390, height: 844 } },
  'tablet-chat': { device: 'tablet', shell: 'chat', viewport: { width: 768, height: 1024 } },
  'tablet-fullscreen': { device: 'tablet', shell: 'fullscreen', viewport: { width: 768, height: 1024 } },
  'desktop-chat': { device: 'desktop', shell: 'chat', viewport: { width: 1440, height: 900 } },
  'desktop-fullscreen': { device: 'desktop', shell: 'fullscreen', viewport: { width: 1440, height: 900 } },
  'none': null,
};

const run = async () => {
  // Dynamic imports of TypeScript modules (via tsx loader)
  const { BenchmarkRunner } = await import(resolve(BENCHMARKS_DIR, 'src/multi-sdk/runner.ts'));
  const { LocalStorage } = await import(resolve(BENCHMARKS_DIR, 'src/multi-sdk/storage/local.ts'));
  const { BENCHMARK_COMMITS } = await import(resolve(BENCHMARKS_DIR, 'src/multi-sdk/commits.ts'));
  const { toDisplayReport } = await import(resolve(BENCHMARKS_DIR, 'src/multi-sdk/reporter.ts'));
  const { applyFloor } = await import(resolve(BENCHMARKS_DIR, 'src/multi-sdk/variants.ts'));
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

  // Build variants (provider x screen combos)
  const screens = ['none'];
  const variants = [];
  let variantIndex = 0;

  for (const provider of providers) {
    const combo = modelCombos[provider]?.[0] || { id: 'default', enabled: true, thinking: '', coding: '', evaluation: '' };

    for (const screenId of screens) {
      const rendering = SCREEN_MAP[screenId] || undefined;
      const modelId = DEFAULT_MODELS[provider];
      const id = `${provider}${screenId !== 'none' ? `-${screenId}` : ''}-${variantIndex++}`;

      const variant = {
        id,
        sdkName: provider,
        tier: 'balanced',
        modelId,
        rendering: rendering || undefined,
      };

      // Add model role overrides
      const roles = {};
      if (combo.thinking) roles.thinking = combo.thinking;
      if (combo.coding) roles.coding = combo.coding;
      if (combo.evaluation) roles.evaluation = combo.evaluation;
      if (Object.keys(roles).length > 0) {
        variant.modelRoles = roles;
      }

      variants.push(variant);
    }
  }

  // Apply floor split. When `oss` is the only floor (default), pass
  // floor=undefined to `applyFloor` — that preserves pre-floor variant
  // ids for continuity with historical reports. When ANY explicit
  // floor is requested (including `--floor oss`), we tag+suffix.
  const shouldTagFloors = floorRaw !== 'oss'; // default path stays untagged
  const flooredVariants = shouldTagFloors
    ? floorsRequested.flatMap((f) => applyFloor(variants, f))
    : variants;
  // Runner reads variant.floor (or DEFAULT_BENCHMARK_FLOOR = 'oss') —
  // the default-oss branch above therefore still produces floor='oss'
  // on every result, just without the id suffix.

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
    qualityMode,
    onProgress: (event) => {
      const pct = event.total ? Math.round((event.completed / event.total) * 100) : 0;
      console.log(`  [${pct}%] ${event.completed}/${event.total} ${event.message || ''}`);
    },
    ...(visualEnabled ? {
      visualEvaluation: {
        enabled: true,
        provider: visualProvider,
        model: visualModel,
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
    const cfg = { apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY };
    runner.registerAdapter(new GoogleRawAdapter(cfg), cfg);
  }

  // Run benchmark
  const report = await runner.run({ variants: flooredVariants, commits: selectedCommits });

  // Convert to display format and save
  const displayReport = toDisplayReport(report, reportId, 'local');

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
  console.log(`\n  ✓ Complete! ${meta.successCount}/${meta.totalRuns} passed in ${(meta.totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`  Report: ${outputDir}/${reportId}.json`);

  // Floor summary — side-by-side. Printed on every run (even single-
  // floor) so the floor dimension is visible without opening JSON.
  if (report.floorSummaries && report.floorSummaries.length > 0) {
    console.log(`\n  Floor summary (v0 — see internal/benchmarks/src/multi-sdk/floor.md):`);
    console.log(`    floor    runs  avgTime   avgScore  success  capHit   toolCalled/avg  buckets(pass/patchInv/selfCheck/diff)`);
    for (const fs of report.floorSummaries) {
      const pct = (n) => (n * 100).toFixed(0).padStart(3) + '%';
      const score = fs.avgScore < 0 ? '  n/a' : fs.avgScore.toFixed(1).padStart(5);
      const toolMix = `${pct(fs.predefinedToolCallRate)}/${fs.avgPredefinedToolCalls.toFixed(1)}`;
      const b = fs.errorBuckets;
      console.log(
        `    ${fs.floor.padEnd(7)} ${String(fs.runs).padStart(4)}  ${(fs.avgTimeMs / 1000).toFixed(1).padStart(5)}s   ${score}     ${pct(fs.successRate)}     ${pct(fs.capHitRate)}    ${toolMix.padEnd(14)} ${b.pass}/${b.patchInvalid}/${b.selfCheckFail}/${b.diffFail}`,
      );
    }
    console.log('');
  }
};

run().catch((err) => {
  console.error(`\n  ✗ ${err.message}\n`);
  process.exit(1);
});
