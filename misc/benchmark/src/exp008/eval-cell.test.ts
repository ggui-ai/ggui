import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCellInputs,
  commitForRef,
  parseCellLocator,
  variantForModel,
  deriveRuntimeProbeVerdictFromExport,
  evaluateCell,
  toVisualOutcome,
  visualJudgeCostUsd,
  EXP008_CELL_REPORT_VERSION,
  MINT_RECEIPT_ABSENT_NOTE,
} from './eval-cell';
import type { VisualEvaluationResult } from '@ggui-ai/ui-gen/evaluation';
import { calculateCost, resolveJudgeCostModelId, resolveCostModelId } from '../multi-sdk/runner.js';
import type { PanelEvalResult } from '../multi-sdk/post-eval.js';
import type { PlaywrightModule } from '@ggui-ai/ui-visual-tester';

function cellDir(opts: { evalJson?: boolean; commit?: string | null } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'exp008-cell-'));
  writeFileSync(join(dir, 'compiled.js'), 'export default function C(){return null}');
  writeFileSync(join(dir, 'source.tsx'), 'export default function C(){ return <div/> }');
  writeFileSync(join(dir, 'contract.json'), JSON.stringify({ contract: {}, contractKey: 'k1', commitRef: opts.commit === undefined ? 'weather-card' : opts.commit }));
  writeFileSync(join(dir, 'mint.json'), JSON.stringify({ cellId: 'c1', runId: 'r1', arm: 'B', model: 'openai/gpt-6-astra', codeHash: 'abc', latencyMs: 1234, generationTimeMs: 1200, turnsUsed: 2, passesUsed: 1, tokens: { input: 1000, output: 500 }, designMode: 'free', canvas: 'md', requested: { designMode: 'free', canvas: 'md' } }));
  if (opts.evalJson) {
    writeFileSync(join(dir, 'eval.json'), JSON.stringify({ issues: [], pass: ['functionality'], runtimeProbe: { status: 'ran' } }));
  }
  return dir;
}

const panel = async (): Promise<PanelEvalResult | null> => ({
  passed: true, score: 77, spread: 0, evalTimeMs: 1, critique: '',
  dimensions: { layout: 77, designTokens: 77, hierarchy: 77, polish: 77, dataPresentation: 77 },
  judges: [], promptVersion: 'aesthetic-eval.v3-panel-arm-neutral',
});

const neverLaunch: PlaywrightModule = { chromium: { launch: async () => { throw new Error('unit test: no browser'); } } };

describe('parseCellLocator', () => {
  it('splits an s3 URI into bucket + prefix (trailing slash normalised) and passes a dir through', () => {
    expect(parseCellLocator('s3://b/exp008/r1/c1')).toEqual({ kind: 's3', bucket: 'b', prefix: 'exp008/r1/c1/' });
    expect(parseCellLocator('s3://b/exp008/r1/c1/')).toEqual({ kind: 's3', bucket: 'b', prefix: 'exp008/r1/c1/' });
    expect(parseCellLocator('/tmp/x')).toEqual({ kind: 'dir', dir: '/tmp/x' });
  });
  it('is loud for an S3 URI without a cell prefix — never a silent filesystem path', () => {
    expect(() => parseCellLocator('s3://bucket')).toThrow(/bucket AND a cell prefix/);
    expect(() => parseCellLocator('s3://bucket/')).toThrow(/bucket AND a cell prefix/);
  });
});

