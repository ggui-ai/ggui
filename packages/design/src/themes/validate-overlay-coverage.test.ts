import { describe, it, expect } from 'vitest';
import { validateOverlayCoverage, NON_THEME_DEFINABLE_TOKENS, LADDER_COVERED_TOKENS } from './validate-overlay-coverage';
import { completeThemeVariables, deriveThemeVariables } from './derive-theme-variables';
import { darkTheme } from './defaults/dark';
import { consumedTokenManifest } from './consumed-tokens';
import { lightTheme } from './defaults/light';
import previousReleaseManifest from './__fixtures__/consumed-tokens.manifest.release-5.json' with { type: 'json' };

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
    const overlay = { ...deriveThemeVariables(lightTheme, 'light'), '--ggui-color-surface': '#fff', '--ggui-motion-duration-glacial': '100ms' };
    expect(validateOverlayCoverage(overlay).unknown).toEqual(['--ggui-color-surface', '--ggui-motion-duration-glacial']);
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

// ggui#1184 — the consumed-token manifest is a WIRE between independently-rolled surfaces: a
// client pinned to the previous release projects exactly that release's manifest, and this
// release's door judges coverage against today's. Under the N−1 rule a receiver never requires a
// token the previous release could not send — so the manifest may GROW only with a completion
// rule in `completeThemeVariables` (the token fills from what a previous projection carries) or a
// floor entry. Bought on prod: a control-radius role added in one release, without a completion
// rule, refused every previous-release theme write as `uncovered`. The fixture is the PREVIOUS
// release's manifest verbatim; it is re-pinned at each release cut.
describe('N−1: the manifest grows only with a completion rule or a floor entry (ggui#1184, VERSION-POLICY §3.6)', () => {
  const previous = new Set<string>(previousReleaseManifest.tokens);
  const previousProjection = (): Record<string, string> =>
    Object.fromEntries(Object.entries(deriveThemeVariables(lightTheme, 'light')).filter(([k]) => previous.has(k)));

  it("an overlay covering exactly the PREVIOUS release's manifest is fully covered under today's door", () => {
    const r = validateOverlayCoverage(previousProjection());
    expect(r.uncovered).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it('every token added since the previous release completes from a previous-release projection, or is floored — named per token', () => {
    const added = consumedTokenManifest.filter((t) => !previous.has(t)).sort();
    // The growth this fixture knows about. A new token is a DECISION: add it here AND give it a
    // completion rule (or a floor entry), or the next test names it as the N−1 break it is.
    expect(added).toEqual([
      '--ggui-motion-duration-base',
      '--ggui-motion-duration-fast',
      '--ggui-motion-duration-slow',
      '--ggui-motion-easing-emphasized',
      '--ggui-motion-easing-exit',
      '--ggui-motion-easing-standard',
      // ggui#1083 — the scrim pair: `tint` completes from the overlay's own ground, `opacity`
      // is ladder-covered (a constant every projection declares).
      '--ggui-scrim-opacity',
      '--ggui-scrim-tint',
      '--ggui-shape-radius-control',
    ]);
    const completed = completeThemeVariables(previousProjection(), 'light');
    const floor = new Set(NON_THEME_DEFINABLE_TOKENS);
    // ggui#1106 — the third mechanism: a name the :root ladder always declares, which an overlay
    // may omit (the card keeps the shipped tempo) and a document may still state.
    const ladderCovered = new Set(LADDER_COVERED_TOKENS);
    const gaps = added.filter((t) => completed[t] === undefined && !floor.has(t) && !ladderCovered.has(t));
    expect(gaps).toEqual([]);
  });

  it('ladder-covered names: omitted ⇒ never uncovered; stated ⇒ never unknown (ggui#1106)', () => {
    const omitted = validateOverlayCoverage(previousProjection());
    expect(omitted.uncovered.filter((t) => t.startsWith('--ggui-motion-'))).toEqual([]);
    const stated = validateOverlayCoverage({ ...previousProjection(), '--ggui-motion-duration-base': '160ms' });
    expect(stated.unknown).toEqual([]);
    expect(stated.uncovered).toEqual([]);
  });
});
