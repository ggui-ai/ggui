/**
 * ggui#1120 — the judge reads the ink of the capture it already takes. A flat capture is the blank:
 * a deterministic `canvas-blank` (critical) that fails the canvas on every class, the one instrument
 * that can see a mount-path blank (#1104). On a panelled page (ggui#1083 cut 3) the ink is read inside
 * the host's chrome, so a hairline never counts as paint; on the inline card's host ground (ggui#1475)
 * it is read inside the ground margin. Every other reading is reported, never scored.
 * Browser + judge are injected; the fake browser's screenshots are real PNGs.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { encodePng, flatPng } from './__fixtures__/png.js';
import {
  CARD_HEIGHT_EXPRESSION,
  JUDGE_GROUND_MARGIN_PX,
  JUDGE_INLINE_INK_INSET_PX,
  JUDGE_INLINE_PAD_PX,
  JUDGE_INK_INSET_PX,
  JUDGE_PANEL_CLASS,
  runVisualEvaluationDetailed,
  runVisualFit,
  summarizeVisualResult,
  type ScreenshotBrowser,
  type VisualEvalDeps,
} from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';
const GROUND = [245, 237, 239] as const;
const INK = [20, 30, 40] as const;
type Box = { readonly width: number; readonly height: number };

/** A fake browser whose screenshot is a PNG painted per page by `paint`, at the window the judge asked for. */
function inkDeps(paint: (window: Box, panelled: boolean) => Uint8Array, score = 85, cardHeight?: number): VisualEvalDeps & { pages: string[] } {
  const pages: string[] = [];
  const launch = async (o: LaunchOptions): Promise<ScreenshotBrowser> => {
    const window = { width: o.defaultViewport?.width ?? 0, height: o.defaultViewport?.height ?? 0 };
    let panelled = false;
    return {
      newPage: async () => ({
        setContent: async (html: string) => {
          pages.push(html);
          panelled = html.includes(JUDGE_PANEL_CLASS);
        },
        waitForNetworkIdle: async () => {},
        waitForSelector: async () => null,
        // The inline card is measured from its mount (ggui#1475): a card exactly its box tall; any other
        // canvas from the document, which carries the panel's gap when one was drawn.
        evaluate: async (expression: string) =>
          expression === CARD_HEIGHT_EXPRESSION ? (cardHeight ?? window.height - 2 * JUDGE_INLINE_PAD_PX) : window.height + (panelled ? 32 : 0),
        screenshot: async () => paint(window, panelled),
      }),
      close: async () => {},
    };
  };
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

const flat = (w: Box): Uint8Array => flatPng(w.width, w.height, GROUND);
/** Ink on one row of the window, nothing else. */
const lineAt = (row: number) => (w: Box): Uint8Array => encodePng({ width: w.width, height: w.height, channels: 3, pixel: (_x, y) => (y === row ? INK : GROUND) });
/** A 1 px ring where a host panel's hairline sits (the gap in from every edge), nothing inside. */
const hairlineOnly = (w: Box): Uint8Array =>
  encodePng({ width: w.width, height: w.height, channels: 3, pixel: (x, y) => (Math.min(x, y, w.width - 1 - x, w.height - 1 - y) === 15 ? INK : GROUND) });

describe('the blank (ggui#1120): a flat capture fails the canvas, on every class', () => {
  it('xs and md: canvas-blank critical, passed=false, inkRatio 0 — and the summary carries the ratio', async () => {
    const d = inkDeps(flat);
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a welcome card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card', 'md'] },
      d,
    );
    expect(result).not.toBeNull();
    const [xs, md] = result!.canvases!;
    expect([xs.inkRatio, xs.passed, md.inkRatio, md.passed]).toEqual([0, false, 0, false]);
    const blanks = result!.issues.filter((i) => i.dimension === 'canvas-blank');
    expect(blanks.map((i) => [i.severity, i.description])).toEqual([
      ['critical', '[xs-chat-card] Nothing painted on the xs-chat-card canvas (400×640): the capture is one flat colour — the component mounted and rendered no pixels.'],
      ['critical', '[md] Nothing painted on the md canvas (768×1024): the capture is one flat colour — the component mounted and rendered no pixels.'],
    ]);
    expect(result!.passed).toBe(false);
    expect(result!.finalScore).toBe(85); // the score stays the judge's; the verdict is the instrument's
    expect(summarizeVisualResult(result!)!.canvases.map((c) => [c.canvas, c.inkRatio, c.passed])).toEqual([
      ['xs-chat-card', 0, false],
      ['md', 0, false],
    ]);
  });

  it("on a panelled page the host's hairline never counts: ink only where the panel's chrome sits is still the blank", async () => {
    const d = inkDeps(hairlineOnly);
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a welcome card' },
      { provider: 'claude', passThreshold: 70, canvases: ['md'] },
      d,
    );
    const [md] = result!.canvases!;
    expect(md.inkRatio).toBe(0);
    expect(md.passed).toBe(false);
    expect(JUDGE_INK_INSET_PX).toBe(41);
  });

  it("ggui#1475 — on the inline card's host ground the margin never counts: ink only in the ground ring is still the blank", async () => {
    // A 1 px ring 8 px in from every edge — half-way into the 16 px ground margin: host surface, not the card.
    // A literal, so the case paints the same ring whatever the constant says; the constant is pinned below.
    const groundRing = (w: Box): Uint8Array =>
      encodePng({ width: w.width, height: w.height, channels: 3, pixel: (x, y) => (Math.min(x, y, w.width - 1 - x, w.height - 1 - y) === 8 ? INK : GROUND) });
    const d = inkDeps(groundRing);
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a welcome card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'] },
      d,
    );
    const [xs] = result!.canvases!;
    expect(xs.inkRatio).toBe(0);
    expect(xs.passed).toBe(false);
    expect(result!.issues.map((i) => i.dimension)).toContain('canvas-blank');
    expect(JUDGE_GROUND_MARGIN_PX).toBe(16);
  });

  it("ggui#1475 — the host frame's ring and rounded corner never count as paint: a frame with nothing inside is still the blank", async () => {
    // The stand-in frame's 1 px ring sits 16 px in (past the ground margin) and its 16 px corner exposes the ground:
    // paint both, nothing else. The ink is read past the margin, the ring and the corner radius (33 px), literal here.
    const frameOnly = (w: Box): Uint8Array =>
      encodePng({ width: w.width, height: w.height, channels: 3, pixel: (x, y) => {
        const edge = Math.min(x, y, w.width - 1 - x, w.height - 1 - y);
        const inCorner = (x < 32 || x > w.width - 33) && (y < 32 || y > w.height - 33) && edge < 32;
        return edge === 16 || inCorner ? INK : GROUND;
      } });
    const d = inkDeps(frameOnly);
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a welcome card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'] },
      d,
    );
    const [xs] = result!.canvases!;
    expect(xs.inkRatio).toBe(0);
    expect(xs.passed).toBe(false);
    expect(JUDGE_INLINE_INK_INSET_PX).toBe(33);
  });

  it('ggui#1475 — a card that measured no height is the blank, read from the measurement even when its ink is unreadable', async () => {
    const d = inkDeps(() => new Uint8Array([1, 2, 3]), 85, 0);
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a welcome card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'] },
      d,
    );
    const [xs] = result!.canvases!;
    expect([xs.inkRatio, xs.contentHeight, xs.passed]).toEqual([null, 0, false]);
    expect(result!.issues.map((i) => i.dimension)).toContain('canvas-blank');
  });

  it('ink inside the panel is measured over the region and reported, never scored: no issue, the canvas passes', async () => {
    // A line at window row 400 on the md page (window 800×1056): region row 359 of 974.
    const d = inkDeps(lineAt(400));
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a welcome card' },
      { provider: 'claude', passThreshold: 70, canvases: ['md'] },
      d,
    );
    const [md] = result!.canvases!;
    expect(md.inkRatio).toBe(0.37);
    expect(md.passed).toBe(true);
    expect(result!.issues.filter((i) => i.dimension === 'canvas-blank')).toEqual([]);
  });

  it('an unreadable capture is reported as null and never judged blank', async () => {
    const d = inkDeps(() => new Uint8Array([1, 2, 3]));
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a welcome card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'] },
      d,
    );
    const [xs] = result!.canvases!;
    expect([xs.inkRatio, xs.passed]).toEqual([null, true]);
    expect(result!.issues.filter((i) => i.dimension === 'canvas-blank')).toEqual([]);
  });

  it('the fit-only path reads the same instrument: readings carry inkRatio and a blank is an issue', async () => {
    const d = inkDeps((w, panelled) => (panelled ? lineAt(400)(w) : flat(w)));
    const outcome = await runVisualFit({ compiledCode: COMPONENT, originalPrompt: 'a welcome card' }, { canvases: ['xs-chat-card', 'md'] }, d);
    if (outcome.status !== 'measured') throw new Error(`unexpected ${outcome.status}`);
    expect(outcome.readings.map((r) => [r.canvas, r.inkRatio])).toEqual([
      ['xs-chat-card', 0],
      ['md', 0.37],
    ]);
    expect(outcome.issues.map((i) => [i.severity, i.description.slice(0, 40)])).toEqual([['critical', '[xs-chat-card] Nothing painted on the xs']]);
  });
});
