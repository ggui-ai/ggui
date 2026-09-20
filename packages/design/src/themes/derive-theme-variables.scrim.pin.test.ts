/**
 * Pin (ggui#1083): the scrim between the host page's ground and the card
 * reaches the card's OWN pages through two variables — `--ggui-scrim-tint`
 * and `--ggui-scrim-opacity` — ALWAYS emitted: absent a stated `scrim` they
 * carry the mode's ground at 0.45 (the embedding shell's own defaults, so the
 * judge's page and the widget sit the card on one scrim); a stated
 * `scrim.tone` (`light` / `dark` → `#ffffff` / `#000000`, the words the shell
 * maps the same way; a colour token verbatim) and `scrim.opacity` project
 * onto them. `scrim.blur` is NEVER projected: it needs a host page behind it,
 * which only the embedding shell has, and a name nothing in the card reads is
 * a dead key the write door refuses. An overlay from a composer that predates
 * the two names completes at the door (N−1). RED before the projection
 * existed, GREEN after.
 */
import { describe, expect, it } from 'vitest';
import { completeThemeVariables, deriveThemeVariables } from './derive-theme-variables.js';
import { LADDER_COVERED_TOKENS, validateOverlayCoverage } from './validate-overlay-coverage.js';
import { lightTheme } from './defaults/light.js';
import { darkTheme } from './defaults/dark.js';
import type { DtcgTheme } from './types.js';

const TINT = '--ggui-scrim-tint';
const OPACITY = '--ggui-scrim-opacity';
const BLUR = { $type: 'dimension', $value: '20px' } as const;

function withScrim(doc: DtcgTheme, scrim: NonNullable<DtcgTheme['scrim']>): DtcgTheme {
  return { ...doc, scrim };
}

describe('the scrim reaches the card — ggui#1083', () => {
  it('absent: tint is the mode ground and opacity 0.45, in both modes', () => {
    for (const [doc, mode] of [[lightTheme, 'light'], [darkTheme, 'dark']] as const) {
      const v = deriveThemeVariables(doc, mode);
      expect(v[TINT]).toBe(v['--ggui-color-ground']);
      expect(v[OPACITY]).toBe('0.45');
    }
  });

  it('stated: the tone words map as the embedding shell maps them, a colour token is verbatim, opacity verbatim', () => {
    const dark = deriveThemeVariables(withScrim(lightTheme, { tone: 'dark', opacity: { $type: 'number', $value: 0.3 }, blur: BLUR }), 'light');
    expect(dark[TINT]).toBe('#000000');
    expect(dark[OPACITY]).toBe('0.3');
    const light = deriveThemeVariables(withScrim(darkTheme, { tone: 'light', opacity: { $type: 'number', $value: 0.6 }, blur: BLUR }), 'dark');
    expect(light[TINT]).toBe('#ffffff');
    expect(light[OPACITY]).toBe('0.6');
    const colour = deriveThemeVariables(withScrim(lightTheme, { tone: { $type: 'color', $value: '#ABCDEF' }, opacity: { $type: 'number', $value: 1 }, blur: BLUR }), 'light');
    expect(colour[TINT]).toBe('#abcdef');
    expect(colour[OPACITY]).toBe('1');
  });

  it('blur is never projected — the two names are the whole scrim family', () => {
    const v = deriveThemeVariables(withScrim(lightTheme, { tone: 'dark', opacity: { $type: 'number', $value: 0.5 }, blur: BLUR }), 'light');
    expect(Object.keys(v).filter((k) => k.startsWith('--ggui-scrim-')).sort()).toEqual([OPACITY, TINT]);
  });

  it('an overlay that predates the two names is not refused (N−1): tint completes from its own ground, opacity is the ladder\'s', () => {
    const v = deriveThemeVariables(lightTheme, 'light');
    const older: Record<string, string> = { ...v };
    delete older[TINT];
    delete older[OPACITY];
    const completed = completeThemeVariables(older, 'light');
    expect(completed[TINT]).toBe(v['--ggui-color-ground']);
    expect(completed[OPACITY]).toBeUndefined();
    expect(LADDER_COVERED_TOKENS).toContain(OPACITY);
    expect(LADDER_COVERED_TOKENS).not.toContain(TINT);
    const report = validateOverlayCoverage(older);
    expect(report.uncovered).toEqual([]);
    expect(report.unknown).toEqual([]);
  });
});
