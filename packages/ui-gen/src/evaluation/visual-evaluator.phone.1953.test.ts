// ggui#1953 — a framed card on the phone canvas (no fit, no chrome) is composed as the runtime serves it: the card's
// own frame on the room's ground, so its box can be measured. The judge used the plain page there, which has no card
// scope, so the card-box capture failed closed and voided every framed cell's visual verdict.
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { FRAMED_CARD_GROUND } from '@ggui-ai/design/rendering';
import { CARD_BOX_EXPRESSION, JUDGE_SCOPE_CLASS, cardBoxClip, runVisualFit, type ScreenshotBrowser, type VisualEvalDeps } from './visual-evaluator.js';

const FRAMED = 'export default function C(){ return null; } export const gguiMountCanvas = "xs-chat-card";';
interface Clip { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** A browser whose card box exists only when the page it was handed carries the card's scope — as a real page would. */
function deps(box: Clip): VisualEvalDeps & { pages: string[]; clips: (Clip | undefined)[]; windows: { width: number; height: number }[] } {
  const pages: string[] = [];
  const clips: (Clip | undefined)[] = [];
  const windows: { width: number; height: number }[] = [];
  const launch = async (o: LaunchOptions): Promise<ScreenshotBrowser> => {
    windows.push({ width: o.defaultViewport?.width ?? 0, height: o.defaultViewport?.height ?? 0 });
    let html = '';
    return {
      newPage: async () => ({
        setContent: async (h: string) => {
          html = h;
          pages.push(h);
        },
        waitForNetworkIdle: async () => {},
        waitForSelector: async () => null,
        evaluate: async (expression: string) =>
          expression === CARD_BOX_EXPRESSION ? (html.includes(`class="${JUDGE_SCOPE_CLASS}"`) ? box : null) : box.height,
        screenshot: async (opts: { fullPage: boolean; clip?: Clip }) => {
          clips.push(opts.clip);
          return new Uint8Array([1, 2, 3]);
        },
      }),
      close: async () => {},
    };
  };
  return { pages, clips, windows, launch, env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' }, settleMs: 0 };
}

describe('a framed card on the phone canvas (ggui#1953)', () => {
  const box = { x: 16, y: 16, width: 327, height: 180 };
  it("is composed with the card's scope, so its own box is measured and captured, never failed closed", async () => {
    const d = deps(box);
    const outcome = await runVisualFit({ compiledCode: FRAMED, originalPrompt: 'a hello' }, { canvases: ['mobile-fullscreen-small'] }, d);
    expect(outcome.status).toBe('measured');
    if (outcome.status === 'measured') expect(outcome.readings[0]!.contentHeight).toBe(180);
    expect(d.pages[0]).toContain(`<div id="root" class="${JUDGE_SCOPE_CLASS}">`);
    expect(d.clips[0]).toEqual(cardBoxClip(d.windows[0]!, box));
  });
  it("sits on the room's sunken ground, the constant the runtime paints, with no panel drawn", async () => {
    const d = deps(box);
    await runVisualFit({ compiledCode: FRAMED, originalPrompt: 'a hello' }, { canvases: ['mobile-fullscreen-small'] }, d);
    expect(d.pages[0]).toContain(`body { background: ${FRAMED_CARD_GROUND}; }`);
    expect(d.pages[0]).not.toContain('class="ggui-judge-panel"');
  });
  it('at md the panel paints the ground; the body keeps the scrim', async () => {
    const d = deps({ x: 32, y: 32, width: 784, height: 180 });
    await runVisualFit({ compiledCode: FRAMED, originalPrompt: 'a hello' }, { canvases: ['md'] }, d);
    expect(d.pages[0]).toContain('class="ggui-judge-panel"');
    expect(d.pages[0]).not.toContain(`body { background: ${FRAMED_CARD_GROUND}; }`);
  });
});
