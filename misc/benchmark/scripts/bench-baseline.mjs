#!/usr/bin/env node
// Cross-bench baseline orchestrator — runs the v0 benches and
// writes a single self-contained bundle with a manifest.
//
// Discipline:
//   - Tolerates partial failure. One bench failing does NOT halt the
//     others. The manifest records exit code + stderr excerpt per
//     failed bench.
//   - Does NOT mutate individual benches. Each bench is invoked via
//     its existing entry script with its existing args.
//   - Copies each bench's report INTO the bundle so archives are
//     portable and self-contained.
//
// Usage:
//
//   pnpm bench:baseline                      # all benches, default args
//   pnpm bench:baseline --skip multi-sdk     # skip multi-sdk (no API keys)
//   pnpm bench:baseline --runs 5             # override --runs for the 3
//                                            # deterministic benches
//
// Output:
//
//   tmp-bench-logs/baseline-<iso>/
//     manifest.json
//     slo.json / a2ui.json / multi-sdk.json
//     stdout/
//       <bench>.log    (full stdout + stderr capture per bench)

import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildBaselineManifest,
  extractA2uiSummary,
  extractMultiSdkSummary,
  extractSloSummary,
} from '../src/baseline/manifest.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(CORE_DIR, '..');

// ─── CLI ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { runs: 3, skip: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') args.runs = Number(argv[++i]);
    else if (a === '--skip') args.skip = String(argv[++i]).split(',');
    else if (a === '--help' || a === '-h') {
      console.log('Usage: pnpm bench:baseline [--runs N] [--skip csv]');
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.runs) || args.runs < 1) {
    throw new Error(`--runs must be a positive integer, got ${args.runs}`);
  }
  return args;
}

// ─── Bench specs ──────────────────────────────────────────────────
// Each spec describes how to invoke one bench. `command` is shown in
// the manifest; `argv` is what actually spawns.

function buildSpecs(runs) {
  return [
    {
      benchName: 'slo',
      command: `pnpm bench:slo --runs ${runs}`,
      argv: ['pnpm', 'bench:slo', '--runs', String(runs)],
      stdoutPattern: /\[slo-v0\] wrote (.+)/,
      extractSummary: extractSloSummary,
    },
    {
      benchName: 'multi-sdk',
      // Default multi-sdk baseline: single provider/commit — keeps
      // the baseline cheap without exploding the bench into a full
      // matrix. The user can still invoke bench.mjs directly for a
      // wider run.
      command: 'pnpm bench -p claude -c weather-card',
      argv: ['pnpm', 'bench', '-p', 'claude', '-c', 'weather-card'],
      // multi-sdk uses a different log prefix: "Report: <path>"
      stdoutPattern: /Report: (.+\.json)/,
      extractSummary: extractMultiSdkSummary,
    },
    {
      benchName: 'a2ui',
      command: `pnpm bench:a2ui --runs ${runs}`,
      argv: ['pnpm', 'bench:a2ui', '--runs', String(runs)],
      stdoutPattern: /\[a2ui-v0\] wrote (.+)/,
      extractSummary: extractA2uiSummary,
    },
  ];
}

// ─── Per-bench runner ─────────────────────────────────────────────

