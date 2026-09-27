// ggui#1436 — the criteria set rides judge-input.json to the eval task's judge. The mint writes
// `criteria: { digest, set }` beside `sampleProps`; the eval cell reads the set through ui-gen's bank loader,
// recomputes the digest on the set AS READ (never on the parsed bank, which drops page-only members), builds
// the card's criteria context and hands both to the visual judge, so the typed block sits beside the score
// that binds (report-only). An older mint wrote no set ⇒ no key and no block (N−1); a set this judge cannot
// read is dropped WITH its reason on the row, and the cell is still judged.

import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataContract, JsonObject } from '@ggui-ai/protocol';
import type { PlaywrightModule } from '@ggui-ai/ui-visual-tester';
import type { PanelEvalResult } from '../multi-sdk/post-eval.js';
import { evaluateCell, readCellInputs } from './eval-cell';

const MINT = {
  cellId: 'c1', runId: 'r1', arm: 'B', model: 'openai/gpt-6-astra', codeHash: 'abc', latencyMs: 1234, generationTimeMs: 1200,
  turnsUsed: 2, passesUsed: 1, tokens: { input: 1000, output: 500 }, designMode: 'free', canvas: 'xs-chat-card',
  requested: { designMode: 'free', canvas: 'xs-chat-card' },
};
const CONTRACT: DataContract = {
  propsSpec: { properties: { heading: { schema: { type: 'string' }, required: true, example: 'Welcome to Northwind' } } },
};
/** A set as the mint writes it: the bank's rows plus page-only members the loader drops. */
const SET: JsonObject = {
  version: '2026-09-27.test',
  seed: 'page-only',
  fields: { verdict: 'page-only glossary' },
  applies: { kind: ['*'] },
  criteria: [
    { id: 'task.copy', scope: {}, severity: 'must', evaluation: 'judge', status: 'live', text: 'Is every string from the content or the props?', evidence: 'the string and where it sits' },
  ],
};
const digestOf = (set: JsonObject): string => createHash('sha256').update(JSON.stringify(set)).digest('hex').slice(0, 16);

function bootstrapCell(judgeInput: JsonObject): string {
  const dir = mkdtempSync(join(tmpdir(), 'exp008-criteria-'));
  writeFileSync(join(dir, 'compiled.js'), 'export default function C(){return null}');
  writeFileSync(join(dir, 'source.tsx'), 'export default function C(props){ return <div>{props.heading}</div> }');
  writeFileSync(join(dir, 'contract.json'), JSON.stringify({ contract: CONTRACT, contractKey: 'k1', commitRef: null }));
  writeFileSync(join(dir, 'mint.json'), JSON.stringify(MINT));
  writeFileSync(join(dir, 'judge-input.json'), JSON.stringify(judgeInput));
  return dir;
}

const panel = async (): Promise<PanelEvalResult | null> => ({
  passed: true, score: 77, spread: 0, evalTimeMs: 1, critique: '',
  dimensions: { layout: 77, designTokens: 77, hierarchy: 77, polish: 77, dataPresentation: 77 },
  judges: [], promptVersion: 'aesthetic-eval.v3-panel-arm-neutral',
});
const neverLaunch: PlaywrightModule = { chromium: { launch: async () => { throw new Error('unit test: no browser'); } } };

describe('ggui#1436 — the criteria set rides judge-input.json to the eval task\'s judge', () => {
  it('reads the set through the bank loader and recomputes the digest on the RAW set (page-only members included)', () => {
    const inputs = readCellInputs(bootstrapCell({ prompt: 'a welcome card', criteria: { digest: digestOf(SET), set: SET } }));
    expect(inputs.criteria?.bank.version).toBe('2026-09-27.test');
    expect(inputs.criteria?.bank.criteria.map((c) => c.id)).toEqual(['task.copy']);
    expect(inputs.criteria?.digestComputed).toBe(digestOf(SET));
    expect(inputs.criteria?.digest).toBe(inputs.criteria?.digestComputed);
    expect('criteriaDropped' in inputs).toBe(false);
  });

  it('N−1: an older mint wrote no set ⇒ no criteria key, nothing dropped, no block', async () => {
    const dir = bootstrapCell({ prompt: 'a welcome card' });
    const inputs = readCellInputs(dir);
    expect('criteria' in inputs).toBe(false);
    expect('criteriaDropped' in inputs).toBe(false);
    let seen: unknown = 'not called';
    const report = await evaluateCell(inputs, { dir, playwright: neverLaunch, panel, visual: async (ctx) => { seen = ctx.criteria; return null; } });
    expect(seen).toBeUndefined();
    expect(report.meta.criteriaDigest).toBeUndefined();
  });

  it('hands the bank and the card\'s context to the visual judge, and records the digest on the report', async () => {
    const dir = bootstrapCell({ prompt: 'a welcome card', criteria: { digest: digestOf(SET), set: SET } });
    let seen: { bankVersion: string; shell: string; hasActions: boolean } | null = null;
    const report = await evaluateCell(readCellInputs(dir), {
      dir, playwright: neverLaunch, panel,
      visual: async (ctx) => {
        if (ctx.criteria !== undefined) seen = { bankVersion: ctx.criteria.bank.version, shell: ctx.criteria.context.shell, hasActions: ctx.criteria.context.hasActions };
        return null;
      },
    });
    expect(seen).toEqual({ bankVersion: '2026-09-27.test', shell: 'chat', hasActions: false });
    expect(report.meta.criteriaDigest).toBe(digestOf(SET));
    expect(report.meta.notes.some((n) => n.startsWith('criteria'))).toBe(false);
  });

  it('a set the judge cannot read is dropped WITH its reason on the row, and the cell is still judged', async () => {
    const dir = bootstrapCell({ prompt: 'a welcome card', criteria: { digest: 'x', set: { version: 'v', criteria: [] } } });
    const inputs = readCellInputs(dir);
    expect('criteria' in inputs).toBe(false);
    expect(inputs.criteriaDropped).toContain('refused by the bank loader');
    let called = false;
    const report = await evaluateCell(inputs, { dir, playwright: neverLaunch, panel, visual: async () => { called = true; return null; } });
    expect(called).toBe(true);
    expect(report.meta.notes.some((n) => n.startsWith('criteria dropped — '))).toBe(true);
    const malformed = readCellInputs(bootstrapCell({ prompt: 'a welcome card', criteria: 'not an object' }));
    expect(malformed.criteriaDropped).toBe('"criteria" is not { digest: string, set: object }');
  });

  it('a digest that does not match the set as read is named on the row (the set is still used, report-only)', async () => {
    const dir = bootstrapCell({ prompt: 'a welcome card', criteria: { digest: '0000000000000000', set: SET } });
    const report = await evaluateCell(readCellInputs(dir), { dir, playwright: neverLaunch, panel, visual: async () => null });
    expect(report.meta.notes).toContain(`criteria digest mismatch — judge-input names 0000000000000000, the set as read hashes to ${digestOf(SET)}`);
    expect(report.meta.criteriaDigest).toBe(digestOf(SET));
  });
});
