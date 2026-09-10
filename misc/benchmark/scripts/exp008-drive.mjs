#!/usr/bin/env node
/* eslint-disable no-console -- operator CLI: stdout is the run log; receipts are copied from it. */
/**
 * Exp 008 Stage-1 driver (#973; cloud's #975 lanes; design §6/§7).
 *
 *   node --import tsx scripts/exp008-drive.mjs --run-id <id> --mint-model-env <ENV> [--n 3]
 *        [--models anthropic/claude-fable-5-1,openai/gpt-6-astra] [--canvas md] [--cells id1,id2]
 *        [--concurrency 8] [--dry-run] [--eval-only | --mint-only]
 *        [--manifest <path>] [--mint-source-sha <sha>]
 *        [--prompt-digest-constrained <sha256>] [--prompt-digest-free <sha256>]
 *
 * Per cell, with OPERATOR credentials (the tasks' roles do the writes):
 *   RunTask MINT (experiment mode: contract inline) → poll <prefix>mint.json
 *   → assert contract.json.contractKey == blueprintKey(commit.contract)
 *   → RunTask EVAL (image ggui-benchmark-runner:<pinned>) → poll <prefix>report.json.
 * A cell whose task stops before its artefact exists fails fast with the
 * task's stoppedReason. Exit 0 = every selected cell has report.json (the
 * VERDICT may be FAIL — that is the verdict script's business); 1 otherwise.
 * --dry-run prints the matrix + override payload sizes and touches no AWS.
 * --mint-only runs the MINT leg for every cell (contract key still asserted)
 * and stops; exit 0 = every cell has mint.json. A later --eval-only on the
 * same --run-id runs the EVAL leg over those prefixes — the two legs may bind
 * to different images on purpose (e.g. mint on the pod that is the measured
 * triad, eval on a judge fixed afterwards). The two flags are exclusive.
 * --manifest <path> is the run's RECEIPT file (required with --mint-only):
 * for every cell the mint task's image + imageDigest + timings, read from
 * DescribeTasks the moment mint.json lands, plus the operator-declared pod
 * source sha and prompt digests (--mint-source-sha, --prompt-digest-*) that
 * the verdict checks against the experiment's pins. --eval-only reads the
 * same file to hand those values to the eval task.
 *
 * PRECONDITION: the mint image on the target env must run the pod's EXPERIMENT
 * mode (the inline-contract, S3-export contract of ggui#975 d1/d1f); against an
 * older mint the first task stops on a missing env and the cell fails fast —
 * nothing is exported, nothing is evaluated. Lane names (cluster, the two task
 * families, the SSM network parameter, the bucket, the app id) are per-env
 * inputs — flags or EXP008_* env — and are never defaults in this package.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ECSClient, RunTaskCommand, DescribeTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { S3Client, HeadObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { buildStage1Cells, buildMintOverrides, buildEvalOverrides, cellPrefixUri, parseNetworkParameter, runTaskOverridesPayload } from '../src/exp008/driver.ts';
import { createLimiter } from '../src/multi-sdk/post-eval.ts';

const argv = process.argv.slice(2);
const getArg = (names, fallback) => { const i = argv.findIndex((a) => names.includes(a)); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback; };
const hasFlag = (names) => argv.some((a) => names.includes(a));

const runId = getArg(['--run-id'], null);
const modelEnvName = getArg(['--mint-model-env'], null);
if (!runId || !modelEnvName) {
  console.error('exp008-drive: --run-id and --mint-model-env are required (the model env name is cloud\'s pin; no default on purpose)');
  process.exit(2);
}
const n = parseInt(getArg(['--n'], '3'), 10);
const models = getArg(['--models'], 'anthropic/claude-fable-5-1,openai/gpt-6-astra').split(',').map((s) => s.trim()).filter(Boolean);
const canvas = getArg(['--canvas'], 'md');
const onlyCells = (getArg(['--cells'], '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const concurrency = parseInt(getArg(['--concurrency'], '8'), 10);
const dryRun = hasFlag(['--dry-run']);
const evalOnly = hasFlag(['--eval-only']);
const mintOnly = hasFlag(['--mint-only']);
const manifestPath = getArg(['--manifest'], process.env.EXP008_MANIFEST ?? null);
const declared = {
  mintSourceSha: getArg(['--mint-source-sha'], null),
  promptDigestConstrained: getArg(['--prompt-digest-constrained'], null),
  promptDigestFree: getArg(['--prompt-digest-free'], null),
};
if (mintOnly && !manifestPath) {
  console.error('exp008-drive: --mint-only requires --manifest <path> — a mint without its image/digest receipt is not a Stage 1 cell');
  process.exit(2);
}
if (evalOnly && mintOnly) {
  console.error('exp008-drive: --eval-only and --mint-only are exclusive — one leg per invocation');
  process.exit(2);
}
const cfg = {
  // Account-specific values are NEVER defaults in this (mirrored) package: pass
  // them per run (--app-id / --bucket) or via EXP008_APP_ID / EXP008_BUCKET.
  appId: getArg(['--app-id'], process.env.EXP008_APP_ID ?? null),
  bucket: getArg(['--bucket'], process.env.EXP008_BUCKET ?? null),
  cluster: getArg(['--cluster'], process.env.EXP008_CLUSTER ?? null),
  mintFamily: getArg(['--mint-family'], process.env.EXP008_MINT_FAMILY ?? null),
  evalFamily: getArg(['--eval-family'], process.env.EXP008_EVAL_FAMILY ?? null),
  networkParam: getArg(['--network-param'], process.env.EXP008_NETWORK_PARAM ?? null),
  mintTimeoutMs: parseInt(getArg(['--mint-timeout-ms'], '600000'), 10),
  evalTimeoutMs: parseInt(getArg(['--eval-timeout-ms'], '900000'), 10),
};

for (const [flag, value] of [['--app-id', cfg.appId], ['--bucket', cfg.bucket], ['--cluster', cfg.cluster], ['--mint-family', cfg.mintFamily], ['--eval-family', cfg.evalFamily], ['--network-param', cfg.networkParam]]) {
  if (!value) {
    console.error(`exp008-drive: ${flag} (or its EXP008_* env) is required — lane names and account-specific values are never defaults in this package`);
    process.exit(2);
  }
}

const arms = { A: { designMode: 'constrained' }, B: { designMode: 'free' } };
let cells = buildStage1Cells({ runId, n, models, arms, canvas });
if (onlyCells.length) cells = cells.filter((c) => onlyCells.includes(c.cellId));
console.log(`[exp008] run ${runId}: ${cells.length} cell(s) — n=${n}, models=${models.join(',')}, canvas=${canvas}, arms=${Object.keys(arms).join('/')}`);

if (dryRun) {
  for (const c of cells) {
    const mint = buildMintOverrides(c, { appId: cfg.appId, bucket: cfg.bucket, modelEnvName });
    const evalO = buildEvalOverrides(c, { bucket: cfg.bucket });
    console.log(`  ${c.cellId.padEnd(40)} key=${c.contractKey} mint=${Buffer.byteLength(JSON.stringify(mint))}B eval=${Buffer.byteLength(JSON.stringify(evalO))}B → ${cellPrefixUri(cfg.bucket, c)}`);
  }
  console.log('[exp008] dry run — nothing launched');
  process.exit(0);
}

const region = process.env.AWS_REGION ?? 'us-east-1';
const ecs = new ECSClient({ region });
const ssm = new SSMClient({ region });
const s3 = new S3Client({ region });

async function networkConfiguration() {
  const p = await ssm.send(new GetParameterCommand({ Name: cfg.networkParam }));
  return parseNetworkParameter(p.Parameter?.Value ?? '{}', cfg.networkParam);
}

/** A run id is used once: refuse to launch into a prefix that already has objects unless resuming with --eval-only. */
async function assertRunPrefixFresh() {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: `exp008/${runId}/`, MaxKeys: 1 }));
  if ((listed.KeyCount ?? 0) > 0 && !evalOnly) {
    throw new Error(`exp008: prefix exp008/${runId}/ already has objects — a run id is used once; pick a new --run-id, or pass --eval-only to resume this one`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTask(family, override, network) {
  const res = await ecs.send(new RunTaskCommand({
    cluster: cfg.cluster, taskDefinition: family, launchType: 'FARGATE', count: 1, networkConfiguration: network,
    overrides: runTaskOverridesPayload(override),
  }));
  const failure = res.failures?.[0];
  if (failure) throw new Error(`RunTask ${family} failed: ${failure.reason ?? 'unknown'} ${failure.detail ?? ''}`);
  const arn = res.tasks?.[0]?.taskArn;
  if (!arn) throw new Error(`RunTask ${family}: no task in response`);
  return arn;
}

async function objectExists(bucket, key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false;
    throw err;
  }
}

async function taskStopped(arn) {
  const d = await ecs.send(new DescribeTasksCommand({ cluster: cfg.cluster, tasks: [arn] }));
  const t = d.tasks?.[0];
  if (!t) return null;
  if (t.lastStatus === 'STOPPED') return { reason: t.stoppedReason ?? 'stopped', exit: t.containers?.[0]?.exitCode };
  return null;
}

/** Wait for `key` under the cell prefix; fail fast if the task stops first without producing it. */
async function awaitArtefact(arn, bucket, key, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await objectExists(bucket, key)) return;
    const stopped = await taskStopped(arn);
    if (stopped) {
      if (await objectExists(bucket, key)) return;
      throw new Error(`${label}: task stopped (${stopped.reason}, exit ${stopped.exit ?? 'n/a'}) without writing ${key}`);
    }
    await sleep(10_000);
  }
  // Cost containment: a task that outlived its budget is stopped, never left running.
  await ecs.send(new StopTaskCommand({ cluster: cfg.cluster, task: arn, reason: `exp008: ${label} exceeded ${timeoutMs}ms` })).catch(() => undefined);
  throw new Error(`${label}: timed out after ${timeoutMs}ms waiting for ${key} (task stopped)`);
}

