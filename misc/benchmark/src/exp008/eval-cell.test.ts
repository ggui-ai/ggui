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
  readJudgeInput,
  JUDGE_INPUT_FILE,
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

  it('a bootstrap cell (commitRef null) without judge-input.json is loud — no prompt to judge', () => {
    expect(() => readCellInputs(cellDir({ commit: null }))).toThrow(/judge-input\.json/);
  });

  it('a bootstrap cell reads judge-input.json: prompt, sample props (propsSource cell), the matrix arm when the model is one', () => {
    const dir = cellDir({ commit: null });
    writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ prompt: 'Make me a hello card', sampleProps: { name: 'Gemma' } }));
    const inputs = readCellInputs(dir);
    expect(inputs.bootstrap).toBe(true);
    expect(inputs.prompt).toBe('Make me a hello card');
    expect(inputs.sampleProps).toEqual({ name: 'Gemma' });
    expect(inputs.propsSource).toBe('cell');
    expect(inputs.commit.id).toBe('bootstrap');
    expect(inputs.variant.id).toBe('openai-frontier');
  });

  it('a bootstrap cell on a model outside the matrix records the model verbatim on a synthetic bootstrap variant; no sample props = empty', () => {
    const dir = cellDir({ commit: null });
    writeFileSync(join(dir, 'mint.json'), JSON.stringify({ cellId: 'c1', runId: 'r1', arm: 'A', model: 'anthropic/claude-haiku-4-5-20251001', tokens: { input: 1, output: 1 }, latencyMs: 1, generationTimeMs: 1, turnsUsed: 1, passesUsed: 1, designMode: 'constrained', canvas: null }));
    writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ prompt: 'Hello' }));
    const inputs = readCellInputs(dir);
    expect(inputs.variant).toEqual({ id: 'bootstrap', sdkName: 'claude', tier: 'balanced', modelId: 'anthropic/claude-haiku-4-5-20251001' });
    expect(inputs.propsSource).toBe('empty');
    expect(inputs.sampleProps).toBeUndefined();
  });

  it('judge-input.json must carry a non-empty prompt and an object for sampleProps', () => {
    const dir = cellDir({ commit: null });
    writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ prompt: '' }));
    expect(() => readCellInputs(dir)).toThrow(/non-empty string "prompt"/);
    writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ prompt: 'x', sampleProps: [1] }));
    expect(() => readCellInputs(dir)).toThrow(/"sampleProps" must be a JSON object/);
  });

  it('a corpus cell is unchanged: the commit prompt and props, propsSource commit, bootstrap false', () => {
    const inputs = readCellInputs(cellDir());
    expect(inputs.bootstrap).toBe(false);
    expect(inputs.prompt).toBe(commitForRef('weather-card').prompt);
    expect(inputs.propsSource).toBe(commitForRef('weather-card').props !== undefined ? 'commit' : 'empty');
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
    canvases: [{ canvas: 'xl', viewport: { width: 1440, height: 900 }, score: 81, passed: true, screenshotPng: Buffer.from('89504e47', 'hex'), contentHeight: 820, overflow: false }],
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
        canvases: [{ canvas: 'md', viewport: { width: 768, height: 1024 }, score: 80, passed: true, screenshotPng: Buffer.from('89504e47', 'hex'), contentHeight: 900, overflow: false }],
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
    expect(report.visualCanvases?.[0]).toMatchObject({ contentHeight: 900, overflow: false }); // #1032 — the fit is on the row
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

describe('propsSource on the row', () => {
  it('a bootstrap cell stamps propsSource "cell" and the bootstrap note; the judge receives the judge-input prompt and props', async () => {
    const dir = cellDir({ commit: null });
    writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ prompt: 'Make me a hello card', sampleProps: { name: 'Gemma' } }));
    let seen: { originalPrompt: string; sampleProps?: unknown } | undefined;
    const report = await evaluateCell(readCellInputs(dir), {
      dir, playwright: neverLaunch, panel,
      visual: async (ctx) => { seen = { originalPrompt: ctx.originalPrompt, sampleProps: ctx.sampleProps }; return null; },
    });
    expect(report.meta.propsSource).toBe('cell');
    expect(report.meta.notes.some((n) => n.startsWith('bootstrap cell, no corpus'))).toBe(true);
    expect(seen).toEqual({ originalPrompt: 'Make me a hello card', sampleProps: { name: 'Gemma' } });
  });

  it('a corpus cell stamps propsSource "commit" (or "empty" with the note when the commit has no props) and no bootstrap note', async () => {
    const dir = cellDir();
    const report = await evaluateCell(readCellInputs(dir), { dir, playwright: neverLaunch, panel });
    const hasProps = commitForRef('weather-card').props !== undefined;
    expect(report.meta.propsSource).toBe(hasProps ? 'commit' : 'empty');
    expect(report.meta.notes.some((n) => n.startsWith('no sample props'))).toBe(!hasProps);
    expect(report.meta.notes.some((n) => n.startsWith('bootstrap cell'))).toBe(false);
  });
});

