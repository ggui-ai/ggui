/**
 * The canvas vocabulary — ONE definition shared by the prompt input and
 * the visual evaluator — and its derivation: class = DISPLAY MODE +
 * width, never width alone. Pins:
 *
 *   - monotonicity: for each display mode, walking widths 320..1600 px
 *     never moves the class backwards (the pre-fix width-only map went
 *     `mobile` → `xs-card` → `mobile` between 360 and 600 px);
 *   - the inline card is width-blind;
 *   - the fullscreen breakpoints are exactly 600 / 1024 / 1440;
 *   - every class has a judged viewport, and that viewport's width lands
 *     inside the class's own stated range (so the evaluator screenshots
 *     a width the prompt promised).
 */
import { describe, expect, it } from 'vitest';
import {
  CANVAS_BREAKPOINTS,
  CANVAS_CLASSES,
  CANVAS_DESCRIPTORS,
  CANVAS_VIEWPORTS,
  canvasDisplayModeForShell,
  canvasForRendering,
  canvasForViewportWidth,
  describeCanvas,
  type CanvasClass,
  type CanvasDisplayMode,
} from './design-mode.js';
import { canvasForRenderingContext } from './contract-context.js';

const RANK: Readonly<Record<CanvasClass, number>> = {
  'xs-chat-card': 0,
  'mobile-fullscreen-small': 1,
  md: 2,
  lg: 3,
  xl: 4,
};

describe('canvasForViewportWidth — display mode + width, monotonic in width', () => {
  for (const mode of ['inline', 'fullscreen'] as const satisfies readonly CanvasDisplayMode[]) {
    it(`${mode}: class rank never decreases over widths 320..1600`, () => {
      let prev = RANK[canvasForViewportWidth(mode, 320)];
      for (let w = 321; w <= 1600; w++) {
        const rank = RANK[canvasForViewportWidth(mode, w)];
        expect(rank, `width ${w}px`).toBeGreaterThanOrEqual(prev);
        prev = rank;
      }
    });
  }

  it('inline is the chat card at every width', () => {
    for (const w of [320, 360, 400, 480, 599, 600, 1023, 1024, 1439, 1440, 1600]) {
      expect(canvasForViewportWidth('inline', w)).toBe('xs-chat-card');
    }
  });

  it('fullscreen breakpoints are exactly 600 / 1024 / 1440', () => {
    expect(CANVAS_BREAKPOINTS).toEqual({ md: 600, lg: 1024, xl: 1440 });
    expect(canvasForViewportWidth('fullscreen', 320)).toBe('mobile-fullscreen-small');
    expect(canvasForViewportWidth('fullscreen', 599)).toBe('mobile-fullscreen-small');
    expect(canvasForViewportWidth('fullscreen', 600)).toBe('md');
    expect(canvasForViewportWidth('fullscreen', 1023)).toBe('md');
    expect(canvasForViewportWidth('fullscreen', 1024)).toBe('lg');
    expect(canvasForViewportWidth('fullscreen', 1439)).toBe('lg');
    expect(canvasForViewportWidth('fullscreen', 1440)).toBe('xl');
    expect(canvasForViewportWidth('fullscreen', 1600)).toBe('xl');
  });

  it('fullscreen never yields the chat card', () => {
    for (let w = 320; w <= 1600; w++) {
      expect(canvasForViewportWidth('fullscreen', w)).not.toBe('xs-chat-card');
    }
  });
});

describe('canvasDisplayModeForShell', () => {
  it('only chat / inline are the inline card; every other shell or display mode is width-governed', () => {
    expect(canvasDisplayModeForShell('chat')).toBe('inline');
    expect(canvasDisplayModeForShell('inline')).toBe('inline');
    for (const s of ['fullscreen', 'spatial', 'partial', 'pip', undefined]) {
      expect(canvasDisplayModeForShell(s)).toBe('fullscreen');
    }
  });
});

describe('canvasForRendering (shell × screen, no width known)', () => {
  it('maps the skeleton descriptors onto the shared vocabulary', () => {
    expect(canvasForRendering('chat', 'desktop')).toBe('xs-chat-card');
    expect(canvasForRendering('chat', undefined)).toBe('xs-chat-card');
    expect(canvasForRendering('spatial', 'desktop')).toBe('md');
    expect(canvasForRendering('fullscreen', 'mobile')).toBe('mobile-fullscreen-small');
    expect(canvasForRendering('fullscreen', 'tablet')).toBe('md');
    expect(canvasForRendering('fullscreen', 'desktop')).toBe('lg');
    expect(canvasForRendering(undefined, undefined)).toBe('lg');
  });
});

describe('canvasForRenderingContext (host rendering context)', () => {
  it('chat is width-blind; a viewport refines fullscreen / partial through the same derivation', () => {
    expect(canvasForRenderingContext({ device: 'desktop', shell: 'chat', viewport: { width: 1600, height: 900 } })).toBe('xs-chat-card');
    expect(canvasForRenderingContext({ device: 'desktop', shell: 'fullscreen', viewport: { width: 599, height: 900 } })).toBe('mobile-fullscreen-small');
    expect(canvasForRenderingContext({ device: 'desktop', shell: 'partial', viewport: { width: 700, height: 900 } })).toBe('md');
    expect(canvasForRenderingContext({ device: 'mobile', shell: 'fullscreen', viewport: { width: 1200, height: 900 } })).toBe('lg');
    expect(canvasForRenderingContext({ device: 'desktop', shell: 'fullscreen', viewport: { width: 1440, height: 900 } })).toBe('xl');
  });
  it('without a viewport the device decides', () => {
    expect(canvasForRenderingContext({ device: 'mobile', shell: 'fullscreen' })).toBe('mobile-fullscreen-small');
    expect(canvasForRenderingContext({ device: 'tablet', shell: 'fullscreen' })).toBe('md');
    expect(canvasForRenderingContext({ device: 'spatial', shell: 'fullscreen' })).toBe('md');
    expect(canvasForRenderingContext({ device: 'desktop', shell: 'partial' })).toBe('md');
    expect(canvasForRenderingContext({ device: 'desktop', shell: 'fullscreen' })).toBe('lg');
  });
});

describe('CANVAS_VIEWPORTS — the judged viewport per class', () => {
  it('is the benchmark map and every width sits inside its class range', () => {
    expect(CANVAS_VIEWPORTS).toEqual({
      'xs-chat-card': { width: 400, height: 640 },
      'mobile-fullscreen-small': { width: 390, height: 844 },
      md: { width: 768, height: 1024 },
      lg: { width: 1024, height: 768 },
      xl: { width: 1440, height: 900 },
    });
    for (const c of CANVAS_CLASSES) {
      const d = CANVAS_DESCRIPTORS[c];
      const v = CANVAS_VIEWPORTS[c];
      expect(v.width, c).toBeGreaterThanOrEqual(d.minWidthPx);
      expect(v.width, c).toBeLessThanOrEqual(d.maxWidthPx);
      // The judged width, fed back through the derivation, lands on its own class.
      const mode: CanvasDisplayMode = c === 'xs-chat-card' ? 'inline' : 'fullscreen';
      expect(canvasForViewportWidth(mode, v.width)).toBe(c);
      expect(describeCanvas(c)).toContain(`renders on the \`${c}\` canvas`);
    }
  });
});
