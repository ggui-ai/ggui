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
  'weather-card,survey-form,kanban-board,periodic-table,product-page,chat-interface,stock-ticker,onboarding-wizard';
const THRESHOLD = process.env.BENCH_THRESHOLD ?? '70';
const BENCH_DATE = process.env.BENCH_DATE ?? new Date().toISOString().slice(0, 10);

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

// Preflight: refuse to publish if a requested provider has no key — a
// keyless provider yields all-failed cells that look like a real
// regression in the published data (2026-06-10 audit, runner-publish:21).
const requestedProviders = PROVIDERS.split(',').map((p) => p.trim()).filter(Boolean);
const missing = missingProviderKeys(requestedProviders, process.env);
if (missing.length > 0) {
  fail(
    `missing API key(s) for requested provider(s): ${missing.join(', ')}. ` +
      `Refusing to publish a report that would record these as failures. ` +
      `Set the key(s) in Secrets Manager (ggui-bench/*) or drop the provider from BENCH_PROVIDERS.`,
  );
}

const s3 = new S3Client({});

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
const existingIndex = await tryFetchIndex(indexKey);
const newRun = {
  date: BENCH_DATE,
  multiSdk: {
    reportPath: `${BENCH_DATE}/multi-sdk.json`,
    successRate: report?.meta?.successRate ?? 0,
    totalRuns: report?.meta?.totalRuns ?? 0,
    headline: buildHeadline(report),
  },
};

const updatedIndex = mergeIndex(existingIndex, newRun);
await s3.send(
  new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: indexKey,
    Body: JSON.stringify(updatedIndex, null, 2),
    ContentType: 'application/json',
    CacheControl: 'public, max-age=60',
  }),
);
console.log(`[run-and-publish] uploaded index: s3://${S3_BUCKET}/${indexKey}`);
console.log(`[run-and-publish] done.`);

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
    if (!out.Body) return null;
    const buf = Buffer.from(await out.Body.transformToByteArray());
    return JSON.parse(buf.toString('utf-8'));
  } catch (err) {
    if (err && (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404)) {
      return null;
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

