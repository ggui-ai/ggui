/**
 * ggui#1492 — a host's presentation of each canvas arrives as DATA (`VisualEvalConfig.hostPresentations`): the inline
 * card judged inside the host's own frame (surface, ring, radius, ground, and its floor), a fill canvas's page ground,
 * and the label the judge is told. Absent ⇒ exactly today's page (the generic stand-in round the inline card, the
 * scrim under a panel). An entry the judge cannot use is ignored for its own canvas, never partly applied.
 * Browser + judge are injected.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { criteriaFrameLine } from './criteria/resolve.js';
import {
  CARD_OVERFLOW_X_EXPRESSION,
  JUDGE_GROUND_MARGIN_PX,
  JUDGE_INLINE_FRAME_CLASS,
  JUDGE_PANEL_CLASS,
  runVisualEvaluationDetailed,
  type CanvasHostPresentation,
  type ScreenshotBrowser,
  type VisualEvalDeps,
} from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';
interface Clip { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface Capture { readonly width: number; readonly height: number; readonly clip?: Clip }

function deps(cardHeight: number): VisualEvalDeps & { pages: string[]; captures: Capture[]; scripts: string[] } {
  const pages: string[] = [];
  const captures: Capture[] = [];
  const scripts: string[] = [];
  const launch = async (o: LaunchOptions): Promise<ScreenshotBrowser> => {
    const width = o.defaultViewport?.width ?? 0;
    const height = o.defaultViewport?.height ?? 0;
    return {
      newPage: async () => ({
        setContent: async (html: string) => {
          pages.push(html);
        },
        waitForNetworkIdle: async () => {},
        waitForSelector: async () => null,
        evaluate: async (expression: string) => {
          scripts.push(expression);
          if (expression === CARD_OVERFLOW_X_EXPRESSION) return 0;
          if (expression.includes("'max-content'")) return cardHeight;
          if (expression.includes('minHeight')) return undefined;
          return height;
        },
        screenshot: async (opts: { fullPage: boolean; clip?: Clip }) => {
          captures.push({ width, height, ...(opts.clip !== undefined ? { clip: opts.clip } : {}) });
          return new Uint8Array([1, 2, 3]);
        },
      }),
      close: async () => {},
    };
  };
  return {
    pages,
    captures,
    scripts,
    launch,
    env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' },
    settleMs: 0,
    judge: async () => ({
      text: JSON.stringify({ completeness: 80, layout: 80, hierarchy: 80, aesthetics: 80, issues: [], critique: 'fine' }),
      inputTokens: 10,
      outputTokens: 5,
    }),
  };
}

/** A chat widget's reference frame, shaped as the lane sends it. */
const WIDGET: CanvasHostPresentation = {
  label: 'a chat widget, inline, reference theme',
  frame: { surface: '#ffffff', ground: '#f6f5ee', ring: { widthPx: 1, color: '#0e1014', alpha: 0.08 }, radiusPx: 18, minHeightPx: 256 },
};
const CONTEXT = { compiledCode: COMPONENT, originalPrompt: 'a greeting card' };
/** Each bundle carries a comment naming its random temp directory; two builds of one page differ only there. */
const stable = (html: string): string => html.replace(/ggui-visual-eval-[A-Za-z0-9]+/g, 'ggui-visual-eval-TMP');