function runBench(spec, bundleDir) {
  return new Promise((resolvePromise) => {
    const stdoutDir = join(bundleDir, 'stdout');
    mkdirSync(stdoutDir, { recursive: true });
    const logPath = join(stdoutDir, `${spec.benchName}.log`);
    const chunks = [];
    const proc = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: CORE_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (c) => {
      process.stdout.write(c);
      chunks.push(c);
    });
    proc.stderr.on('data', (c) => {
      process.stderr.write(c);
      chunks.push(c);
    });
    proc.on('error', (err) => {
      // spawn failure (e.g., pnpm not found) — distinct from a non-zero
      // exit. Record as failed with null exit code.
      writeFileSync(logPath, `${chunks.join('')}\n[spawn error] ${err.message}\n`, 'utf8');
      resolvePromise({
        benchName: spec.benchName,
        status: 'failed',
        command: spec.command,
        outputPath: null,
        bundlePath: null,
        exitCode: null,
        summary: null,
        errorExcerpt: `spawn failed: ${err.message}`.slice(0, 500),
      });
    });
    proc.on('close', (exitCode) => {
      const combined = Buffer.concat(chunks).toString('utf8');
      writeFileSync(logPath, combined, 'utf8');

      if (exitCode !== 0) {
        // Failed — still record what we know. `errorExcerpt` is the
        // last ~500 chars of combined output so the failure cause is
        // legible without opening the log file.
        const excerpt = combined.slice(-500).trim();
        resolvePromise({
          benchName: spec.benchName,
          status: 'failed',
          command: spec.command,
          outputPath: null,
          bundlePath: null,
          exitCode,
          summary: null,
          errorExcerpt: excerpt || null,
        });
        return;
      }

      // Parse the report path from stdout.
      const match = combined.match(spec.stdoutPattern);
      const outputPath = match ? match[1].trim() : null;
      if (!outputPath || !existsSync(outputPath)) {
        resolvePromise({
          benchName: spec.benchName,
          status: 'failed',
          command: spec.command,
          outputPath,
          bundlePath: null,
          exitCode,
          summary: null,
          errorExcerpt: outputPath
            ? `report path parsed but file missing: ${outputPath}`
            : 'could not parse report path from stdout',
        });
        return;
      }

      // Copy report into bundle; extract top-line summary.
      const bundlePath = join(bundleDir, `${spec.benchName}.json`);
      let summary = null;
      try {
        copyFileSync(outputPath, bundlePath);
        const raw = readFileSync(bundlePath, 'utf8');
        const parsed = JSON.parse(raw);
        summary = spec.extractSummary(parsed);
      } catch (e) {
        // Copy/parse failure — record as failed with an explicit
        // reason. Don't pretend success just because the bench's own
        // process exited 0.
        resolvePromise({
          benchName: spec.benchName,
          status: 'failed',
          command: spec.command,
          outputPath,
          bundlePath: null,
          exitCode,
          summary: null,
          errorExcerpt: `report copy/parse failed: ${
            e instanceof Error ? e.message : String(e)
          }`.slice(0, 500),
        });
        return;
      }

      resolvePromise({
        benchName: spec.benchName,
        status: 'success',
        command: spec.command,
        outputPath,
        bundlePath,
        exitCode,
        summary,
        errorExcerpt: null,
      });
    });
  });
}

// ─── Git SHA (best-effort) ────────────────────────────────────────

function resolveGitSha() {
  return new Promise((resolvePromise) => {
    const proc = spawn('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.on('error', () => resolvePromise(null));
    proc.on('close', (code) => {
      if (code !== 0) return resolvePromise(null);
      const sha = Buffer.concat(chunks).toString('utf8').trim();
      resolvePromise(sha.length === 40 ? sha : null);
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const specs = buildSpecs(args.runs).filter(
    (s) => !args.skip.includes(s.benchName),
  );
  if (specs.length === 0) {
    throw new Error(`all benches skipped; nothing to run`);
  }

  const timestamp = new Date().toISOString();
  const baselineId = `baseline-${timestamp.replace(/:/g, '-')}`;
  const bundleDir = resolve(REPO_ROOT, 'tmp-bench-logs', baselineId);
  mkdirSync(bundleDir, { recursive: true });

  const gitSha = await resolveGitSha();

  console.log(`[baseline] ${baselineId}`);
  console.log(`[baseline] bundle: ${bundleDir}`);
  console.log(`[baseline] git: ${gitSha ?? 'unresolved'}`);
  console.log(`[baseline] running ${specs.length} bench(es) sequentially...`);
  console.log();

  const results = [];
  for (const spec of specs) {
    console.log(`\n[baseline] ── ${spec.benchName} ──────────────────────`);
    const entry = await runBench(spec, bundleDir);
    results.push(entry);
    const tag = entry.status === 'success' ? '✓' : '✗';
    const detail =
      entry.status === 'success'
        ? entry.summary?.headline ?? `runs=${entry.summary?.totalRuns ?? '?'}`
        : `exit=${entry.exitCode} — ${entry.errorExcerpt?.split('\n')[0] ?? 'unknown error'}`;
    console.log(`[baseline] ${tag} ${spec.benchName}: ${detail}`);
  }

  const manifest = buildBaselineManifest({
    baselineId,
    timestamp,
    gitSha,
    bundleDir,
    results,
  });
  const manifestPath = join(bundleDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const okCount = results.filter((r) => r.status === 'success').length;
  const failCount = results.length - okCount;
  console.log();
  console.log(`[baseline] done — ${okCount} ok / ${failCount} failed`);
  console.log(`[baseline] manifest: ${manifestPath}`);

  // Exit 0 even on partial failure — the manifest is the authoritative
  // record. CI can read the manifest and decide what to do. This
  // matches the "no fake success aggregation" discipline: we report
  // the honest shape, we don't crash the wrapper on it.
}

main().catch((err) => {
  console.error('[baseline] fatal:', err);
  process.exit(1);
});
