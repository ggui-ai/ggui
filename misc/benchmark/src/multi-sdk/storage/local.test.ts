import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContractFeedbackRecord, EvalResult } from '@ggui-ai/ui-gen/evaluation';
import type { BenchmarkRunResult } from '../types.js';
import { generateReport, toDisplayReport } from '../reporter.js';
import { CONTRACT_FEEDBACK_FILE, LocalStorage, SOURCE_BEFORE_ROUND_FILE, savedComponentsFromResults } from './local.js';
import type { SavedComponent } from './types.js';

const dirs: string[] = [];
function outDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bench-local-storage-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A real (empty) display report — the storage writes it verbatim; its content is not under test here.
const report = toDisplayReport(generateReport([], 0), 'r1', 'test');

describe('LocalStorage.saveReport', () => {
  it('writes source.tsx and compiled.js, and no round files, when the contract-feedback round did not fire', async () => {
    const out = outDir();
    const cells = new Map<string, SavedComponent>([['arm-a-chat', { source: 'AFTER', compiled: 'JS' }]]);
    await new LocalStorage(out).saveReport({ reportId: 'r1', report, compiledComponents: cells });
    const dir = join(out, 'r1', 'arm-a-chat');
    expect(readFileSync(join(dir, 'source.tsx'), 'utf8')).toBe('AFTER');
    expect(readFileSync(join(dir, 'compiled.js'), 'utf8')).toBe('JS');
    expect(existsSync(join(dir, SOURCE_BEFORE_ROUND_FILE))).toBe(false);
    expect(existsSync(join(dir, CONTRACT_FEEDBACK_FILE))).toBe(false);
  });

  it('writes the round BEFORE beside the AFTER, and what bought the round, when it fired', async () => {
    const out = outDir();
    const contractFeedback: ContractFeedbackRecord = {
      firedOn: ['runtime:prop-sensitivity:currentUser'],
      sourceBefore: 'BEFORE',
    };
    const cells = new Map<string, SavedComponent>([
      ['arm-b-chat', { source: 'AFTER', compiled: 'JS', contractFeedback }],
    ]);
    await new LocalStorage(out).saveReport({ reportId: 'r1', report, compiledComponents: cells });
    const dir = join(out, 'r1', 'arm-b-chat');
    expect(readFileSync(join(dir, 'source.tsx'), 'utf8')).toBe('AFTER');
    expect(readFileSync(join(dir, SOURCE_BEFORE_ROUND_FILE), 'utf8')).toBe('BEFORE');
    expect(JSON.parse(readFileSync(join(dir, CONTRACT_FEEDBACK_FILE), 'utf8'))).toEqual({
      firedOn: ['runtime:prop-sensitivity:currentUser'],
    });
  });
});

function run(variantId: string, commitId: string, opts: { generated: boolean; tierEvaluation?: EvalResult }): BenchmarkRunResult {
  return {
    variant: { id: variantId, sdkName: 'openai', tier: 'fast', modelId: 'openai/x' },
    commit: { id: commitId, name: commitId, description: '', prompt: '', complexity: 'medium', contract: {} },
    generation: opts.generated
      ? { compiledCode: `JS:${variantId}`, sourceCode: `AFTER:${variantId}`, tokens: { input: 1, output: 1, total: 2 }, generationTimeMs: 1, turnsUsed: 1 }
      : null,
    evaluation: null,
    estimatedCostUsd: 0,
    timestamp: new Date(0).toISOString(),
    generator: 'ui-gen-default',
    ...(opts.tierEvaluation !== undefined ? { tierEvaluation: opts.tierEvaluation } : {}),
  };
}

describe('savedComponentsFromResults', () => {
  it('keys every generated cell by variant and commit, carries the record only where the round fired, and skips a cell with no bundle', () => {
    const contractFeedback: ContractFeedbackRecord = { firedOn: ['runtime:prop-sensitivity:currentUser'], sourceBefore: 'BEFORE' };
    const fired: EvalResult = { issues: [], pass: [], contractFeedback };
    const notFired: EvalResult = { issues: [], pass: [] };
    const saved = savedComponentsFromResults([
      run('control', 'chat', { generated: true, tierEvaluation: notFired }),
      run('candidate', 'chat', { generated: true, tierEvaluation: fired }),
      run('candidate', 'weather', { generated: false }),
    ]);
    expect([...saved.keys()]).toEqual(['control-chat', 'candidate-chat']);
    expect(saved.get('control-chat')).toEqual({ source: 'AFTER:control', compiled: 'JS:control' });
    expect(saved.get('control-chat')).not.toHaveProperty('contractFeedback');
    expect(saved.get('candidate-chat')).toEqual({ source: 'AFTER:candidate', compiled: 'JS:candidate', contractFeedback });
  });
});
