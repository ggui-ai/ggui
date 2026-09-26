// ggui#1023 — judge-input.json carries the app's registered theme id (`themeId`, written by the
// mint beside `theme` when the app names one) and the eval cell composes the judged page's tokens
// exactly as the mint's in-loop round does: the overlay ON that ladder. An older mint wrote no
// `themeId` ⇒ no key, and a theme-only cell stays byte-identical to today's composition (N−1).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppTheme, DataContract, JsonObject } from '@ggui-ai/protocol';
import { getDefaultThemeId, getThemeIds } from '@ggui-ai/design/themes';
import { cssTokensForAppTheme } from '@ggui-ai/ui-gen/evaluation';
import type { PlaywrightModule } from '@ggui-ai/ui-visual-tester';
import type { PanelEvalResult } from '../multi-sdk/post-eval.js';
import { evaluateCell, judgedCssTokens, readCellInputs } from './eval-cell';

const MINT = { cellId: 'c1', runId: 'r1', arm: 'B', model: 'openai/gpt-6-astra', codeHash: 'abc', latencyMs: 1234, generationTimeMs: 1200, turnsUsed: 2, passesUsed: 1, tokens: { input: 1000, output: 500 }, designMode: 'free', canvas: 'xs-chat-card', requested: { designMode: 'free', canvas: 'xs-chat-card' } };
const CONTRACT: DataContract = {
  propsSpec: { properties: { heading: { schema: { type: 'string' }, required: true, example: 'Welcome to Northwind' } } },
};
// A VALID AppTheme (the schema's required overlayHash + both mode projections).
const THEME: AppTheme = {
  overlayHash: 'ab'.repeat(32),
  overlays: { light: { '--ggui-color-onContainer': '#ffffff' }, dark: { '--ggui-color-onContainer': '#0a0a0a' } },
};
const PRESET = getThemeIds().find((id) => id !== getDefaultThemeId());

function bootstrapCell(judgeInput: JsonObject): string {
  const dir = mkdtempSync(join(tmpdir(), 'exp008-theme-id-'));
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

describe('ggui#1023 — the app\'s registered theme id rides judge-input.json to the judged page', () => {
  it('readCellInputs surfaces themeId verbatim; absent ⇒ no key (an older mint wrote none)', () => {
    expect(readCellInputs(bootstrapCell({ prompt: 'a welcome card', themeId: 'ocean' })).themeId).toBe('ocean');
    expect('themeId' in readCellInputs(bootstrapCell({ prompt: 'a welcome card' }))).toBe(false);
  });

  it('a present-but-unusable themeId is loud at the read door', () => {
    expect(() => readCellInputs(bootstrapCell({ prompt: 'a welcome card', themeId: 42 }))).toThrow(/themeId/);
    expect(() => readCellInputs(bootstrapCell({ prompt: 'a welcome card', themeId: '  ' }))).toThrow(/themeId/);
  });

  it('evaluateCell hands themeId to the visual judge', async () => {
    const dir = bootstrapCell({ prompt: 'a welcome card', themeId: 'ocean' });
    let seen: unknown = 'not called';
    await evaluateCell(readCellInputs(dir), { dir, playwright: neverLaunch, panel, visual: async (ctx) => { seen = ctx.themeId; return null; } });
    expect(seen).toBe('ocean');
  });
});

describe('judgedCssTokens — the judged page composes as the mint composes', () => {
  it('neither theme nor themeId ⇒ undefined (the design defaults, no cssTokens key — today\'s path)', () => {
    let called = false;
    expect(judgedCssTokens({}, () => { called = true; return 'x'; })).toBeUndefined();
    expect(called).toBe(false);
  });

  it('passes the overlay, light mode and the id through, in the mint\'s argument order', () => {
    const calls: unknown[][] = [];
    const compose = (...a: unknown[]): string => { calls.push(a); return 'css'; };
    judgedCssTokens({ theme: THEME }, compose);
    judgedCssTokens({ themeId: 'ocean' }, compose);
    judgedCssTokens({ theme: THEME, themeId: 'ocean' }, compose);
    expect(calls).toEqual([[THEME, 'light', undefined], [undefined, 'light', 'ocean'], [THEME, 'light', 'ocean']]);
  });

  it('a theme-only cell is byte-identical to today\'s composition (cssTokensForAppTheme(theme))', () => {
    expect(judgedCssTokens({ theme: THEME }, cssTokensForAppTheme)).toBe(cssTokensForAppTheme(THEME));
  });

  it('a registered preset id alone composes that ladder, not the default tokens (the mint\'s #1023 case)', () => {
    if (PRESET === undefined) throw new Error('the theme registry names no non-default theme');
    const css = judgedCssTokens({ themeId: PRESET }, cssTokensForAppTheme);
    expect(css).toBe(cssTokensForAppTheme(undefined, 'light', PRESET));
    expect(css).not.toBe(cssTokensForAppTheme(undefined));
  });
});
