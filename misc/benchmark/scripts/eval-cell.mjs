#!/usr/bin/env node
/* eslint-disable no-console -- CLI entrypoint: stdout/stderr lines are the task's log contract (awslogs), not debug noise. */
/**
 * Exp 008 EVAL task entrypoint (#973 / cloud #975).
 *
 *   node --import tsx scripts/eval-cell.mjs --cell <s3://bucket/exp008/<runId>/<cellId>/ | local-dir>
 *                                          [--panel-prompt arm-neutral|default] [--no-visual]
 *
 * ONE code path: an S3 locator is synced down to a temp dir, evaluated, and
 * `report.json` + `canvas-<class>.png` are written back under the SAME prefix
 * (nothing else); a local dir is evaluated in place. Exit 0 = report written
 * (the verdict may be FAIL); non-zero = the eval itself failed.
 *
 * Env: BENCH_PLAYWRIGHT=1 (image default) enables Chromium for
 * contractBehavior; judge keys ANTHROPIC_API_KEY / OPENAI_API_KEY /
 * GEMINI_API_KEY as container secrets.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { loadPlaywright } from './lib/load-playwright.mjs';
import { parseCellLocator, readCellInputs, evaluateCell, toVisualOutcome } from '../src/exp008/eval-cell.ts';

function getArg(names, fallback) {
  const i = process.argv.findIndex((a) => names.includes(a));
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const hasFlag = (names) => process.argv.some((a) => names.includes(a));

const locatorArg = getArg(['--cell'], process.env.CELL_S3_URI);
if (!locatorArg) {
  console.error('eval-cell: --cell <s3://… | dir> (or CELL_S3_URI) is required');
  process.exit(2);
}
const panelPrompt = getArg(['--panel-prompt'], process.env.BENCH_PANEL_PROMPT ?? 'arm-neutral');
if (panelPrompt !== 'default' && panelPrompt !== 'arm-neutral') {
  console.error(`eval-cell: --panel-prompt must be 'default' or 'arm-neutral' (got '${panelPrompt}')`);
  process.exit(2);
}
const visualEnabled = !hasFlag(['--no-visual']);
/** The pinned visual judge (rnd §5b): a vision-capable model that is NOT under test in Exp 008. */
const VISUAL_JUDGE = { provider: 'claude', model: 'claude-sonnet-5', passThreshold: 60 };
const locator = parseCellLocator(locatorArg);

async function syncDown(s3, bucket, prefix, dir) {
  // Paginate even though a cell prefix is small by contract — a truncated
  // listing would be a silent partial cell.
  const keys = [];
  let token;
  do {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }));
    for (const o of listed.Contents ?? []) if (o.Key && !o.Key.endsWith('/')) keys.push(o.Key);
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
  for (const key of keys) {
    const rel = key.slice(prefix.length);
    if (rel.includes('/')) continue; // the cell prefix is flat by contract
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = Buffer.from(await obj.Body.transformToByteArray());
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), bytes);
  }
  console.log(`[eval-cell] synced ${keys.length} object(s) from s3://${bucket}/${prefix}`);
}

async function syncUp(s3, bucket, prefix, dir) {
  const outputs = readdirSync(dir).filter((f) => f === 'report.json' || /^canvas-.+\.png$/.test(f));
  for (const f of outputs) {
    const body = readFileSync(join(dir, f));
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: `${prefix}${f}`, Body: body,
      ContentType: f.endsWith('.png') ? 'image/png' : 'application/json',
    }));
  }
  console.log(`[eval-cell] wrote ${outputs.length} output(s) to s3://${bucket}/${prefix}`);
}

async function main() {
  const s3 = locator.kind === 's3' ? new S3Client({}) : null;
  const dir = locator.kind === 'dir' ? locator.dir : mkdtempSync(join(tmpdir(), 'exp008-cell-'));
  if (locator.kind === 's3') await syncDown(s3, locator.bucket, locator.prefix, dir);

  const inputs = readCellInputs(dir);
  console.log(`[eval-cell] cell ${inputs.mint.cellId} run ${inputs.mint.runId} arm ${inputs.mint.arm} model ${inputs.mint.model} commit ${inputs.commit.id}`);

  const playwright = process.env.BENCH_PLAYWRIGHT === '1' || hasFlag(['--playwright']) ? await loadPlaywright() : undefined;
  if (!playwright) console.log('[eval-cell] no Playwright — contractBehavior on action commits will be SKIPPED with reason');

  // Per-canvas visual judge (#973 §5b): IDENTICAL across arms and models —
  // never one of the models under test judging itself. Runs ui-gen's
  // runVisualEvaluation directly on the minted compiled.js, once per canvas
  // class; the PNGs it returns are persisted beside source.tsx by the core.
  // A judge that cannot run (no browser, no key) returns null → recorded in
  // report.meta.notes, never a silent pass.
  const visual = visualEnabled
    ? async ({ compiledCode, originalPrompt, sampleProps }) => {
        const { runVisualEvaluation, CANVAS_CLASSES } = await import('@ggui-ai/ui-gen/evaluation');
        try {
          const r = await runVisualEvaluation(
            { compiledCode, originalPrompt },
            { ...VISUAL_JUDGE, ...(sampleProps ? { sampleProps } : {}), canvases: CANVAS_CLASSES },
          );
          return toVisualOutcome(r);
        } catch (err) {
          console.error(`[eval-cell] visual judge threw: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }
    : undefined;

  // The driver hands the MINT leg's receipt through the task env (see MintReceipt);
  // absent = recorded in report.meta.notes, never invented.
  const mintReceipt = process.env.MINT_IMAGE && process.env.MINT_SOURCE_SHA && process.env.MINT_PROMPT_DIGEST_CONSTRAINED && process.env.MINT_PROMPT_DIGEST_FREE
    ? {
        image: process.env.MINT_IMAGE,
        ...(process.env.MINT_IMAGE_DIGEST ? { imageDigest: process.env.MINT_IMAGE_DIGEST } : {}),
        sourceSha: process.env.MINT_SOURCE_SHA,
        promptDigests: { constrained: process.env.MINT_PROMPT_DIGEST_CONSTRAINED, free: process.env.MINT_PROMPT_DIGEST_FREE },
      }
    : undefined;
  const report = await evaluateCell(inputs, {
    ...(mintReceipt ? { mintReceipt } : {}),
    dir,
    ...(playwright ? { playwright } : {}),
    ...(visual ? { visual, visualJudge: VISUAL_JUDGE } : {}),
    ...(panelPrompt === 'default'
      ? { panel: async (source, prompt, contract) => (await import('../src/multi-sdk/post-eval.ts')).evaluateAestheticsPanel(source, prompt, contract) }
      : {}),
  });
  console.log(
    `[eval-cell] contractBehavior=${report.contractBehavior?.status ?? 'absent'}${report.contractBehavior?.ok === undefined ? '' : `/${report.contractBehavior.ok ? 'ok' : 'FAIL'}`} ` +
      `runtimeProbe=${report.runtimeProbeVerdict?.status ?? 'absent'}${report.runtimeProbeVerdict?.status === 'ran' ? `/${report.runtimeProbeVerdict.passed ? 'pass' : 'FAIL'}` : ''} ` +
      `panel=${report.evaluation ? report.evaluation.score.toFixed(1) : 'null'} visual=${report.meta.visual ? report.meta.visual.score.toFixed(1) : 'n/a'} notes=${report.meta.notes.length}`,
  );
  if (locator.kind === 's3') await syncUp(s3, locator.bucket, locator.prefix, dir);
}

main().catch((err) => {
  console.error(`[eval-cell] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
