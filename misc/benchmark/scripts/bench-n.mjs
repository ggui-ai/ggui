#!/usr/bin/env node

/**
 * Per-commit worker-pool wrapper around `bench.mjs`.
 *
 * Architecture (Option B, 2026-04-27):
 *   The wrapper expands the matrix into one node process per
 *   `(run × provider × commit)` cell — 72 cells instead of 9 for n=3 × 3
 *   providers × 8 commits. Each cell has its own ~500MB heap, eliminating
 *   the OOM class that plagued the prior 8-commits-per-process design
 *   (4GB default + 8 LLM-response heaps + agent state = OOM during long
 *   chat-interface generations).
 *
 *   Concurrency is bounded by `--max-concurrent` (default 12) so we don't:
 *     - burst N×8 LLM calls at once (provider rate limits)
 *     - exhaust system RAM (12 × 500MB ≈ 6GB ceiling vs unbounded 36GB+)
 *
 * Trade-offs vs prior 9-cell design:
 *     + no shared heap between commits → no OOM
 *     + per-commit failure isolation (one crash doesn't kill 7 others)
 *     + uniform timing — each cell budget is per-commit, not per-batch
 *     + simpler aggregate (one cell = one report = one row)
 *     - higher node startup cost (~1s × 72 vs 1s × 9 = ~63s amortized)
 *     - more files in tmp-bench-logs/
 *
 * Output convention:
 *   tmp-bench-logs/<tag>-run<i>-<provider>-<commit>.log    (per-cell log)
 *   tmp-bench-logs/<tag>-runs.json                          (manifest)
 *
 * Usage:
 *   pnpm bench:n --tag <tag> --n 3 --provider claude,openai,google \
 *     --commit weather-card,survey-form,kanban-board,periodic-table,product-page,chat-interface,stock-ticker,onboarding-wizard \
 *     --max-turns 15 --max-eval 3 --quality fast --timeout 360000 --threshold 70
 *
 *   Optional knobs:
 *     --max-concurrent N      (default 12) max cells in flight at once
 *     --cell-timeout-sec N    (default 600 = 10m) hard kill per cell
 *     --heartbeat-sec N       (default 90) kill if log silent this long
 *
 * Caller is expected to be at workspace root or a worktree thereof.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_PATH = resolve(__dirname, 'bench.mjs');

const args = process.argv.slice(2);
const flags = {
  tag: '',
  n: 1,
  providers: '',
  commits: '',
  // Hard wall-clock kill budget per cell. Default 10min — generous for
  // a single commit at --timeout=360000 (6m) plus eval rounds + slack.
  cellTimeoutSec: 10 * 60,
  // Heartbeat: per single-commit cell, log should grow steadily during
  // turn execution. Default 90s of silence triggers a kill — chosen to
  // exceed the longest expected single-LLM-call wait (~30-60s) without
  // leaving truly hung processes running.
  heartbeatSec: 90,
  // Inner bench per-task timeout (used to auto-bump heartbeat below).
  innerTimeoutMs: 0,
  // Concurrency cap — how many cells run simultaneously. The provider
  // SDK rate limits and system RAM are the real bounds. 12 is a safe
  // default: ~6GB peak RAM (12 × 500MB), and ≤4 simultaneous calls per
  // provider on n=3 × 3 providers (12 / 3 = 4).
  maxConcurrent: 12,
  extras: [],
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--tag') flags.tag = args[++i] ?? '';
  else if (a === '--n') flags.n = parseInt(args[++i] ?? '1', 10);
  else if (a === '--provider' || a === '-p') flags.providers = args[++i] ?? '';
  else if (a === '--commit' || a === '-c') flags.commits = args[++i] ?? '';
  else if (a === '--cell-timeout-sec') flags.cellTimeoutSec = parseInt(args[++i] ?? '600', 10);
  else if (a === '--heartbeat-sec') flags.heartbeatSec = parseInt(args[++i] ?? '90', 10);
  else if (a === '--max-concurrent') flags.maxConcurrent = parseInt(args[++i] ?? '12', 10);
  else if (a === '--timeout') {
    const v = args[++i] ?? '';
    flags.innerTimeoutMs = parseInt(v, 10) || 0;
    flags.extras.push('--timeout', v);
  }
  else flags.extras.push(a);
}

// Auto-bump heartbeat if inner --timeout is large — heartbeat must exceed
// the worst-case time the LLM might spend in one blocking SDK call. With
// a single commit per cell, no parallel siblings can hold the log silent,
// so the floor is just `inner_timeout + slack` (no per-cell × 8 multiplier).
if (flags.innerTimeoutMs > 0) {
  const minHeartbeat = Math.ceil(flags.innerTimeoutMs / 1000) + 60;
  if (flags.heartbeatSec < minHeartbeat) {
    console.log(
      `[bench-n] auto-bump heartbeat ${flags.heartbeatSec}s → ${minHeartbeat}s ` +
        `(inner --timeout=${flags.innerTimeoutMs}ms + 60s slack)`,
    );
    flags.heartbeatSec = minHeartbeat;
  }
}

if (!flags.tag) {
  console.error('[bench-n] --tag is required');
  process.exit(2);
}
if (!flags.providers) {
  console.error('[bench-n] --provider is required (comma-separated)');
  process.exit(2);
}
if (!flags.commits) {
  console.error(
    '[bench-n] --commit is required (comma-separated). The wrapper expands one cell per (run × provider × commit); leaving it unset would dispatch to bench.mjs default and undermine the per-commit isolation the wrapper provides.',
  );
  process.exit(2);
}

const providers = flags.providers.split(',').map((s) => s.trim()).filter(Boolean);
const commits = flags.commits.split(',').map((s) => s.trim()).filter(Boolean);
const logsDir = resolve(process.cwd(), 'tmp-bench-logs');
if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

/**
 * Spawn one (run, provider, commit) cell as its own node process. Single
 * commit per heap eliminates the parallel-commits-share-heap OOM that was
 * the v9/v10 failure mode.
 */