async function readJson(bucket, key) {
  const o = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(Buffer.from(await o.Body.transformToByteArray()).toString('utf8'));
}

function loadManifest() {
  if (!manifestPath) return null;
  if (fs.existsSync(manifestPath)) return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { runId, createdAt: new Date().toISOString(), lane: { cluster: cfg.cluster, mintFamily: cfg.mintFamily, evalFamily: cfg.evalFamily, bucket: cfg.bucket }, declared, cells: {} };
}
const manifest = loadManifest();
function saveManifest() {
  if (!manifest) return;
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, manifestPath);
}
async function describeMintTask(arn) {
  const d = await ecs.send(new DescribeTasksCommand({ cluster: cfg.cluster, tasks: [arn] }));
  const t = d.tasks?.[0];
  const c = t?.containers?.[0];
  if (!t || !c?.image) throw new Error(`mint task ${arn} vanished before its image could be recorded — no receipt, no cell`);
  return { taskArn: arn, image: c.image, imageDigest: c.imageDigest ?? null, startedAt: t.startedAt?.toISOString() ?? null, stoppedAt: t.stoppedAt?.toISOString() ?? null, taskDefinitionArn: t.taskDefinitionArn ?? null };
}

async function driveCell(cell, network) {
  const prefix = `exp008/${cell.runId}/${cell.cellId}/`;
  const t0 = Date.now();
  if (!evalOnly || !(await objectExists(cfg.bucket, `${prefix}mint.json`))) {
    const mintArn = await runTask(cfg.mintFamily, buildMintOverrides(cell, { appId: cfg.appId, bucket: cfg.bucket, modelEnvName }), network);
    console.log(`[exp008] ${cell.cellId}: mint ${mintArn.split('/').pop()}`);
    await awaitArtefact(mintArn, cfg.bucket, `${prefix}mint.json`, cfg.mintTimeoutMs, `${cell.cellId} mint`);
    if (manifest) {
      manifest.cells[cell.cellId] = { prefix, contractKey: cell.contractKey, mint: await describeMintTask(mintArn) };
      saveManifest();
    }
  }
  const contract = await readJson(cfg.bucket, `${prefix}contract.json`);
  if (contract.contractKey !== cell.contractKey) {
    throw new Error(`${cell.cellId}: exported contractKey ${contract.contractKey} ≠ computed ${cell.contractKey} — refusing to evaluate a cell minted for another contract`);
  }
  if (mintOnly) {
    console.log(`[exp008] ${cell.cellId}: MINTED ${Math.round((Date.now() - t0) / 1000)}s (mint-only; eval deferred)`);
    return { cellId: cell.cellId, ok: true, ms: Date.now() - t0, mintOnly: true };
  }
  const rec = manifest?.cells?.[cell.cellId]?.mint;
  const mintReceipt = rec && manifest.declared?.mintSourceSha && manifest.declared?.promptDigestConstrained && manifest.declared?.promptDigestFree
    ? { image: rec.image, ...(rec.imageDigest ? { imageDigest: rec.imageDigest } : {}), sourceSha: manifest.declared.mintSourceSha, promptDigestConstrained: manifest.declared.promptDigestConstrained, promptDigestFree: manifest.declared.promptDigestFree }
    : undefined;
  if (!mintReceipt) console.warn(`[exp008] ${cell.cellId}: NO MINT RECEIPT in the manifest — the eval task runs without MINT_* env and the row will say so`);
  const evalArn = await runTask(cfg.evalFamily, buildEvalOverrides(cell, { bucket: cfg.bucket, ...(mintReceipt ? { mintReceipt } : {}) }), network);
  console.log(`[exp008] ${cell.cellId}: eval ${evalArn.split('/').pop()}`);
  await awaitArtefact(evalArn, cfg.bucket, `${prefix}report.json`, cfg.evalTimeoutMs, `${cell.cellId} eval`);
  const report = await readJson(cfg.bucket, `${prefix}report.json`);
  const cb = report.contractBehavior?.status, rp = report.runtimeProbeVerdict?.status, vis = report.meta?.visual?.score;
  console.log(`[exp008] ${cell.cellId}: DONE ${Math.round((Date.now() - t0) / 1000)}s contractBehavior=${cb} probe=${rp} visual=${vis ?? 'n/a'} cost=$${(report.estimatedCostUsd ?? 0).toFixed(3)}`);
  return { cellId: cell.cellId, ok: true, ms: Date.now() - t0 };
}

async function main() {
  await assertRunPrefixFresh();
  const network = await networkConfiguration();
  const limit = createLimiter(concurrency);
  const results = await Promise.all(cells.map((cell) => limit(async () => {
    try { return await driveCell(cell, network); } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[exp008] ${cell.cellId}: FAILED — ${message}`);
      return { cellId: cell.cellId, ok: false, error: message };
    }
  })));
  const ok = results.filter((r) => r.ok).length;
  console.log(`[exp008] run ${runId}: ${ok}/${results.length} cells have ${mintOnly ? 'mint.json (mint-only; run --eval-only on this --run-id for the eval leg)' : 'report.json'}${ok < results.length ? ` — failed: ${results.filter((r) => !r.ok).map((r) => r.cellId).join(', ')}` : ''}`);
  if (!mintOnly) console.log(`[exp008] evidence: aws s3 sync s3://${cfg.bucket}/exp008/${runId}/ <dir> && python3 rnd/gen-ui/tools/exp008-verdict.py <dir>`);
  process.exit(ok === results.length ? 0 : 1);
}

main().catch((err) => { console.error(`[exp008] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`); process.exit(1); });