describe('readCellInputs (cloud #975 export: compiled.js, source.tsx, contract.json, mint.json, eval.json?)', () => {
  it('reads every file, resolves the commit by contractRef and the public arm by model id', () => {
    const inputs = readCellInputs(cellDir({ evalJson: true }));
    expect(inputs.mint.cellId).toBe('c1');
    expect(inputs.commit.id).toBe('weather-card');
    expect(inputs.variant.id).toBe('openai-frontier');
    expect(inputs.compiledCode).toContain('export default');
    expect(inputs.sourceCode).toContain('<div/>');
    expect(inputs.evalResult?.runtimeProbe?.status).toBe('ran');
  });

  it('tolerates a missing eval.json (mint hook not landed) — evalResult undefined, nothing else changes', () => {
    const inputs = readCellInputs(cellDir());
    expect(inputs.evalResult).toBeUndefined();
  });

  it('names the cause when the mint exported commitRef: null (MINT_COMMIT_REF unset) — the eval cannot pick a prompt', () => {
    expect(() => readCellInputs(cellDir({ commit: null }))).toThrow(/MINT_COMMIT_REF/);
  });

  it('reads cloud\'s mint.json fields as named (tokens input/output, keySource, mintMs)', () => {
    const dir = cellDir();
    writeFileSync(join(dir, 'mint.json'), JSON.stringify({ cellId: 'c1', runId: 'r1', arm: 'A', model: 'anthropic/claude-fable-5-1', keySource: 'platform', tokens: { input: 10, output: 20 }, latencyMs: 5, mintMs: 7, warnings: [] }));
    const inputs = readCellInputs(dir);
    expect(inputs.mint.tokens?.input).toBe(10);
    expect(inputs.mint.mintMs).toBe(7);
    expect(inputs.mint.keySource).toBe('platform');
  });

  it('fails loudly on an unknown commit ref — never a silent default', () => {
    expect(() => commitForRef('no-such-commit')).toThrow(/no-such-commit/);
    expect(() => readCellInputs(cellDir({ commit: 'no-such-commit' }))).toThrow(/no-such-commit/);
  });
});

describe('variantForModel', () => {
  it('maps a model id to its public arm and is loud for a model outside the matrix', () => {
    expect(variantForModel('anthropic/claude-fable-5-1').id).toBe('claude-frontier');
    expect(() => variantForModel('openai/gpt-99')).toThrow(/gpt-99/);
  });
});

describe('the visual judge receives what the harness passes: compiled code, the commit prompt, the commit fixture props', () => {
  it('threads commit.props as sampleProps', async () => {
    const dir = cellDir();
    let seen: { originalPrompt: string; sampleProps?: unknown } | undefined;
    await evaluateCell(readCellInputs(dir), {
      dir, playwright: neverLaunch, panel,
      visual: async (ctx) => { seen = { originalPrompt: ctx.originalPrompt, sampleProps: ctx.sampleProps }; return null; },
    });
    expect(seen?.originalPrompt).toBe(commitForRef('weather-card').prompt);
    expect(seen?.sampleProps).toEqual(commitForRef('weather-card').props);
  });
});

describe('toVisualOutcome — typed against ui-gen\'s VisualEvaluationResult (the aggregate is finalScore)', () => {
  const real: VisualEvaluationResult = {
    passed: true,
    finalScore: 81,
    dimensions: { completeness: 80, visualPolish: 82, interactivity: 81, accessibility: 81, codeQuality: 81 },
    issues: [],
    inputTokens: 3000,
    outputTokens: 200,
    canvases: [{ canvas: 'xl', viewport: { width: 1440, height: 900 }, score: 81, passed: true, screenshotPng: Buffer.from('89504e47', 'hex') }],
  };
  it('maps finalScore/passed/canvases/tokens; null stays null', () => {
    expect(toVisualOutcome(null)).toBeNull();
    const o = toVisualOutcome(real);
    expect(o).toMatchObject({ score: 81, passed: true, tokens: { input: 3000, output: 200 } });
    expect(o?.canvases?.[0]?.canvas).toBe('xl');
  });
  it('prices the visual judge like a panel judge (registry resolution by suffix) and 0 without tokens', () => {
    const judge = { provider: 'claude' as const, model: 'claude-sonnet-5', passThreshold: 60 };
    const expected = calculateCost(resolveJudgeCostModelId('claude-sonnet-5'), { input: 3000, output: 200 });
    expect(visualJudgeCostUsd(judge, toVisualOutcome(real))).toBe(expected);
    expect(visualJudgeCostUsd(judge, { score: 1, passed: true })).toBe(0);
  });
});

