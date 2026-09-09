import { describe, it, expect } from 'vitest';
import { validateOverlayCoverage, NON_THEME_DEFINABLE_TOKENS } from './validate-overlay-coverage';
import { deriveThemeVariables } from './derive-theme-variables';
import { consumedTokenManifest } from './consumed-tokens';
import { lightTheme } from './defaults/light';

// ggui#987 §3.4 — the write-door check over a PROJECTION (an overlay), not a document.
describe('validateOverlayCoverage', () => {
  it('a derived overlay over the default document is fully covered, carries nothing unknown, and warns nothing', () => {
    const r = validateOverlayCoverage(deriveThemeVariables(lightTheme, 'light'));
    expect(r).toEqual({ uncovered: [], unknown: [], warnings: [] });
  });

  it('uncovered = manifest − floor − keys(overlay), sorted', () => {
    const overlay = { ...deriveThemeVariables(lightTheme, 'light') } as Record<string, string>;
    delete overlay['--ggui-color-ground'];
    delete overlay['--ggui-color-link'];
    expect(validateOverlayCoverage(overlay).uncovered).toEqual(['--ggui-color-ground', '--ggui-color-link']);
  });

  it('unknown = keys(overlay) − manifest − floor — a projected name nothing reads is named (the dead-key class)', () => {
    const overlay = { ...deriveThemeVariables(lightTheme, 'light'), '--ggui-color-surface': '#fff', '--ggui-motion-duration-fast': '100ms' };
    expect(validateOverlayCoverage(overlay).unknown).toEqual(['--ggui-color-surface', '--ggui-motion-duration-fast']);
  });

  it('the floor is neither required nor unknown', () => {
    const overlay = { ...deriveThemeVariables(lightTheme, 'light') } as Record<string, string>;
    for (const t of NON_THEME_DEFINABLE_TOKENS) overlay[t] = 'x';
    const r = validateOverlayCoverage(overlay);
    expect(r.uncovered).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it('warns on a non-monotone lightness ladder (§2.3: the projector SHOULD supply monotone ramps)', () => {
    const overlay = { ...deriveThemeVariables(lightTheme, 'light'), '--ggui-color-primary-300': '#000000' };
    const r = validateOverlayCoverage(overlay);
    expect(r.warnings.some((w) => w.includes('primary'))).toBe(true);
  });

  it('accepts an explicit manifest + floor (the door pins the version it checks against)', () => {
    const r = validateOverlayCoverage({ '--ggui-color-a': '#000' }, ['--ggui-color-a', '--ggui-color-b'], ['--ggui-color-b']);
    expect(r).toEqual({ uncovered: [], unknown: [], warnings: [] });
    expect(consumedTokenManifest.length).toBeGreaterThan(0);
  });
});
