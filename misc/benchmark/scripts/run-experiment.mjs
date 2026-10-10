#!/usr/bin/env node
/* eslint-disable no-console -- CLI entrypoint: its log lines ARE the run's operator record */
/**
 * Container entrypoint for a scoped benchmark EXPERIMENT: named arms × prompts × repetitions, with a cost cap,
 * written to a private prefix and never published.
 *
 *   1. Read the spec from s3://<S3_BUCKET>/<EXP_SPEC_KEY> (default `experiments/queue/next.json`) and validate it
 *      (`experiment-spec.mjs`); every arm id must be registered (`resolveRunVariants` throws on an unknown one).
 *   2. Refuse an id that already has a receipt — an experiment id is used once.
 *   3. For each repetition: run `bench.mjs` on exactly those arms and prompts with the generated sources retained;
 *      upload the report and the sources under `experiments/<id>/`; before the next repetition, stop if another one
 *      would pass the cap (`decideNextRep`).
 *   4. Write `experiments/<id>/receipt.json`: the spec, the image (`GIT_SHA`, `BENCH_SOURCE_HASH` from the
 *      container env), each repetition's report key, cell count and generation cost, and the stop reason if any.
 *
 * Nothing here writes the public dashboard's prefix. Exits non-zero on any failure, after writing the receipt with
 * the failure recorded.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { decideNextRep, parseExperimentSpec } from './experiment-spec.mjs';
import { resolveRunVariants } from '../src/multi-sdk/variants.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, '..');

const S3_BUCKET = process.env.S3_BUCKET;
const SPEC_KEY = process.env.EXP_SPEC_KEY ?? 'experiments/queue/next.json';
const CONCURRENCY = process.env.BENCH_CONCURRENCY ?? '12';
if (!S3_BUCKET) {
  console.error('[run-experiment] missing required env var: S3_BUCKET');
  process.exit(1);
}
const s3 = new S3Client({});
const log = (m) => console.log(`[run-experiment] ${m}`);

async function readSpec() {
  const out = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: SPEC_KEY }));
  if (!out.Body) throw new Error(`spec object ${SPEC_KEY} has no body`);
  return JSON.parse(Buffer.from(await out.Body.transformToByteArray()).toString('utf-8'));
}

async function exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && '$metadata' in err && err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

async function put(key, body, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
}

function runBench(spec, sourcesDir) {
  const variants = resolveRunVariants(spec.variants);
  const providers = [...new Set(variants.map((v) => v.sdkName))].join(',');
  const tiers = [...new Set(variants.map((v) => v.tier))].join(',');
  return new Promise((resolveP, rejectP) => {
    const child = spawn(
      'node',
      [
        '--import', 'tsx', 'scripts/bench.mjs',
        '--provider', providers,
        '--tier', tiers,
        '--variant', spec.variants.join(','),
        '--commit', spec.commits.join(','),
        '--threshold', '70',
        '--timeout', '600000',
        '--concurrency', CONCURRENCY,
      ],
      { cwd: BENCH_ROOT, stdio: 'inherit', env: { ...process.env, GGUI_BENCH_SOURCES_DIR: sourcesDir } },
    );
    child.on('exit', (code) => (code === 0 ? resolveP(undefined) : rejectP(new Error(`bench exited with code ${code}`))));
    child.on('error', rejectP);
  });
}

function newestReport(dir, notBefore) {
  const reports = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ full: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .filter((r) => r.mtime >= notBefore)
    .sort((a, b) => b.mtime - a.mtime);
  if (reports.length === 0) throw new Error(`no new .json report in ${dir}`);
  return reports[0].full;
}

async function main() {
  const spec = parseExperimentSpec(await readSpec());
  resolveRunVariants(spec.variants); // throws on an unregistered arm, before any spend
  const prefix = `experiments/${spec.id}/`;
  const receiptKey = `${prefix}receipt.json`;
  if (await exists(receiptKey)) throw new Error(`experiment ${spec.id} already has a receipt (${receiptKey}); ids are used once`);

  const receipt = {
    id: spec.id,
    spec,
    image: { gitSha: process.env.GIT_SHA ?? null, benchSourceHash: process.env.BENCH_SOURCE_HASH ?? null },
    startedAt: new Date().toISOString(),
    finishedAt: null,
    runs: [],
    totalGenCostUsd: 0,
    stopped: null,
    failure: null,
  };
  log(`experiment ${spec.id}: ${spec.variants.join(',')} × ${spec.commits.length} prompts × ${spec.reps}, cap $${spec.costCapUsd}`);

  const resultsDir = resolve(BENCH_ROOT, 'benchmark-results');
  let lastRepUsd = null;
  try {
    for (let rep = 1; rep <= spec.reps; rep++) {
      const decision = decideNextRep({ capUsd: spec.costCapUsd, spentUsd: receipt.totalGenCostUsd, lastRepUsd });
      if (decision.stop) {
        receipt.stopped = { beforeRep: rep, reason: `projected $${decision.projectedUsd.toFixed(2)} > cap $${spec.costCapUsd}` };
        log(`COST STOP before repetition ${rep}: ${receipt.stopped.reason}`);
        break;
      }
      const sourcesDir = `/tmp/experiment-sources-${rep}`;
      mkdirSync(sourcesDir, { recursive: true });
      const started = Date.now();
      await runBench(spec, sourcesDir);
      const reportPath = newestReport(resultsDir, started);
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      const cost = report.results.reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0);
      const reportKey = `${prefix}run${rep}.json`;
      await put(reportKey, readFileSync(reportPath), 'application/json');
      const sources = existsSync(sourcesDir) ? readdirSync(sourcesDir) : [];
      for (const f of sources) await put(`${prefix}sources/run${rep}/${f}`, readFileSync(join(sourcesDir, f)), 'text/plain');
      receipt.runs.push({ rep, reportKey, reportId: report.meta?.reportId ?? null, cells: report.results.length, genCostUsd: Number(cost.toFixed(4)), sources: sources.length });
      receipt.totalGenCostUsd = Number((receipt.totalGenCostUsd + cost).toFixed(4));
      lastRepUsd = cost;
      log(`repetition ${rep}: ${report.results.length} cells, $${cost.toFixed(4)} generation; total $${receipt.totalGenCostUsd}`);
    }
  } catch (err) {
    receipt.failure = String(err);
    throw err;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await put(receiptKey, JSON.stringify(receipt, null, 2), 'application/json');
    log(`receipt written: s3://${S3_BUCKET}/${receiptKey}`);
  }
}

main().catch((err) => {
  console.error(`[run-experiment] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