describe('estimatedCostUsd on the cell row = coding (resolved model) + panel + visual judge; postGeneration present', () => {
  it('adds the visual judge cost and records the decomposition in meta.costs', async () => {
    const dir = cellDir({ evalJson: true });
    const judge = { provider: 'claude' as const, model: 'claude-sonnet-5', passThreshold: 60 };
    const report = await evaluateCell(readCellInputs(dir), {
      dir, playwright: neverLaunch, panel, visualJudge: judge,
      visual: async () => ({ score: 70, passed: true, tokens: { input: 3000, output: 200 } }),
    });
    const coding = calculateCost(resolveCostModelId(undefined, 'openai/gpt-6-astra'), { input: 1000, output: 500 });
    const visual = calculateCost(resolveJudgeCostModelId('claude-sonnet-5'), { input: 3000, output: 200 });
    expect(report.meta.costs).toEqual({ codingUsd: coding, panelUsd: 0, visualUsd: visual });
    expect(report.estimatedCostUsd).toBeCloseTo(coding + visual, 10);
    expect(report.postGeneration?.compiledCodeBytes).toBe(Buffer.byteLength('export default function C(){return null}'));
  });
});

describe('a bare mint.json (hook not landed) is disclosed, not guessed', () => {
  it('records turnsUsed/passesUsed 0 with notes and falls back to latencyMs for generationTimeMs', async () => {
    const dir = cellDir();
    writeFileSync(join(dir, 'mint.json'), JSON.stringify({ cellId: 'c1', runId: 'r1', arm: 'A', model: 'anthropic/claude-fable-5-1', latencyMs: 999 }));
    const report = await evaluateCell(readCellInputs(dir), { dir, playwright: neverLaunch, panel, visual: async () => null });
    expect(report.generation).toMatchObject({ turnsUsed: 0, passesUsed: 0, generationTimeMs: 999 });
    expect(report.meta.notes).toEqual(expect.arrayContaining(['turnsUsed absent in mint.json (0 recorded)', 'passesUsed absent in mint.json (0 recorded)']));
  });
});

describe('deriveRuntimeProbeVerdictFromExport', () => {
  it('absent eval.json → skipped with the export reason, never a pass', () => {
    expect(deriveRuntimeProbeVerdictFromExport(undefined)).toEqual({
      status: 'skipped', passed: false, failures: 0, warnings: 0,
      reason: 'eval.json absent — mint did not export the in-loop evaluation',
    });
  });
  it('present → the runner verdict (same helper as the published matrix)', () => {
    const v = deriveRuntimeProbeVerdictFromExport({ issues: [], pass: [], runtimeProbe: { status: 'ran' } });
    expect(v).toEqual({ status: 'ran', passed: true, failures: 0, warnings: 0 });
  });
});

