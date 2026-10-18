/**
 * The ONE mount-fit rule and the ONE inline card frame derivation. The runtime's composition, the
 * evaluator's capture, its frame statement and a host's judge-frame formula all read these, so the
 * pins here are the contract they share.
 */
import { describe, expect, it } from 'vitest';
import {
  CANVAS_CLASSES,
  FRAMED_CARD_GROUND,
  INLINE_CARD_RADIUS_PX,
  RADIUS_LADDERS,
  cardFitRule,
  composeThemeCss,
  fillFitRule,
  inlineCardRadius,
  isCanvasClass,
  recoverRadiusBucket,
  resolveMountFit,
} from './index';

const ladderVars = (l: readonly number[]): Record<string, string> => ({
  '--ggui-shape-radius-sm': `${l[0]}px`,
  '--ggui-shape-radius-md': `${l[1]}px`,
  '--ggui-shape-radius-lg': `${l[2]}px`,
  '--ggui-shape-radius-xl': `${l[3]}px`,
});

describe('resolveMountFit — one rule, failing closed', () => {
  it('a chat-width card on a fullscreen surface keeps its natural height in its own frame', () => {
    expect(resolveMountFit({ canvas: 'xs-chat-card', displayMode: 'fullscreen' })).toBe('framed-card');
  });

  it('inline (or no announced mode) composes nothing, whatever the canvas', () => {
    for (const canvas of [...CANVAS_CLASSES, undefined]) {
      expect(resolveMountFit({ canvas, displayMode: 'inline' })).toBe('card');
      expect(resolveMountFit({ canvas, displayMode: undefined })).toBe('card');
    }
  });

  it("Rule 0 holds for every canvas item: under fullscreen only the chat-width card is framed by the runtime", () => {
    for (const canvas of CANVAS_CLASSES.filter((c) => c !== 'xs-chat-card')) {
      expect(resolveMountFit({ canvas, displayMode: 'fullscreen' })).toBe('fill');
    }
  });

  it('fails closed: an absent or unknown canvas fills under fullscreen, as every bundle did before the export existed', () => {
    for (const canvas of [undefined, null, '', 'chat-card', 42, { canvas: 'xs-chat-card' }]) {
      expect(resolveMountFit({ canvas, displayMode: 'fullscreen' })).toBe('fill');
    }
    expect(resolveMountFit({ canvas: 'xs-chat-card', displayMode: 'pip' })).toBe('card');
  });

  it('isCanvasClass narrows only the vocabulary', () => {
    expect(CANVAS_CLASSES.every(isCanvasClass)).toBe(true);
    expect(isCanvasClass('XS-CHAT-CARD')).toBe(false);
    expect(isCanvasClass(undefined)).toBe(false);
  });
});

describe('the inline card frame — one derivation', () => {
  it("each ladder recovers its bucket; any other ladder is null, never the nearest", () => {
    expect(recoverRadiusBucket([0, 0, 0, 0])).toBe('none');
    expect(recoverRadiusBucket([4, 8, 12, 16])).toBe('soft');
    expect(recoverRadiusBucket([8, 12, 18, 24])).toBe('round');
    expect(recoverRadiusBucket([4, 8, 12, 15])).toBeNull();
    expect(recoverRadiusBucket([null, 8, 12, 16])).toBeNull();
  });

  it("a bucket's frame radius is the table's, not a ladder stop (soft's 10 px is on no ladder)", () => {
    for (const bucket of ['none', 'soft', 'round'] as const) {
      expect(inlineCardRadius(ladderVars(RADIUS_LADDERS[bucket]))).toEqual({ bucket, radiusPx: INLINE_CARD_RADIUS_PX[bucket], source: 'bucket' });
    }
    expect(RADIUS_LADDERS.soft).not.toContain(INLINE_CARD_RADIUS_PX.soft);
  });

  it("no forwarded ladder (an older host, any other host): the theme's own lg stop; unreadable: null", () => {
    expect(inlineCardRadius(ladderVars([2, 2, 4, 6]))).toEqual({ bucket: null, radiusPx: 4, source: 'theme-lg' });
    expect(inlineCardRadius({})).toEqual({ bucket: null, radiusPx: null, source: 'theme-lg' });
    expect(inlineCardRadius({ '--ggui-shape-radius-lg': '1rem' })).toEqual({ bucket: null, radiusPx: null, source: 'theme-lg' });
  });
});

describe('composeThemeCss follows the fit', () => {
  const APP = { overlays: { light: { ...ladderVars(RADIUS_LADDERS.round) } } };
  it('framed-card appends the card frame with the bucket radius, never the fill rule', () => {
    const css = composeThemeCss({ layer: 'tree', scopeClass: 's1', mode: 'light', appTheme: APP, fit: 'framed-card' });
    expect(css).toContain(cardFitRule('s1', 18));
    expect(css).not.toContain(fillFitRule('s1'));
  });
  it('fill appends the fill rule only; card (and absent) append neither', () => {
    const fill = composeThemeCss({ layer: 'tree', scopeClass: 's1', mode: 'light', appTheme: APP, fit: 'fill' });
    expect(fill).toContain(fillFitRule('s1'));
    expect(fill).not.toContain('.s1 { margin: 16px;');
    for (const fit of ['card', undefined] as const) {
      const css = composeThemeCss({ layer: 'tree', scopeClass: 's1', mode: 'light', appTheme: APP, ...(fit !== undefined ? { fit } : {}) });
      expect(css).not.toContain(fillFitRule('s1'));
      expect(css).not.toContain('.s1 { margin: 16px;');
    }
  });
  it("the card frame is the inline card's: surface, a 1 px ring of its ink at 8 %, its radius, clipped, no shadow", () => {
    const rule = cardFitRule('s1', 10);
    expect(rule).toContain('background: var(--ggui-color-container)');
    expect(rule).toContain('border: 1px solid color-mix(in srgb, var(--ggui-color-onContainer) 8%, transparent)');
    expect(rule).toContain('border-radius: 10px');
    expect(rule).toContain('overflow: clip');
    expect(rule).toContain('box-shadow: none');
    expect(cardFitRule('s1', null)).toContain('border-radius: var(--ggui-shape-radius-lg)');
  });
  it("the room round a framed card is the host's sunken pane ground, set through the render shell's backdrop property", () => {
    expect(FRAMED_CARD_GROUND).toBe('var(--ggui-color-sunken)');
    expect(cardFitRule('s1', 10)).toContain(`html:has(.s1) { --ggui-shell-background: ${FRAMED_CARD_GROUND}; }`);
  });
});