describe('generation profile on a bootstrap cell', () => {
  it('judge-input.json.profile is validated by the protocol schema, read onto the inputs, forwarded to the visual judge and stamped on the row', async () => {
    const dir = cellDir({ commit: null });
    writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ prompt: 'Hello card', profile: { styling: 'warm, editorial', density: 'airy' } }));
    const inputs = readCellInputs(dir);
    expect(inputs.profile).toEqual({ styling: 'warm, editorial', density: 'airy' });
    let seen: unknown = 'not called';
    const report = await evaluateCell(inputs, { dir, playwright: neverLaunch, panel, visual: async (ctx) => { seen = ctx.profile; return null; } });
    expect(seen).toEqual({ styling: 'warm, editorial', density: 'airy' });
    expect(report.meta.profile).toEqual({ styling: 'warm, editorial', density: 'airy' });
  });

  it('a profile with a wrong-typed known member is loud; an unknown member is dropped, not refused (N-1, #1014)', () => {
    const dir = cellDir({ commit: null });
    writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ prompt: 'x', profile: { styling: 42 } }));
    expect(() => readCellInputs(dir)).toThrow(/"profile" is not a generation profile/);
    writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ prompt: 'x', profile: { palette: 'blue' } }));
    expect(readCellInputs(dir).profile).toEqual({});
  });

  it('absent profile = today\'s path: no profile on the inputs, no profile key handed to the judge, none on the row', async () => {
    const dir = cellDir({ commit: null });
    writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ prompt: 'x' }));
    const inputs = readCellInputs(dir);
    expect('profile' in inputs).toBe(false);
    let keys: string[] = [];
    const report = await evaluateCell(inputs, { dir, playwright: neverLaunch, panel, visual: async (ctx) => { keys = Object.keys(ctx); return null; } });
    expect(keys).not.toContain('profile');
    expect('profile' in report.meta).toBe(false);
  });
});

describe('the visual judge says why it could not judge', () => {
  it('an unavailability from the judge is stamped on the row (reason + canvas) and named in the notes; no visual score', async () => {
    const dir = cellDir();
    const report = await evaluateCell(readCellInputs(dir), {
      dir, playwright: neverLaunch, panel,
      visual: async () => ({ unavailableReason: "screenshot failed: Cannot find package 'puppeteer-core'", canvas: 'xs-chat-card' }),
    });
    expect(report.meta.visualUnavailableReason).toBe("screenshot failed: Cannot find package 'puppeteer-core'");
    expect(report.meta.visualUnavailableCanvas).toBe('xs-chat-card');
    expect(report.meta.visual).toBeUndefined();
    expect(report.meta.notes.some((n) => n.includes("visual judge unavailable — screenshot failed: Cannot find package 'puppeteer-core' (canvas xs-chat-card)"))).toBe(true);
    expect(report.meta.costs.visualUsd).toBe(0);
  });

  it('a judge that answers null keeps the old note and stamps no reason', async () => {
    const dir = cellDir();
    const report = await evaluateCell(readCellInputs(dir), { dir, playwright: neverLaunch, panel, visual: async () => null });
    expect(report.meta.visualUnavailableReason).toBeUndefined();
    expect(report.meta.notes).toContain('visual judge returned null');
  });
});

