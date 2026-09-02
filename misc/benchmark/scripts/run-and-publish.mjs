#!/usr/bin/env node
/**
 * Fargate entrypoint: run the multi-sdk bench, publish results to S3.
 *
 * Sequence per cron firing:
 *   1. Run `pnpm bench` against the configured provider × commit matrix.
 *      The runner internally parallelizes via concurrency: 36.
 *   2. Read the emitted JSON report from benchmark-results/.
 *   3. Upload to s3://<bucket>/<prefix><date>/multi-sdk.json.
 *   4. Update s3://<bucket>/<prefix>index.json — fetch existing, append
 *      this run's metadata, write back. Newest-first ordering.
 *
 * Designed to fail loudly: any step error exits non-zero so Fargate +
 * EventBridge surface the failure (ECS task failure event → CloudWatch
 * alarm → operator).
 *
 * Same script runs locally (set S3_BUCKET=… and AWS creds) so OSS users
 * can publish their own bench results to their own bucket without cloud
 * runtime.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { buildHeadline } from './headline.mjs';
import { missingProviderKeys } from './preflight.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Config — env vars only. No CLI args; this is a cron entrypoint.
// ---------------------------------------------------------------------------

const S3_BUCKET = requireEnv('S3_BUCKET');
const S3_PREFIX = process.env.S3_PREFIX ?? 'data/';
const PROVIDERS = process.env.BENCH_PROVIDERS ?? 'claude,openai,google';
const COMMITS =
  process.env.BENCH_COMMITS ??
  'weather-card,survey-form,kanban-board,periodic-table,product-page,chat-interface,stock-ticker,onboarding-wizard,leaflet-map,revenue-chart';
const THRESHOLD = process.env.BENCH_THRESHOLD ?? '70';
const BENCH_DATE = process.env.BENCH_DATE ?? new Date().toISOString().slice(0, 10);
// Cell concurrency. 12 fits the 2GB Fargate task (36 OOM-killed it,
// 2026-08-21); the VerifyBenchmarkRule overrides to 36 for original-
// concurrency batteries (needs the 4096MiB task def).
const CONCURRENCY = process.env.BENCH_CONCURRENCY ?? '12';
// Set by the manual + verify EventBridge rules' container overrides:
// forced dispatches never gate (standing P0-dispatch rule).
const FORCE = process.env.BENCH_FORCE === '1';

if (!S3_PREFIX.endsWith('/')) {
  fail(`S3_PREFIX must end with a slash, got "${S3_PREFIX}"`);
}

console.log('[run-and-publish] config:');
console.log(`  bucket=${S3_BUCKET}`);
console.log(`  prefix=${S3_PREFIX}`);
console.log(`  date=${BENCH_DATE}`);
console.log(`  providers=${PROVIDERS}`);
console.log(`  commits=${COMMITS}`);
console.log(`  threshold=${THRESHOLD}`);
console.log(`  concurrency=${CONCURRENCY}`);
console.log(`  force=${FORCE}`);

// ---------------------------------------------------------------------------
// Change gate — run only when a bench-relevant update exists (or long-stop /
// forced). See run-gate.mjs for the full rationale. Runs BEFORE the key
// preflight: a gated skip needs no provider keys.
// ---------------------------------------------------------------------------

const s3 = new S3Client({});

{
  const { decideBenchRun } = await import('./run-gate.mjs');
  const { index } = await tryFetchIndex(`${S3_PREFIX}index.json`);
  const latest = index?.runs?.find((r) => r.multiSdk);
  // Fleet main-hold marker (#684): written/cleared next to the index by
  // the bench-hold-mirror workflow from open `hold:main` issues. Same
  // fetch helper — it's a JSON object at a key, absent when no hold.
  const { index: hold } = await tryFetchIndex(`${S3_PREFIX}HOLD.json`);
  if (hold?.issues?.length) {
    console.warn(`[run-and-publish] MAIN-HOLD marker present (set ${hold.setAt ?? '?'}, ${hold.source ?? 'unknown source'}):`);
    for (const i of hold.issues) console.warn(`  #${i.number} ${i.title ?? ''} ${i.url ?? ''}`);
  }
  const decision = decideBenchRun({
    imageVersion: process.env.GIT_SHA,
    latestVersion: latest?.multiSdk?.version,
    latestDate: latest?.date,
    today: BENCH_DATE,
    force: FORCE,
    hold: hold ?? undefined,
  });
  console.log(`[run-and-publish] gate: ${decision.reason}`);
  if (!decision.run) {
    // Clean exit 0 — a gated skip is the cadence working, not a failure.
    process.exit(0);
  }
}

// Preflight: refuse to publish if a requested provider has no key — a
// keyless provider yields all-failed cells that look like a real
// regression in the published data (2026-06-10 audit, runner-publish:21).
const requestedProviders = PROVIDERS.split(',').map((p) => p.trim()).filter(Boolean);
const missing = missingProviderKeys(requestedProviders, process.env);
if (missing.length > 0) {
  fail(
    `missing API key(s) for requested provider(s): ${missing.join(', ')}. ` +
      `Refusing to publish a report that would record these as failures. ` +
      `Set the provider's API key in the environment (e.g. ANTHROPIC_API_KEY) or drop the provider from BENCH_PROVIDERS.`,
  );
}

// ---------------------------------------------------------------------------
// 1. Run the bench
// ---------------------------------------------------------------------------

await runBench();

// ---------------------------------------------------------------------------
// 2. Locate the emitted report (newest file in benchmark-results/)
// ---------------------------------------------------------------------------

const resultsDir = resolve(BENCH_ROOT, 'benchmark-results');
if (!existsSync(resultsDir)) {
  fail(`benchmark-results/ not found after bench run — bench failed before emitting report?`);
}

const reportPath = pickNewestJsonReport(resultsDir);
console.log(`[run-and-publish] report file: ${reportPath}`);
const reportBytes = readFileSync(reportPath);
const report = JSON.parse(reportBytes.toString('utf-8'));

// ---------------------------------------------------------------------------
// 3. Upload report to s3://<bucket>/<prefix><date>/multi-sdk.json
// ---------------------------------------------------------------------------

const reportKey = `${S3_PREFIX}${BENCH_DATE}/multi-sdk.json`;
await s3.send(
  new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: reportKey,
    Body: reportBytes,
    ContentType: 'application/json',
    CacheControl: 'public, max-age=300',
  }),
);
console.log(`[run-and-publish] uploaded report: s3://${S3_BUCKET}/${reportKey}`);

// ---------------------------------------------------------------------------
// 4. Update index.json
// ---------------------------------------------------------------------------

const indexKey = `${S3_PREFIX}index.json`;
await updateIndexWithRetry(indexKey, newRunEntry());
console.log(`[run-and-publish] uploaded index: s3://${S3_BUCKET}/${indexKey}`);

// ---------------------------------------------------------------------------
// 5. Publish the dataset LICENSE alongside the data.
// ---------------------------------------------------------------------------
//
// The published reports + index are a dataset distinct from the runner
// code (Apache-2.0). Stamp the dataset with CC-BY-4.0 so consumers know
// the terms. Must live under the data/ prefix — only data/* is
// public-read and writable by the bench task role.
const licenseKey = `${S3_PREFIX}LICENSE`;
const LICENSE_TEXT =
  'ggui benchmark dataset — Creative Commons Attribution 4.0 International (CC-BY-4.0).\n' +
  'You are free to share and adapt this dataset with attribution.\n' +
  'Full license: https://creativecommons.org/licenses/by/4.0/\n' +
  'Source: https://github.com/ggui-ai/ggui\n';
await s3.send(
  new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: licenseKey,
    Body: LICENSE_TEXT,
    ContentType: 'text/plain',
    CacheControl: 'public, max-age=3600',
  }),
);
console.log(`[run-and-publish] uploaded license: s3://${S3_BUCKET}/${licenseKey}`);
console.log(`[run-and-publish] done.`);

function newRunEntry() {
  return {
    date: BENCH_DATE,
    multiSdk: {
      reportPath: `${BENCH_DATE}/multi-sdk.json`,
      successRate: report?.meta?.successRate ?? 0,
      totalRuns: report?.meta?.totalRuns ?? 0,
      // Runner-image build commit — the change gate compares the current
      // image against this to decide whether an update exists.
      version: report?.meta?.version,
      headline: buildHeadline(report),
    },
  };
}

async function updateIndexWithRetry(key, runEntry, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const { index, etag } = await tryFetchIndex(key);
    const updated = mergeIndex(index, runEntry);
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: JSON.stringify(updated, null, 2),
          ContentType: 'application/json',
          CacheControl: 'public, max-age=60',
          // Conditional write: only succeed if the object is unchanged
          // since our read (etag) — or absent (IfNoneMatch '*'). On a
          // concurrent writer the precondition fails and we re-read+retry.
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
        }),
      );
      return;
    } catch (err) {
      const code = err?.name ?? err?.Code;
      const status = err?.$metadata?.httpStatusCode;
      const isPrecondition =
        code === 'PreconditionFailed' || status === 412 || status === 409;
      if (isPrecondition && i < attempts - 1) {
        console.log(`[run-and-publish] index changed under us, retrying (${i + 1}/${attempts})`);
        continue;
      }
      throw err;
    }
  }
  fail(`failed to update ${key} after ${attempts} attempts (persistent write contention)`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name) {
  const v = process.env[name];
  if (!v) fail(`missing required env var: ${name}`);
  return v;
}

function fail(msg) {
  console.error(`[run-and-publish] ${msg}`);
  process.exit(1);
}

function runBench() {
  // Invoke `node --import tsx scripts/bench.mjs` directly rather than
  // delegating through `pnpm bench` — the runtime image is alpine + node
  // only, no pnpm. The package.json's `bench` script does the same thing
  // anyway; we just skip the pnpm hop.
  return new Promise((resolveP, rejectP) => {
    const child = spawn(
      'node',
      [
        '--import',
        'tsx',
        'scripts/bench.mjs',
        '--provider',
        PROVIDERS,
        '--commit',
        COMMITS,
        '--threshold',
        THRESHOLD,
        // 600s per-cell generation timeout for the PUBLISHED weekly run
        // (bench.mjs defaults to 300s, which cost 7 heavy-commit cells on
        // 2026-08-19 — paid tokens, no data; #565 item 2). Local/dev
        // benches keep the fast-fail default; slowness stays visible via
        // per-cell generationTimeMs either way.
        '--timeout',
        '600000',
        // Default 12 concurrent cells fits the 2GB Fargate task (the
        // 2026-08-21 manual run OOM-killed at bench.mjs's 36-cell
        // default ~4min in: happy-dom render checks + esbuild + 7-way
        // parallel evals per cell outgrew 2GB as the harness got
        // heavier). Cells are LLM-latency-bound, so 12 lanes ≈ 3× wall
        // time at ~1/3 the peak memory. Belt = memoryLimitMiB 4096 in
        // apps/benchmarks/amplify/backend.ts; the VerifyBenchmarkRule
        // overrides BENCH_CONCURRENCY=36 for original-concurrency
        // batteries once that task def is live.
        '--concurrency',
        CONCURRENCY,
      ],
      {
        cwd: BENCH_ROOT,
        stdio: 'inherit',
        env: process.env,
      },
    );
    child.on('exit', (code) => {
      if (code !== 0) {
        rejectP(new Error(`bench exited with code ${code}`));
        return;
      }
      resolveP(undefined);
    });
    child.on('error', rejectP);
  });
}

function pickNewestJsonReport(dir) {
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = resolve(dir, f);
      return { full, mtime: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (entries.length === 0) fail(`no .json reports in ${dir}`);
  return entries[0].full;
}

async function tryFetchIndex(key) {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    if (!out.Body) return { index: null, etag: undefined };
    const buf = Buffer.from(await out.Body.transformToByteArray());
    return { index: JSON.parse(buf.toString('utf-8')), etag: out.ETag };
  } catch (err) {
    if (err && (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404)) {
      return { index: null, etag: undefined };
    }
    throw err;
  }
}

function mergeIndex(existing, newRun) {
  const runs = (existing?.runs ?? []).filter((r) => r.date !== newRun.date);
  runs.unshift(newRun);
  runs.sort((a, b) => (a.date < b.date ? 1 : -1));
  return {
    schemaVersion: 'benchmark-index.v0',
    generatedAt: new Date().toISOString(),
    runs,
  };
}

