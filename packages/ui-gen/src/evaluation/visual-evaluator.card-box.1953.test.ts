// ggui#1953 — a framed card (a chat-width card on a fullscreen surface, ggui#1924) is captured as the inline card is:
// its OWN box at its natural extent plus the frame ground's margin, never the pane round it. The judge was scoring the
// pane's empty host ground below a short hello against the card (md notes named the empty field 6/6).
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { CARD_BOX_EXPRESSION, JUDGE_GROUND_MARGIN_PX, cardBoxClip, runVisualFit, type ScreenshotBrowser, type VisualEvalDeps } from './visual-evaluator.js';

const FRAMED = 'export default function C(){ return null; } export const gguiMountCanvas = "xs-chat-card";';
const UNFRAMED = 'export default function C(){ return null; }';
const M = JUDGE_GROUND_MARGIN_PX;
interface Clip { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface Capture { readonly width: number; readonly height: number; readonly fullPage: boolean; readonly clip?: Clip }

function deps(box: { x: number; y: number; width: number; height: number }, documentHeight: number): VisualEvalDeps & { captures: Capture[] } {
  const captures: Capture[] = [];
  const launch = async (o: LaunchOptions): Promise<ScreenshotBrowser> => {
    const width = o.defaultViewport?.width ?? 0;
    const height = o.defaultViewport?.height ?? 0;
    return {
      newPage: async () => ({
        setContent: async () => {},
        waitForNetworkIdle: async () => {},
        waitForSelector: async () => null,
        evaluate: async (expression: string) => (expression === CARD_BOX_EXPRESSION ? box : documentHeight),
        screenshot: async (opts: { fullPage: boolean; clip?: Clip }) => {
          captures.push({ width, height, fullPage: opts.fullPage, ...(opts.clip !== undefined ? { clip: opts.clip } : {}) });
          return new Uint8Array([1, 2, 3]);
        },
      }),
      close: async () => {},
    };
  };
  return { captures, launch, env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' }, settleMs: 0 };
}

describe('cardBoxClip (ggui#1953)', () => {
  it('the card box with the ground margin on every side', () => {
    expect(cardBoxClip({ width: 848, height: 768 }, { x: 32, y: 32, width: 784, height: 180 })).toEqual({ x: 32 - M, y: 32 - M, width: 784 + 2 * M, height: 180 + 2 * M });
  });
  it('clamped to the window, never below one row', () => {
    expect(cardBoxClip({ width: 848, height: 768 }, { x: 32, y: 32, width: 784, height: 900 }).height).toBe(768 - (32 - M));
    expect(cardBoxClip({ width: 848, height: 768 }, { x: 8, y: 8, width: 100, height: 0.2 }).y).toBe(0);
  });
});

describe('a framed card is captured on its own box, at md (ggui#1953)', () => {
  it('a short hello: clipped to the card plus the margin, contentHeight is the card, the empty pane is not in the frame', async () => {
    const box = { x: 32, y: 32, width: 784, height: 180 };
    const d = deps(box, 768);
    const outcome = await runVisualFit({ compiledCode: FRAMED, originalPrompt: 'a hello' }, { canvases: ['md'] }, d);
    expect(d.captures).toHaveLength(1);
    expect(d.captures[0]!.fullPage).toBe(false);
    expect(d.captures[0]!.clip).toEqual(cardBoxClip({ width: d.captures[0]!.width, height: d.captures[0]!.height }, box));
    expect(outcome.status).toBe('measured');
    if (outcome.status === 'measured') expect(outcome.readings[0]!.contentHeight).toBe(180);
  });

  it('a root that stretches itself keeps its void: its own box is tall, so the capture is tall', async () => {
    const box = { x: 32, y: 32, width: 784, height: 704 };
    const d = deps(box, 768);
    await runVisualFit({ compiledCode: FRAMED, originalPrompt: 'a hello' }, { canvases: ['md'] }, d);
    expect(d.captures[0]!.clip!.height).toBeGreaterThan(704);
  });

  it('fails closed, named, when the card box cannot be measured: no full-pane fallback', async () => {
    const d = deps({ x: 0, y: 0, width: 0, height: 0 }, 768);
    const outcome = await runVisualFit({ compiledCode: FRAMED, originalPrompt: 'a hello' }, { canvases: ['md'] }, d);
    expect(d.captures).toHaveLength(0);
    expect(JSON.stringify(outcome)).toContain("the card's own box could not be measured");
  });

  it('control: an unframed card at md keeps the full-page capture', async () => {
    const d = deps({ x: 0, y: 0, width: 816, height: 400 }, 736);
    await runVisualFit({ compiledCode: UNFRAMED, originalPrompt: 'a page' }, { canvases: ['md'] }, d);
    expect(d.captures[0]!.clip).toBeUndefined();
  });
});