describe('app theme on a bootstrap cell (#1020)', () => {
  const THEME = { overlayHash: 'a'.repeat(64), overlays: { light: { '--ggui-color-onContainer': '#f4f1ea' }, dark: { '--ggui-color-onContainer': '#15181d' } } };

  it('judge-input.json.theme is validated by the protocol schema, handed to the judge context, and stamped as themeApplied', async () => {
    const dir = cellDir({ commit: null });
    writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ prompt: 'Hello card', theme: THEME }));
    const inputs = readCellInputs(dir);
    expect(inputs.theme).toEqual(THEME);
    let seen: unknown = 'not called';
    const report = await evaluateCell(inputs, { dir, playwright: neverLaunch, panel, visual: async (ctx) => { seen = ctx.theme; return null; } });
    expect(seen).toEqual(THEME);
    expect(report.meta.themeApplied).toBe(true);
  });

  it('a theme with a bad known member is loud; an unknown top-level member is dropped, not refused (N-1, #1014)', () => {
    const dir = cellDir({ commit: null });
    writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ prompt: 'x', theme: { overlayHash: 'nope', overlays: { light: {}, dark: {} } } }));
    expect(() => readCellInputs(dir)).toThrow(/"theme" is not an app theme/);
    writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ prompt: 'x', theme: { ...THEME, palette: 'blue' } }));
    expect(readCellInputs(dir).theme).toEqual(THEME);
  });

  it('absent theme = today: no theme key handed to the judge, no themeApplied on the row', async () => {
    const dir = cellDir({ commit: null });
    writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ prompt: 'x' }));
    let keys: string[] = [];
    const report = await evaluateCell(readCellInputs(dir), { dir, playwright: neverLaunch, panel, visual: async (ctx) => { keys = Object.keys(ctx); return null; } });
    expect(keys).not.toContain('theme');
    expect('themeApplied' in report.meta).toBe(false);
  });
});

describe('the visual judge identity names its prompt', () => {
  it('a version + digest the evaluator declares are stamped on report.meta.visualJudge; neither = absent + the note', async () => {
    const dir = cellDir();
    const digest = 'a918b33c7b80ced3cbebe71bc750a74b9ff9f40655851c132f251a957f2b81b7';
    const stamped = await evaluateCell(readCellInputs(dir), {
      dir, playwright: neverLaunch, panel, visual: async () => null,
      visualJudge: { provider: 'claude', model: 'claude-sonnet-5', passThreshold: 60, promptVersion: 'v2-bounded-issues', promptDigest: digest },
    });
    expect(stamped.meta.visualJudge?.promptVersion).toBe('v2-bounded-issues');
    expect(stamped.meta.visualJudge?.promptDigest).toBe(digest);
    expect(stamped.meta.notes.some((n) => n.startsWith('visual judge prompt unstamped'))).toBe(false);
    const bare = await evaluateCell(readCellInputs(dir), {
      dir, playwright: neverLaunch, panel, visual: async () => null,
      visualJudge: { provider: 'claude', model: 'claude-sonnet-5', passThreshold: 60 },
    });
    expect(bare.meta.visualJudge?.promptVersion).toBeUndefined();
    expect(bare.meta.visualJudge?.promptDigest).toBeUndefined();
    expect(bare.meta.notes.some((n) => n.startsWith('visual judge prompt unstamped'))).toBe(true);
  });
});

describe('readJudgeInput under the N-1 rule (#1014): an older reader never rejects an additive member from a newer writer', () => {
  const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/judge-input-newer-writer.json', import.meta.url), 'utf8')) as {
    prompt: string; sampleProps?: Record<string, never>; profile: { direction: string };
  };
  it("parses the newer writer's real hello judge-input (profile.direction) as a bootstrap input", () => {
    const dir = mkdtempSync(join(tmpdir(), 'exp008-judge-input-'));
    writeFileSync(join(dir, JUDGE_INPUT_FILE), JSON.stringify(fixture));
    const j = readJudgeInput(dir);
    expect(j.prompt).toBe(fixture.prompt);
    expect(j.profile?.direction).toBe(fixture.profile.direction);
  });
  it('drops a profile member this reader cannot know yet instead of failing the cell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exp008-judge-input-'));
    writeFileSync(join(dir, JUDGE_INPUT_FILE), JSON.stringify({ ...fixture, profile: { ...fixture.profile, aMemberFromTheNextRelease: 'ignored by this reader' } }));
    const j = readJudgeInput(dir);
    expect(j.profile).toEqual(fixture.profile);
    expect(Object.keys(j.profile ?? {})).not.toContain('aMemberFromTheNextRelease');
  });
});
