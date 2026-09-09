import { describe, expect, it } from 'vitest';
import { appThemeRefusalBodySchema, appThemeSchema, type AppTheme } from './app-theme.js';

const HASH = 'a'.repeat(64);

/**
 * ggui#987 — the overlay is the projection: both modes REQUIRED, the
 * attestation REQUIRED, `mode` a default only, `name` a label, `base` gone.
 * The one-palette v1 wire is refused at the schema — no adapter branch.
 */
describe('appThemeSchema (v2, ggui#987)', () => {
  const valid: AppTheme = {
    overlayHash: HASH,
    overlays: {
      light: { '--ggui-color-primary-600': '#7c3aed', '--ggui-shape-radius-md': '12px' },
      dark: { '--ggui-color-primary-600': '#a78bfa', '--ggui-shape-radius-md': '12px' },
    },
    name: 'ocean',
    mode: 'dark',
  };

  it('accepts a well-formed two-mode overlay with its attestation', () => {
    expect(appThemeSchema.parse(valid)).toEqual(valid);
  });

  it('accepts without name and without mode (mode-neutral: the host announce fills it)', () => {
    const { name: _n, mode: _m, ...neutral } = valid;
    expect(appThemeSchema.parse(neutral)).toEqual(neutral);
  });

  it('REFUSES the v1 one-palette wire (mode + cssVariables, no overlays)', () => {
    expect(appThemeSchema.safeParse({ mode: 'light', cssVariables: { '--ggui-color-primary-500': '#3355ff' } }).success).toBe(false);
  });

  it('REFUSES a `base` ladder — the registration tier is gone (D2 = B)', () => {
    expect(
      appThemeSchema.safeParse({
        ...valid,
        base: { documentHash: HASH, light: {}, dark: {} },
      }).success,
    ).toBe(false);
  });

  it('REFUSES an overlay missing either mode', () => {
    expect(appThemeSchema.safeParse({ ...valid, overlays: { light: valid.overlays.light } }).success).toBe(false);
    expect(appThemeSchema.safeParse({ ...valid, overlays: { dark: valid.overlays.dark } }).success).toBe(false);
  });

  it('REFUSES a missing or malformed overlayHash', () => {
    const { overlayHash: _h, ...noHash } = valid;
    expect(appThemeSchema.safeParse(noHash).success).toBe(false);
    expect(appThemeSchema.safeParse({ ...valid, overlayHash: 'ABC' }).success).toBe(false);
  });

  it('accepts mode-agnostic cssVariables on top of both projections', () => {
    const withVars = { ...valid, cssVariables: { '--ggui-shape-radius-md': '4px' } };
    expect(appThemeSchema.parse(withVars)).toEqual(withVars);
  });

  it('rejects a non-ggui css-var key in any map', () => {
    expect(appThemeSchema.safeParse({ ...valid, cssVariables: { '--evil-x': 'red' } }).success).toBe(false);
    expect(appThemeSchema.safeParse({ ...valid, overlays: { ...valid.overlays, light: { '--evil-x': 'red' } } }).success).toBe(false);
  });

  it('rejects an injection value (CSS rule breakout) in a projection', () => {
    expect(
      appThemeSchema.safeParse({
        ...valid,
        overlays: { ...valid.overlays, dark: { '--ggui-color-primary-600': 'red; } :root { background: url(x) }' } },
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid mode', () => {
    expect(appThemeSchema.safeParse({ ...valid, mode: 'sepia' }).success).toBe(false);
  });

  it('accepts per-mode keyframes and frameless; rejects oversized keyframes', () => {
    const kf = { ...valid, keyframes: { light: '@keyframes a{}', dark: '@keyframes b{}' }, frameless: true };
    expect(appThemeSchema.parse(kf)).toEqual(kf);
    expect(appThemeSchema.safeParse({ ...valid, keyframes: { light: 'x'.repeat(8193) } }).success).toBe(false);
  });

  it('stays strict — unknown fields rejected', () => {
    expect(appThemeSchema.safeParse({ ...valid, courts: {} }).success).toBe(false);
  });
});

describe('appThemeRefusalBodySchema — the one write-door refusal shape', () => {
  it('accepts exactly one of the four bodies', () => {
    for (const body of [
      { uncovered: { light: ['--ggui-color-outline'], dark: [] } },
      { unknown: { light: [], dark: ['--ggui-color-surface'] } },
      { overlayHash: 'mismatch' },
      { refused: 'v1 shape' },
    ]) expect(appThemeRefusalBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
  });
  it('refuses a body that names two reasons or an unknown one', () => {
    expect(appThemeRefusalBodySchema.safeParse({ overlayHash: 'mismatch', refused: 'v1 shape' }).success).toBe(false);
    expect(appThemeRefusalBodySchema.safeParse({ reason: 'x' }).success).toBe(false);
  });
});