describe('evaluateCell — the EVAL task core with injected judges', () => {
  it('writes ONE benchmark-report.v2 ROW (the published results[] shape) plus meta: ids, generation from the mint, cost by the runner rule, arm-neutral panel, per-canvas artefacts', async () => {
    const dir = cellDir({ evalJson: true });
    const report = await evaluateCell(readCellInputs(dir), {
      dir,
      playwright: neverLaunch,
      panel,
      visualJudge: { provider: 'claude', model: 'claude-sonnet-5', passThreshold: 60 },
      visual: async () => ({
        score: 80, passed: true,
        canvases: [{ canvas: 'md', viewport: { width: 768, height: 1024 }, score: 80, passed: true, screenshotPng: Buffer.from('89504e47', 'hex') }],
      }),
      now: () => new Date('2026-09-10T00:00:00.000Z'),
    });
    expect(report.schemaVersion).toBe(EXP008_CELL_REPORT_VERSION);
    expect(report.reportSchemaVersion).toBe('benchmark-report.v2');
    // the row — exactly what rnd's verdict script (v2) reads
    expect(report.variant).toMatchObject({ id: 'openai-frontier', sdkName: 'openai', tier: 'premium', modelId: 'openai/gpt-6-astra' });
    expect(report.commit).toMatchObject({ id: 'weather-card' });
    expect(report.generation).toMatchObject({ turnsUsed: 2, passesUsed: 1, generationTimeMs: 1200, designMode: 'free', canvas: 'md', tokens: { input: 1000, output: 500, total: 1500 } });
    expect(report.estimatedCostUsd).toBeGreaterThan(0); // astra $10/$50 per MTok on 1000/500 tokens = $0.035 (+ panel tokens: none in the stub)
    expect(report.estimatedCostUsd).toBeCloseTo(0.035, 4);
    expect(report.evaluation?.score).toBe(77);
    expect(report.contractBehavior).toMatchObject({ status: 'ran', ok: true }); // weather-card has no actionSpec
    expect(report.runtimeProbeVerdict?.status).toBe('ran');
    expect(report.visualCanvases?.[0]?.artefact?.path).toBe('canvas-md.png');
    expect(report.timestamp).toBe('2026-09-10T00:00:00.000Z');
    // the cell's own record
    expect(report.meta).toMatchObject({
      cellId: 'c1', runId: 'r1', arm: 'B', codeHash: 'abc',
      visual: { score: 80, passed: true },
      visualJudge: { provider: 'claude', model: 'claude-sonnet-5', passThreshold: 60 },
      panelPromptVersion: 'aesthetic-eval.v3-panel-arm-neutral',
    });
    expect(existsSync(join(dir, 'canvas-md.png'))).toBe(true);
    expect(readFileSync(join(dir, 'report.json'), 'utf8')).toContain('"schemaVersion": "exp008-cell.v1"');
  });

  it('a visual judge that returns null leaves visual/visualCanvases absent and says so; the report still writes', async () => {
    const dir = cellDir();
    const report = await evaluateCell(readCellInputs(dir), { dir, playwright: neverLaunch, panel, visual: async () => null });
    expect(report.meta.visual).toBeUndefined();
    expect(report.visualCanvases).toBeUndefined();
    expect(report.runtimeProbeVerdict?.status).toBe('skipped');
    expect(report.meta.notes).toContain('visual judge returned null');
    expect(report.meta.visualJudge).toBeUndefined();
    expect(report.meta.panelPromptVersion).toBe('aesthetic-eval.v3-panel-arm-neutral');
  });
});

describe('mint receipt on the row', () => {
  it('stamps the driver-handed receipt verbatim into report.meta (image, digest, source sha, prompt digests)', async () => {
    const dir = cellDir();
    const report = await evaluateCell(readCellInputs(dir), {
      dir, playwright: neverLaunch, panel,
      mintReceipt: {
        image: 'acct.dkr.ecr.us-east-1.amazonaws.com/ggui-agents:ggui-protocol-5a3bc54fe1b0',
        imageDigest: 'sha256:0123',
        sourceSha: '5a3bc54fe1b0ddba3a9c980846cceb32c2e04c5f',
        promptDigests: { constrained: 'c205c03e74', free: 'bfca8b9158' },
      },
    });
    expect(report.meta.mintImage).toEqual({ image: 'acct.dkr.ecr.us-east-1.amazonaws.com/ggui-agents:ggui-protocol-5a3bc54fe1b0', digest: 'sha256:0123' });
    expect(report.meta.mintSourceSha).toBe('5a3bc54fe1b0ddba3a9c980846cceb32c2e04c5f');
    expect(report.meta.promptDigests).toEqual({ constrained: 'c205c03e74', free: 'bfca8b9158' });
    expect(report.meta.notes).not.toContain(MINT_RECEIPT_ABSENT_NOTE);
    const written = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as { meta: { mintSourceSha?: string } };
    expect(written.meta.mintSourceSha).toBe('5a3bc54fe1b0ddba3a9c980846cceb32c2e04c5f');
  });

  it('without a receipt the row says so in notes and carries no mintImage / promptDigests — nothing invented', async () => {
    const dir = cellDir();
    const report = await evaluateCell(readCellInputs(dir), { dir, playwright: neverLaunch, panel });
    expect(report.meta.mintImage).toBeUndefined();
    expect(report.meta.promptDigests).toBeUndefined();
    expect(report.meta.notes).toContain(MINT_RECEIPT_ABSENT_NOTE);
  });

  it('the absent-receipt note is one exported sentence the eval-cell script and the tests share', () => {
    expect(MINT_RECEIPT_ABSENT_NOTE).toMatch(/mint receipt absent/);
    expect(MINT_RECEIPT_ABSENT_NOTE).toMatch(/MINT_\* env/);
  });
});
