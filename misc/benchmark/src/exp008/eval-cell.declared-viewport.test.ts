// ggui#1195 — judge-input.json carries the order's DECLARED chat viewport
// (`canvasViewport: { canvas, width, height }`, written by the mint beside
// `sampleProps`) and the eval cell hands it to the visual judge, which then
// captures that canvas at that box. An older mint wrote none ⇒ no key (N−1).
// RED before the read-door + threading, GREEN after.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataContract, JsonObject } from '@ggui-ai/protocol';
import type { PlaywrightModule } from '@ggui-ai/ui-visual-tester';
import type { PanelEvalResult } from '../multi-sdk/post-eval.js';
import { evaluateCell, readCellInputs } from './eval-cell';

const MINT = { cellId: 'c1', runId: 'r1', arm: 'B', model: 'openai/gpt-6-astra', codeHash: 'abc', latencyMs: 1234, generationTimeMs: 1200, turnsUsed: 2, passesUsed: 1, tokens: { input: 1000, output: 500 }, designMode: 'free', canvas: 'xs-chat-card', requested: { designMode: 'free', canvas: 'xs-chat-card' } };
const CONTRACT: DataContract = {
  propsSpec: { properties: { heading: { schema: { type: 'string' }, required: true, example: 'Welcome to Northwind' } } },
};
const DECLARED = { canvas: 'xs-chat-card', width: 384, height: 516 } as const;

/** `judgeInput` is what the file holds — JSON — so a malformed box can be written on purpose. */
function bootstrapCell(judgeInput: JsonObject): string {
  const dir = mkdtempSync(join(tmpdir(), 'exp008-declared-viewport-'));
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

describe('ggui#1195 — the declared canvas viewport rides judge-input.json to the visual judge', () => {
  it('readCellInputs surfaces canvasViewport verbatim; absent ⇒ no key (an older mint wrote none)', () => {
    const withBox = readCellInputs(bootstrapCell({ prompt: 'a welcome card', canvasViewport: DECLARED }));
    expect(withBox.canvasViewport).toEqual(DECLARED);
    const without = readCellInputs(bootstrapCell({ prompt: 'a welcome card' }));
    expect('canvasViewport' in without).toBe(false);
  });

  it('evaluateCell hands canvasViewport to the visual judge (the judge captures that canvas at that box)', async () => {
    const dir = bootstrapCell({ prompt: 'a welcome card', canvasViewport: DECLARED });
    let seen: unknown = 'not called';
    await evaluateCell(readCellInputs(dir), {
      dir, playwright: neverLaunch, panel,
      visual: async (ctx) => { seen = ctx.canvasViewport; return null; },
    });
    expect(seen).toEqual(DECLARED);
  });

  it('a malformed canvasViewport is loud at the read door — the judge never captures at a box it cannot read', () => {
    expect(() => readCellInputs(bootstrapCell({ prompt: 'a welcome card', canvasViewport: { canvas: 'xs-chat-card', width: 'wide', height: 516 } }))).toThrow(/canvasViewport/);
    expect(() => readCellInputs(bootstrapCell({ prompt: 'a welcome card', canvasViewport: { canvas: 'sofa', width: 384, height: 516 } }))).toThrow(/canvasViewport/);
  });
});
