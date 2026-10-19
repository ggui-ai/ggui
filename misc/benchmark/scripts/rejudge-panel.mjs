#!/usr/bin/env node
/* eslint-disable no-console -- CLI: its stdout lines are the operator's receipt. */
/**
 * Re-judge stored sources with named judge panels (#1798).
 *
 *   node --import tsx scripts/rejudge-panel.mjs --run <report.json> --sources <dir>
 *        --panels v4-panel,cand-anthropic-haiku-5-5 --out <rows.jsonl> --stop-usd <n> [--dry]
 *
 * <report.json> is a bench run's report; <dir> holds the sources that run kept
 * (`--sources-dir`, one `<variant>-<commit>-<ms>.tsx` per cell). Every cell is
 * scored by every named panel, with the prompt and contract its commit carries,
 * exactly as the run's own panel call scored it. Each row records the stored
 * panel score beside the new one, so a same-session `v4-panel` re-judge doubles
 * as the noise floor.
 *
 * --dry prices the job without a call: each panel's cost per cell is the stored
 * judges' token counts priced at that panel's models.
 *
 * The stop is checked BEFORE each call against the spend so far plus the
 * dearest call yet, so the call that would cross it never starts. Rows already
 * in --out are skipped, so an interrupted job resumes where it stopped.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { JUDGE_PANELS, buildJudgeUserMessage, evaluateAestheticsPanel, parseJudgePanelId, selectPanelPrompt } from '../src/multi-sdk/post-eval.ts';
import { calculateCost, judgePanelCostUsd, resolveJudgeCostModelId } from '../src/multi-sdk/runner.ts';
import { commitForRef } from '../src/exp008/eval-cell.ts';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
function need(name) {
  const v = arg(name);
  if (v === undefined || v === '') throw new Error(`rejudge-panel: ${name} is required`);
  return v;
}

const runPath = need('--run');
const sourcesDir = need('--sources');
const panelIds = need('--panels').split(',').map(parseJudgePanelId);
const dry = process.argv.includes('--dry');
const outPath = dry ? undefined : need('--out');
const stopUsd = dry ? Infinity : Number(need('--stop-usd'));
if (!(stopUsd > 0)) throw new Error('rejudge-panel: --stop-usd must be a positive number');

const report = JSON.parse(readFileSync(runPath, 'utf8'));
const files = readdirSync(sourcesDir).filter((f) => f.endsWith('.tsx'));

/** The one source this run kept for a cell — loud on none or several, never a guess. */
function sourceFor(variantId, commitId) {
  const prefix = `${variantId}-${commitId}-`;
  const hits = files.filter((f) => f.startsWith(prefix) && /^\d+\.tsx$/.test(f.slice(prefix.length)));
  if (hits.length !== 1) throw new Error(`rejudge-panel: ${hits.length} sources for ${variantId} × ${commitId} in ${sourcesDir}`);
  return hits[0];
}

const cells = report.results.map((r) => ({ variant: r.variant.id, commit: r.commit.id, stored: r.evaluation ?? null }));

/**
 * A dry price. The published report keeps no judge token counts, so input is
 * the real judge request (system prompt + user message) at 4 characters a
 * token, and output is DRY_OUTPUT_TOKENS per judge, a stated allowance above
 * the ~150-word JSON critique the prompt asks for.
 */
const DRY_OUTPUT_TOKENS = 600;
function dryCost(source, commit, panelId) {
  const input = Math.ceil((selectPanelPrompt(undefined).prompt.length + buildJudgeUserMessage(source, commit.prompt, commit.contract).length) / 4);
  return JUDGE_PANELS[panelId].reduce((usd, seat) => usd + calculateCost(resolveJudgeCostModelId(seat.model), { input, output: DRY_OUTPUT_TOKENS }), 0);
}

if (dry) {
  for (const panelId of panelIds) {
    const sum = cells.reduce((usd, c) => usd + dryCost(readFileSync(join(sourcesDir, sourceFor(c.variant, c.commit)), 'utf8'), commitForRef(c.commit), panelId), 0);
    console.log(`[rejudge] dry ${panelId}: ${cells.length} cells, $${sum.toFixed(4)} (input at 4 chars/token, output ${DRY_OUTPUT_TOKENS} tokens/judge)`);
  }
  process.exit(0);
}

const done = new Set(
  existsSync(outPath)
    ? readFileSync(outPath, 'utf8').split('\n').filter(Boolean).map((l) => {
        const r = JSON.parse(l);
        return `${r.run}|${r.variant}|${r.commit}|${r.panelId}`;
      })
    : [],
);
const runId = report.meta?.runId ?? runPath;
let spent = 0;
let dearest = 0;
let calls = 0;

outer: for (const cell of cells) {
  const file = sourceFor(cell.variant, cell.commit);
  const source = readFileSync(join(sourcesDir, file), 'utf8');
  const commit = commitForRef(cell.commit);
  for (const panelId of panelIds) {
    if (done.has(`${runId}|${cell.variant}|${cell.commit}|${panelId}`)) continue;
    if (spent + dearest > stopUsd) {
      console.log(`[rejudge] STOP before ${cell.variant} × ${cell.commit} × ${panelId}: spent $${spent.toFixed(4)} + dearest call $${dearest.toFixed(4)} > $${stopUsd}`);
      break outer;
    }
    const result = await evaluateAestheticsPanel(source, commit.prompt, commit.contract, { panelId });
    const costUsd = judgePanelCostUsd(result);
    spent += costUsd;
    dearest = Math.max(dearest, costUsd);
    calls += 1;
    appendFileSync(
      outPath,
      `${JSON.stringify({
        run: runId,
        variant: cell.variant,
        commit: cell.commit,
        source: file,
        sourceSha256: createHash('sha256').update(source).digest('hex'),
        panelId,
        stored: cell.stored && { score: cell.stored.score, dimensions: cell.stored.dimensions, judges: (cell.stored.panel ?? []).map((j) => ({ model: j.judge.model, promptVersion: j.judge.promptVersion, score: j.score, dimensions: j.dimensions })) },
        result: result && { score: result.score, dimensions: result.dimensions, spread: result.spread, promptVersion: result.promptVersion, judges: result.judges.map((j) => ({ model: j.judge.model, score: j.score, dimensions: j.dimensions, critique: j.critique, tokens: j.tokens })) },
        costUsd,
      })}\n`,
    );
    console.log(`[rejudge] ${cell.variant} × ${cell.commit} × ${panelId}: ${result ? result.score : 'no panel'} ($${costUsd.toFixed(4)}; total $${spent.toFixed(4)})`);
  }
}
console.log(`[rejudge] done: ${calls} panel call(s), $${spent.toFixed(4)} of $${stopUsd}`);
