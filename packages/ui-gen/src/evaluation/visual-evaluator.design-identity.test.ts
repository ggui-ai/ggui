// Pin (ggui#1042, D3): the design tree the judge paints with is an input and
// a part of the judgement's identity — `result.design = { src, srcSha256 }`
// on every judgement and on the PNG-free summary; `designSrcDir` names the
// tree explicitly; `themeMode` is stamped when the caller composed the
// tokens in a named mode (ggui#1076).
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LaunchOptions } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import { designTreeSha256, judgeDesignIdentity, resetJudgeDesignIdentityCache } from './design-identity.js';
import {
  resolveDesignPackageDir,
  runVisualEvaluationDetailed,
  summarizeVisualResult,
  type ScreenshotBrowser,
  type VisualEvalDeps,
} from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';
function deps(score = 80): VisualEvalDeps {
  const launch = async (_o: LaunchOptions): Promise<ScreenshotBrowser> => ({
    newPage: async () => ({
      setContent: async () => {},
      waitForNetworkIdle: async () => {},
      waitForSelector: async () => null,
      evaluate: async () => 500,
      screenshot: async () => new Uint8Array([1, 2, 3]),
    }),
    close: async () => {},
  });
  return {
    launch,
    env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' },
    settleMs: 0,
    judge: async () => ({
      text: JSON.stringify({ completeness: score, layout: score, hierarchy: score, aesthetics: score, issues: [], critique: 'fine' }),
      inputTokens: 10,
      outputTokens: 5,
    }),
  };
}
const ctx = { compiledCode: COMPONENT, originalPrompt: 'a card', cssTokens: '' };
const base = { provider: 'claude' as const, passThreshold: 70, canvases: ['xs-chat-card' as const] };
const DEFAULT_SRC = resolve(resolveDesignPackageDir(), 'src');

describe('designTreeSha256', () => {
  it('is a sha256 over sorted relative paths + contents: order-independent, content-sensitive, path-sensitive', () => {
    const a = mkdtempSync(join(tmpdir(), 'ggui-design-a-'));
    mkdirSync(join(a, 'primitives'));
    writeFileSync(join(a, 'primitives', 'Card.tsx'), 'export const Card = 1;');
    writeFileSync(join(a, 'index.ts'), 'export * from "./primitives/Card";');
    const first = designTreeSha256(a);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(designTreeSha256(a)).toBe(first);
    writeFileSync(join(a, 'primitives', 'Card.tsx'), 'export const Card = 2;');
    expect(designTreeSha256(a)).not.toBe(first);
  });
  it('the identity is cached per path and forgets on reset', () => {
    resetJudgeDesignIdentityCache();
    const one = judgeDesignIdentity(DEFAULT_SRC);
    expect(judgeDesignIdentity(DEFAULT_SRC)).toBe(one);
    expect(one.src).toBe(DEFAULT_SRC);
    expect(one.srcSha256).toBe(designTreeSha256(DEFAULT_SRC));
  });
});

describe('the judgement names its design tree (ggui#1042) and its mode (ggui#1076)', () => {
  it('per-canvas: result.design = the default design src + its sha256; the summary carries it; no themeMode unless said', async () => {
    const out = await runVisualEvaluationDetailed(ctx, base, deps());
    expect(out.result!.design).toEqual({ src: DEFAULT_SRC, srcSha256: designTreeSha256(DEFAULT_SRC) });
    expect(out.result!.themeMode).toBeUndefined();
    const summary = summarizeVisualResult(out.result!)!;
    expect(summary.design).toEqual(out.result!.design);
    expect('themeMode' in summary).toBe(false);
  });
  it('themeMode is stamped through to the summary when the caller names the mode', async () => {
    const out = await runVisualEvaluationDetailed(ctx, { ...base, themeMode: 'dark' }, deps());
    expect(out.result!.themeMode).toBe('dark');
    expect(summarizeVisualResult(out.result!)!.themeMode).toBe('dark');
  });
  it('single viewport (no canvases): the judgement still names its tree', async () => {
    const out = await runVisualEvaluationDetailed(ctx, { provider: 'claude', passThreshold: 70 }, deps());
    expect(out.result!.design?.src).toBe(DEFAULT_SRC);
  });
  it('designSrcDir names the tree explicitly: the identity follows the input', async () => {
    const out = await runVisualEvaluationDetailed(ctx, { ...base, designSrcDir: DEFAULT_SRC }, deps());
    expect(out.result!.design?.src).toBe(DEFAULT_SRC);
  });
});
