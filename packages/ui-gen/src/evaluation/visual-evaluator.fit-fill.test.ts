/**
 * Pin (ggui#1100): fit@judge == fit@runtime. The served runtime composes
 * every fullscreen surface with `fit: 'fill'` (the mounted root stretched to
 * the frame) and leaves the inline card at its natural height; the judge
 * composes each canvas the same way — the page for `md` / `lg` / `xl` /
 * `mobile-fullscreen-small` carries the design's `fillFitRule` on the mount
 * element's scope class, the page for `xs-chat-card` does not — and stamps
 * `fit` on the per-canvas record so the row says how the judge composed.
 * Candidate 34's hellos were judged as a short block on an empty 768×1024
 * page after ggui#1098 removed the component's own `100vh`; the served
 * frame never looked like that.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { fillFitRule } from '@ggui-ai/design/rendering';
import { displayModeForCanvas } from '../design-mode.js';
import {
  JUDGE_SCOPE_CLASS,
  buildRenderHTML,
  canvasFit,
  runVisualEvaluationDetailed,
  summarizeVisualResult,
  type ScreenshotBrowser,
  type VisualEvalDeps,
} from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';

function deps(score = 85): VisualEvalDeps & { pages: string[] } {
  const pages: string[] = [];
  const launch = async (_o: LaunchOptions): Promise<ScreenshotBrowser> => ({
    newPage: async () => ({
      setContent: async (html: string) => {
        pages.push(html);
      },
      waitForNetworkIdle: async () => {},
      waitForSelector: async () => null,
      evaluate: async () => 500,
      screenshot: async () => new Uint8Array([1, 2, 3]),
    }),
    close: async () => {},
  });
  return {
    pages,
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

describe('fit@judge == fit@runtime (ggui#1100)', () => {
  it('the inline card is the only content-sized canvas; every other canvas fills', () => {
    expect(displayModeForCanvas('xs-chat-card')).toBe('inline');
    expect(canvasFit('xs-chat-card')).toBeUndefined();
    for (const c of ['mobile-fullscreen-small', 'md', 'lg', 'xl'] as const) {
      expect(displayModeForCanvas(c)).toBe('fullscreen');
      expect(canvasFit(c)).toBe('fill');
    }
  });

  it("the judge page carries the design's fill rule on the mount scope only when composed with fit: 'fill'", () => {
    const filled = buildRenderHTML(COMPONENT, undefined, 'fill');
    expect(filled).toContain(`<div id="root" class="${JUDGE_SCOPE_CLASS}">`);
    expect(filled).toContain(fillFitRule(JUDGE_SCOPE_CLASS));
    const inline = buildRenderHTML(COMPONENT);
    expect(inline).toContain('<div id="root"></div>');
    expect(inline).not.toContain(JUDGE_SCOPE_CLASS);
    expect(inline).not.toContain('min-height: 100vh');
  });

  it('per canvas: md is served the filled page and stamps fit, xs-chat-card is served the plain page and stamps nothing', async () => {
    const d = deps();
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a welcome card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card', 'md'] },
      d,
    );
    expect(result).not.toBeNull();
    expect(d.pages).toHaveLength(2);
    const [xsPage, mdPage] = d.pages;
    expect(xsPage).not.toContain(JUDGE_SCOPE_CLASS);
    expect(mdPage).toContain(`class="${JUDGE_SCOPE_CLASS}"`);
    expect(mdPage).toContain(fillFitRule(JUDGE_SCOPE_CLASS));
    const [xs, md] = result!.canvases!;
    expect(xs.fit).toBeUndefined();
    expect(md.fit).toBe('fill');
    const summary = summarizeVisualResult(result!)!;
    expect(summary.canvases.map((c) => [c.canvas, c.fit])).toEqual([
      ['xs-chat-card', undefined],
      ['md', 'fill'],
    ]);
    expect('fit' in summary.canvases[0]!).toBe(false);
  });
});
