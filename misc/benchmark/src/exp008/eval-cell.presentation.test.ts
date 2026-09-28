// ggui#1492 — judge-input.json's `canvasPresentations` reaches the visual judge as data: the reader pre-checks
// it (malformed entries drop and are noted) and hands the judge only what passed. What the judge DREW is its own
// result's to say, so the report's echo waits for that. Absent ⇒ today: no key, nothing handed to the judge.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataContract, JsonObject } from '@ggui-ai/protocol';
import type { PlaywrightModule } from '@ggui-ai/ui-visual-tester';
import type { PanelEvalResult } from '../multi-sdk/post-eval.js';
import { evaluateCell, readCellInputs } from './eval-cell';
import { canvasViewportsFor, hostPresentationsFor, type CanvasPresentation } from './presentation';

const MINT = { cellId: 'c1', runId: 'r1', arm: 'B', model: 'openai/gpt-6-astra', codeHash: 'abc', latencyMs: 1234, generationTimeMs: 1200, turnsUsed: 2, passesUsed: 1, tokens: { input: 1000, output: 500 }, designMode: 'free', canvas: 'xs-chat-card', requested: { designMode: 'free', canvas: 'xs-chat-card' } };
const CONTRACT: DataContract = {
  propsSpec: { properties: { heading: { schema: { type: 'string' }, required: true, example: 'Welcome to Northwind' } } },
};
const FRAME = { surface: '#ffffff', ground: '#f6f5ee', ring: { widthPx: 1, color: '#1c1b18', alpha: 0.08 }, radiusPx: 18, minHeightPx: 256 };
const INLINE = { canvas: 'xs-chat-card', label: 'host, inline card', frame: FRAME };
const PANE = { canvas: 'md', label: 'host, pane, reference viewport', box: { width: 816, height: 736 }, ground: '#eeece4' };

function bootstrapCell(judgeInput: JsonObject): string {
  const dir = mkdtempSync(join(tmpdir(), 'exp008-presentation-'));
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
  judges: [], promptVersion: 'aesthetic-eval.v4-panel',
});
const neverLaunch: PlaywrightModule = { chromium: { launch: async () => { throw new Error('unit test: no browser'); } } };

describe('ggui#1492 — the host presentation rides judge-input.json to the judge and back into the report', () => {
  it('reads the field at the door: applied and malformed together, a malformed entry dropping only its own canvas', () => {
    const inputs = readCellInputs(bootstrapCell({ prompt: 'a welcome card', canvasPresentations: [INLINE, PANE, { canvas: 'lg', label: '' }] }));
    expect(inputs.presentation).toEqual({
      applied: [INLINE, PANE],
      malformed: [{ canvas: 'lg', reason: 'label_missing' }],
    });
  });

  it('absent ⇒ no key on the inputs (an older writer sent none)', () => {
    expect('presentation' in readCellInputs(bootstrapCell({ prompt: 'a welcome card' }))).toBe(false);
  });

  it('the declared primary is the one judge-input names: a box on it drops, a box on another canvas applies', () => {
    const inputs = readCellInputs(
      bootstrapCell({ prompt: 'a welcome card', canvasViewport: { canvas: 'md', width: 900, height: 700 }, canvasPresentations: [PANE] }),
    );
    expect(inputs.presentation).toEqual({ applied: [], malformed: [{ canvas: 'md', reason: 'box_on_declared_primary' }] });
  });

  it('hands the judge ONLY the entries that passed, and names every dropped entry on the row', async () => {
    const dir = bootstrapCell({ prompt: 'a welcome card', canvasPresentations: [INLINE, PANE, 'not an entry'] });
    let seen: unknown = 'not called';
    const report = await evaluateCell(readCellInputs(dir), { dir, playwright: neverLaunch, panel, visual: async (ctx) => { seen = ctx.presentations; return null; } });
    expect(seen).toEqual([INLINE, PANE]);
    expect(report.meta.notes).toContain('presentation dropped — ?: not_an_object');
  });

  it('absent ⇒ the judge is handed no presentations and the report is today\'s (no presentation key, no note)', async () => {
    const dir = bootstrapCell({ prompt: 'a welcome card' });
    let seen: unknown = 'not called';
    const report = await evaluateCell(readCellInputs(dir), { dir, playwright: neverLaunch, panel, visual: async (ctx) => { seen = 'presentations' in ctx; return null; } });
    expect(seen).toBe(false);
    expect(readFileSync(join(dir, 'report.json'), 'utf8')).not.toContain('"presentation"');
    expect(report.meta.notes.filter((n) => n.startsWith('presentation'))).toEqual([]);
  });

  it('all entries malformed ⇒ nothing is handed to the judge, and the drop is still named on the row', async () => {
    const dir = bootstrapCell({ prompt: 'a welcome card', canvasPresentations: { canvas: 'md' } });
    let seen: unknown = 'not called';
    const report = await evaluateCell(readCellInputs(dir), { dir, playwright: neverLaunch, panel, visual: async (ctx) => { seen = 'presentations' in ctx; return null; } });
    expect(seen).toBe(false);
    expect(report.meta.notes).toContain('presentation dropped — *: not_an_object');
  });
});

describe('the judge config the applied presentations map to', () => {
  const applied: readonly CanvasPresentation[] = [
    { canvas: 'xs-chat-card', label: 'host, inline card', frame: FRAME },
    { canvas: 'md', label: 'host, pane, reference viewport', box: { width: 816, height: 736 }, ground: '#eeece4' },
  ];

  it('canvasViewports: the declared box plus each applied box; neither ⇒ absent; declared alone ⇒ today\'s object', () => {
    expect(canvasViewportsFor({ canvas: 'lg', width: 1200, height: 900 }, applied)).toEqual({ lg: { width: 1200, height: 900 }, md: { width: 816, height: 736 } });
    expect(canvasViewportsFor(undefined, [])).toBeUndefined();
    expect(canvasViewportsFor({ canvas: 'xs-chat-card', width: 360, height: 600 }, [])).toEqual({ 'xs-chat-card': { width: 360, height: 600 } });
  });

  it('hostPresentations: label, ground and frame copied per canvas (the box stays in canvasViewports); none ⇒ absent', () => {
    expect(hostPresentationsFor(applied)).toEqual({
      'xs-chat-card': { label: 'host, inline card', frame: FRAME },
      md: { label: 'host, pane, reference viewport', ground: '#eeece4' },
    });
    expect(hostPresentationsFor([])).toBeUndefined();
  });
});
