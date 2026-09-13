import { describe, it, expect } from 'vitest';
import { validateOverlayCoverage, NON_THEME_DEFINABLE_TOKENS } from './validate-overlay-coverage';
import { completeThemeVariables, deriveThemeVariables } from './derive-theme-variables';
import { darkTheme } from './defaults/dark';
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

// The roles the renderer DERIVES at paint time (the hero pair, the inverse
// family, the per-family container pairs). A projector from the previous
// release never sent them; the door must not refuse what the renderer
// completes.
const DERIVED_AT_RENDER = [
  '--ggui-color-errorContainer',
  '--ggui-color-heroGround',
  '--ggui-color-heroLink',
  '--ggui-color-heroOutline',
  '--ggui-color-infoContainer',
  '--ggui-color-inverseLink',
  '--ggui-color-inverseOutline',
  '--ggui-color-onErrorContainer',
  '--ggui-color-onHeroGround',
  '--ggui-color-onInfoContainer',
  '--ggui-color-onInverted',
  '--ggui-color-onPrimaryContainer',
  '--ggui-color-onSuccessContainer',
  '--ggui-color-onWarningContainer',
  '--ggui-color-primaryContainer',
  '--ggui-color-successContainer',
  '--ggui-color-warningContainer',
] as const;

function previousReleaseOverlay(mode: 'light' | 'dark'): Record<string, string> {
  const full = { ...deriveThemeVariables(mode === 'light' ? lightTheme : darkTheme, mode) } as Record<string, string>;
  for (const name of DERIVED_AT_RENDER) delete full[name];
  return full;
}

describe('validateOverlayCoverage — coverage is judged after completion (N−1: the previous release\'s projection)', () => {
  it.each(['light', 'dark'] as const)('%s: an overlay without the render-derived roles is fully covered', (mode) => {
    const overlay = previousReleaseOverlay(mode);
    for (const name of DERIVED_AT_RENDER) expect(overlay[name]).toBeUndefined();
    const r = validateOverlayCoverage(overlay);
    expect(r.uncovered).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it('the derivable set is the same in both modes — one completion answers the question of names', () => {
    const overlay = previousReleaseOverlay('light');
    const light = Object.keys(completeThemeVariables(overlay, 'light')).sort();
    const dark = Object.keys(completeThemeVariables(overlay, 'dark')).sort();
    expect(light).toEqual(dark);
    for (const name of DERIVED_AT_RENDER) expect(light).toContain(name);
  });

  it('completion needs its base: without `container` nothing derives, and the base role is reported beside the derived ones', () => {
    const overlay = previousReleaseOverlay('light');
    delete overlay['--ggui-color-container'];
    const r = validateOverlayCoverage(overlay);
    expect(r.uncovered).toContain('--ggui-color-container');
    expect(r.uncovered).toContain('--ggui-color-heroGround');
    expect(r.unknown).toEqual([]);
  });
});