async function runCell(run, provider, commit) {
  const logFile = resolve(logsDir, `${flags.tag}-run${run}-${provider}-${commit}.log`);
  const cmd = [
    '--import',
    'tsx',
    BENCH_PATH,
    '--provider',
    provider,
    '--commit',
    commit,
    ...flags.extras,
  ];

  console.log(
    `[bench-n] launch run=${run}/${flags.n} provider=${provider} commit=${commit} → ${logFile}`,
  );
  const start = Date.now();

  const fd = openSync(logFile, 'w');
  const child = spawn('node', cmd, {
    stdio: ['ignore', fd, fd],
    env: process.env,
    detached: false,
  });

  let killReason = '';
  const cellDeadline = setTimeout(() => {
    killReason = `cell-timeout ${flags.cellTimeoutSec}s`;
    try {
      child.kill('SIGKILL');
    } catch {}
  }, flags.cellTimeoutSec * 1000);

  let lastSize = 0;
  let lastGrowthAt = Date.now();
  const heartbeatTimer = setInterval(() => {
    try {
      const sz = statSync(logFile).size;
      if (sz > lastSize) {
        lastSize = sz;
        lastGrowthAt = Date.now();
        return;
      }
      if (Date.now() - lastGrowthAt > flags.heartbeatSec * 1000) {
        killReason = `heartbeat-stall ${flags.heartbeatSec}s`;
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    } catch {}
  }, 5_000);

  const exitCode = await new Promise((resolveExit) => {
    child.on('exit', (code) => resolveExit(code));
    child.on('error', () => resolveExit(-1));
  });

  clearTimeout(cellDeadline);
  clearInterval(heartbeatTimer);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  let reportPath = null;
  try {
    const tail = readFileSync(logFile, 'utf-8');
    const reportLine = tail.split('\n').find((l) => l.includes('Report saved to'));
    reportPath = reportLine?.split('Report saved to').pop()?.trim() ?? null;
  } catch {}

  console.log(
    `[bench-n]   done run=${run}/${flags.n} provider=${provider} commit=${commit} ` +
      `exit=${exitCode ?? '?'}${killReason ? ` (KILLED: ${killReason})` : ''} ` +
      `elapsed=${elapsed}s report=${reportPath ?? '(none)'}`,
  );

  return {
    run,
    provider,
    commit,
    logFile,
    reportPath,
    elapsedSeconds: parseFloat(elapsed),
    exitCode: exitCode ?? -1,
    killReason: killReason || undefined,
  };
}

// Bounded worker pool: pull from a queue of pending cells, never run more
// than `maxConcurrent` at once. Workers are independent — when one finishes,
// it picks up the next pending cell. This caps RAM + LLM rate-limit burst
// without serializing the matrix.
async function runPool(cells, maxConcurrent) {
  const results = new Array(cells.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= cells.length) return;
      const c = cells[i];
      results[i] = await runCell(c.run, c.provider, c.commit);
    }
  }

  const workerCount = Math.min(maxConcurrent, cells.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// Build the full cell matrix. Order: outer = run, then provider, then
// commit. This puts run-1 cells first, so an early aggregate based on
// completed cells still represents the matrix shape rather than skewed
// toward one provider/commit.
const allCells = [];
for (let run = 1; run <= flags.n; run++) {
  for (const provider of providers) {
    for (const commit of commits) {
      allCells.push({ run, provider, commit });
    }
  }
}

console.log(
  `[bench-n] === pool: ${allCells.length} cells (${flags.n} runs × ${providers.length} providers × ${commits.length} commits), max ${flags.maxConcurrent} concurrent ===`,
);

const cellResults = await runPool(allCells, flags.maxConcurrent);
const runs = cellResults;

const manifestPath = resolve(logsDir, `${flags.tag}-runs.json`);
writeFileSync(
  manifestPath,
  JSON.stringify({ tag: flags.tag, n: flags.n, providers, commits, runs }, null, 2),
);
console.log(`[bench-n] manifest → ${manifestPath}`);

// Aggregate: per-(provider, commit) mean score / mean time / pass-rate.
// Each cell now produces a report containing exactly one commit's result,
// but we keep the same loop shape so existing analyzers work unchanged.
//
// 2026-04-27: also parse `[runtime-probe] ... PASS|FAIL ... <ms>` line
// from the per-cell log file so the aggregate can show probe pass-rate
// + probe wall-clock alongside score/gen-time. The probe runs externally
// (post-gen) per the final-check refactor, so its result lives in stdout
// only — not the report JSON. Parsing the log is the simplest seam.
// Match `[runtime-probe] <id> × <commit>: PASS|FAIL|SKIP` followed by
// either `(fail=N warn=N)` (probe ran inside harness, no per-cell ms
// measurement) or `(fail=N warn=N <ms>ms)` (legacy external probe with
// timing) or trailing prose for SKIP. Capture outcome + optional ms.
const PROBE_LINE = /\[runtime-probe\][^:]*:\s+(PASS|FAIL|SKIP)(?:[^(]*\(.*?(\d+)ms\))?/;
const cells = new Map();
function cellSamples(provider, commit) {
  const key = `${provider}|${commit}`;
  if (!cells.has(key)) cells.set(key, []);
  return cells.get(key);
}
// Aggregate over ALL attempted cells — a SIGKILLed / crashed cell that
// never wrote a report is a FAILURE sample, not a silently-dropped row.
// (Pre-fix, killed cells vanished from n entirely, so passed/n and the
// score stats survivorship-biased toward the healthy outcomes.)
for (const r of runs) {
  const hasReport = !!(r.reportPath && existsSync(r.reportPath));
  let report = null;
  if (hasReport) {
    try {
      report = JSON.parse(readFileSync(r.reportPath, 'utf-8'));
    } catch {
      report = null;
    }
  }
  if (!report) {
    // No (readable) report — count the cell against its own
    // (provider, commit) bucket as an unreported failure.
    cellSamples(r.provider, r.commit).push({
      score: null,
      totalMs: null,
      turns: null,
      passed: false,
      reported: false,
      run: r.run,
      probeOutcome: null,
      probeMs: null,
      killReason: r.killReason ?? null,
    });
    continue;
  }
  // Parse per-cell log for probe outcome + duration.
  let probeOutcome = null;
  let probeMs = null;
  if (r.logFile && existsSync(r.logFile)) {
    try {
      const logBody = readFileSync(r.logFile, 'utf-8');
      const m = PROBE_LINE.exec(logBody);
      if (m) {
        probeOutcome = m[1];
        // The modern probe line has no per-cell ms group — m[2] is
        // undefined and parseInt yields NaN. Keep null over NaN so the
        // mean below prints n/a instead of NaN.
        const parsedMs = parseInt(m[2], 10);
        probeMs = Number.isFinite(parsedMs) ? parsedMs : null;
      }
    } catch {
      /* probe data missing — that's fine, treat as null */
    }
  }
  const reportResults = report.results ?? [];
  if (reportResults.length === 0) {
    // Report exists but carries no per-cell result rows — still a
    // failure sample, not a vanished cell.
    cellSamples(r.provider, r.commit).push({
      score: null,
      totalMs: null,
      turns: null,
      passed: false,
      reported: true,
      run: r.run,
      probeOutcome,
      probeMs,
      killReason: r.killReason ?? null,
    });
    continue;
  }
  for (const result of reportResults) {
    const score = result.evaluation?.score ?? null;
    const totalMs = result.generation?.generationTimeMs ?? null;
    const turns = result.generation?.turnsUsed ?? null;
    // 2026-04-27: pass/fail = probe outcome. Aesthetic LLM score is
    // informational telemetry, not a gate. Generation completing means
    // tier-0 + compile already passed (the multi-turn loop only exits
    // successfully when self-check is clean), so the only remaining
    // production-quality question is "does it actually work at runtime
    // against the contract" — which is exactly what the probe checks.
    //
    // probeOutcome === 'PASS' ⇒ cell passed
    // probeOutcome === 'FAIL' ⇒ real wiring bug, cell failed
    // probeOutcome === 'SKIP' or null (probe couldn't run / cell errored
    //   before probe) ⇒ inconclusive, treat as fail
    const passed = probeOutcome === 'PASS';
    cellSamples(r.provider, result.commit?.id ?? r.commit).push({
      score, totalMs, turns, passed, reported: true, run: r.run, probeOutcome, probeMs,
    });
  }
}

console.log('\n=== aggregate (ALL attempted cells; missing reports count as failures) ===');
console.log(
  'provider | commit | reported/attempted | passed/attempted | score_mean ± std (min..max) | time_s_mean ± std (min..max) | turns_mean | probe_pass/n probe_ms_mean',
);
function stat(arr) {
  if (arr.length === 0) return { mean: NaN, std: 0, min: NaN, max: NaN };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
  return { mean, std, min: Math.min(...arr), max: Math.max(...arr) };
}
for (const [key, samples] of [...cells.entries()].sort()) {
  const [provider, commit] = key.split('|');
  const attempted = samples.length;
  const reported = samples.filter((s) => s.reported).length;
  const passed = samples.filter((s) => s.passed).length;
  // Score/time/turn stats cover only reported samples (a killed cell has
  // no measurement); the reported/attempted column discloses the gap.
  const scoreS = stat(samples.filter((s) => s.score !== null).map((s) => s.score));
  const timeS = stat(samples.filter((s) => s.totalMs !== null).map((s) => s.totalMs / 1000));
  const turnArr = samples.filter((s) => s.turns !== null).map((s) => s.turns);
  const meanTurns = turnArr.length > 0
    ? (turnArr.reduce((a, b) => a + b, 0) / turnArr.length).toFixed(1)
    : 'n/a';
  const probeSamples = samples.filter((s) => s.probeOutcome !== null);
  const probePass = probeSamples.filter((s) => s.probeOutcome === 'PASS').length;
  const probeMsArr = probeSamples
    .filter((s) => Number.isFinite(s.probeMs))
    .map((s) => s.probeMs);
  const probeMsMean = probeMsArr.length > 0
    ? (probeMsArr.reduce((a, b) => a + b, 0) / probeMsArr.length).toFixed(0)
    : 'n/a';
  const scoreStr = `${scoreS.mean.toFixed(1)} ±${scoreS.std.toFixed(1)} (${scoreS.min.toFixed(0)}..${scoreS.max.toFixed(0)})`;
  const timeStr = `${timeS.mean.toFixed(1)}s ±${timeS.std.toFixed(1)} (${timeS.min.toFixed(1)}..${timeS.max.toFixed(1)})`;
  const probeStr = probeSamples.length > 0
    ? `${probePass}/${probeSamples.length} ${probeMsMean}ms`
    : '—';
  console.log(`${provider} | ${commit} | ${reported}/${attempted} | ${passed}/${attempted} | ${scoreStr} | ${timeStr} | ${meanTurns} | ${probeStr}`);
}
