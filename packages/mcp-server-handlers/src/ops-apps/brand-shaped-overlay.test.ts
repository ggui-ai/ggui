/**
 * detectBrandShapedOverlay (ggui#598 slice 3 — the migration WARN):
 * an overlay carrying brand-scale color coverage (≥3 color families)
 * over an UNRESOLVED name is almost certainly a brand trying to live
 * in the accent tier — the round-3 shape. The WARN names the
 * registration path; it never blocks (overlays stay legal, the tier
 * just stops being silent).
 */
import { describe, expect, it } from 'vitest';
import { detectBrandShapedOverlay } from './set-app-theme.js';

const brandVars = {
  '--ggui-color-primary-500': '#B8FF3A',
  '--ggui-color-primary-600': '#CCFF66',
  '--ggui-color-success-500': '#B8FF3A',
  '--ggui-color-error-500': '#ef4444',
  '--ggui-color-surface': '#101216',
};

describe('detectBrandShapedOverlay', () => {
  it('≥3 color families + unresolved name → the WARN, naming the registration path', () => {
    const warning = detectBrandShapedOverlay(
      { mode: 'dark', cssVariables: brandVars, name: 'My Brand' },
      { knownThemeIds: ['ggui', 'guuey-brand-v1'] },
    );
    expect(warning).toBeDefined();
    expect(warning).toContain('4 color families');
    expect(warning).toContain('register');
  });

  it('a registered base name suppresses the WARN — brand-scale accents over a covered base are legitimate', () => {
    expect(
      detectBrandShapedOverlay(
        { mode: 'dark', cssVariables: brandVars, name: 'guuey-brand-v1' },
        { knownThemeIds: ['ggui', 'guuey-brand-v1'] },
      ),
    ).toBeUndefined();
  });

  it('a small accent overlay never warns, name or not', () => {
    expect(
      detectBrandShapedOverlay(
        {
          mode: 'light',
          cssVariables: { '--ggui-color-primary-600': '#123456', '--ggui-shape-radius-md': '12px' },
        },
        { knownThemeIds: [] },
      ),
    ).toBeUndefined();
  });

  it('no known-ids composed → the name cannot be resolved, so brand-scale coverage still warns', () => {
    expect(
      detectBrandShapedOverlay({ mode: 'dark', cssVariables: brandVars }, {}),
    ).toBeDefined();
  });
});