describe('ggui#1492 — the inline card inside the host\'s own frame', () => {
  it("draws the host's surface, ring, radius and ground, and pads the window by the ground margin plus the ring", async () => {
    const d = deps(300);
    const { result } = await runVisualEvaluationDetailed(CONTEXT, { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'], hostPresentations: { 'xs-chat-card': WIDGET } }, d);
    const page = d.pages[0]!;
    const rule = page.match(new RegExp(`\\.${JUDGE_INLINE_FRAME_CLASS} \\{([^}]*)\\}`))![1]!;
    expect(rule).toContain('background: #ffffff');
    expect(rule).toContain('border: 1px solid color-mix(in srgb, #0e1014 8%, transparent)');
    expect(rule).toContain('border-radius: 18px');
    expect(page).toContain('background: #f6f5ee;');
    const pad = JUDGE_GROUND_MARGIN_PX + 1;
    expect(d.captures).toEqual([{ width: 400 + 2 * pad, height: 640 + 2 * pad, clip: { x: 0, y: 0, width: 400 + 2 * pad, height: 300 + 2 * pad } }]);
    expect(result!.canvases![0]).toMatchObject({ contentHeight: 300, overflow: false });
  });

  it("the host's floor: a card shorter than it is captured in a frame the floor's height, its own height unchanged", async () => {
    const d = deps(152);
    const { result } = await runVisualEvaluationDetailed(CONTEXT, { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'], hostPresentations: { 'xs-chat-card': WIDGET } }, d);
    const pad = JUDGE_GROUND_MARGIN_PX + 1;
    expect(d.scripts.some((s) => s.includes("style.minHeight = '256px'"))).toBe(true);
    expect(d.captures[0]!.clip).toEqual({ x: 0, y: 0, width: 400 + 2 * pad, height: 256 + 2 * pad });
    expect(result!.canvases![0]!.contentHeight).toBe(152);
  });

  it('a card taller than the floor sets no floor', async () => {
    const d = deps(300);
    await runVisualEvaluationDetailed(CONTEXT, { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'], hostPresentations: { 'xs-chat-card': WIDGET } }, d);
    expect(d.scripts.some((s) => s.includes('minHeight'))).toBe(false);
  });

  it('the frame line names the host instead of the stand-in', () => {
    const line = criteriaFrameLine({ canvas: 'xs-chat-card', width: 400, height: 640, hostLabel: WIDGET.label });
    expect(line).toContain("inside the host's own frame (a chat widget, inline, reference theme)");
    expect(line).not.toContain('stand-in');
    expect(criteriaFrameLine({ canvas: 'md', width: 816, height: 736, hostLabel: 'a canvas pane, reference theme' })).toContain('816×736, a fixed full-screen box the card fills (a canvas pane, reference theme)');
  });
});

describe('ggui#1492 — a fill canvas on the host\'s ground', () => {
  it("replaces the scrim under the panel with the host's ground; the panel itself is unchanged (the host's pane chrome)", async () => {
    const plain = deps(0);
    await runVisualEvaluationDetailed(CONTEXT, { provider: 'claude', passThreshold: 70, canvases: ['md'] }, plain);
    const hosted = deps(0);
    await runVisualEvaluationDetailed(CONTEXT, { provider: 'claude', passThreshold: 70, canvases: ['md'], hostPresentations: { md: { label: 'a canvas pane', ground: '#eaeae3' } } }, hosted);
    const page = hosted.pages[0]!;
    expect(page).toContain('background: #eaeae3;');
    expect(page).toContain(`class="${JUDGE_PANEL_CLASS}"`);
    // Everything but the ground is the page a canvas without a presentation gets.
    const scrimFree = (html: string): string => html.replace(/body \{[\s\S]*?color: var\(--ggui-color-neutral-900/, 'body {');
    expect(stable(scrimFree(page))).toBe(stable(scrimFree(plain.pages[0]!)));
  });
});

describe('ggui#1492 — absent is today; an unusable entry is ignored for its own canvas', () => {
  it('no presentation and an empty map build byte-identical pages', async () => {
    const a = deps(300);
    await runVisualEvaluationDetailed(CONTEXT, { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card', 'md'] }, a);
    const b = deps(300);
    await runVisualEvaluationDetailed(CONTEXT, { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card', 'md'], hostPresentations: {} }, b);
    expect(b.pages.map(stable)).toEqual(a.pages.map(stable));
  });

  it('a colour that is not #rrggbb, or a frame on a canvas that is not the inline card, falls back to today with one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const today = deps(300);
    await runVisualEvaluationDetailed(CONTEXT, { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card', 'md'] }, today);
    const bad = deps(300);
    await runVisualEvaluationDetailed(
      CONTEXT,
      {
        provider: 'claude',
        passThreshold: 70,
        canvases: ['xs-chat-card', 'md'],
        hostPresentations: {
          'xs-chat-card': { ...WIDGET, frame: { ...WIDGET.frame!, surface: 'red; } body { display: none' } },
          md: { label: 'a canvas pane', frame: WIDGET.frame! },
        },
      },
      bad,
    );
    expect(bad.pages.map(stable)).toEqual(today.pages.map(stable));
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('host presentation'))).toEqual([
      '[visual-eval] host presentation for xs-chat-card ignored: a frame colour is not #rrggbb',
      '[visual-eval] host presentation for md ignored: a frame on a canvas that is not the inline card',
    ]);
    warn.mockRestore();
  });
});
