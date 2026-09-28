/**
 * Pin (ggui#1494): the boundary an interactive control draws identifies the control, so WCAG 1.4.11
 * asks it ≥ 3:1 against the surface it sits on. RED fixture — the registry read of 2026-09-28: the
 * decorative `outline` the field-type primitives drew read 1.20–2.07:1 on the container in all 16
 * stock derivations (guuey-brand-v1 states it as an rgba hairline), and Button's outline variant drew
 * `primary-600`, 2.55:1 on guuey-brand-v1 light. `outline` / `outlineVariant` keep their values — they
 * stay the decorative hairlines — and two new derived keys carry the control edge:
 * `controlOutline` (neutral, the outline walk on the container) and `controlAccentOutline` (the first
 * primary stop ≥ 3:1 on the container, the accent walk at the non-text floor).
 */
import { describe, expect, it } from 'vitest';
import { getThemeIds, getRawTheme } from './registry';
import { completeThemeVariables, contrastRatio, deriveThemeVariables } from './derive-theme-variables';
import { HERO_SCOPE_CSS, INVERTED_SCOPE_CSS } from '../primitives/color-slots';

const MODES = ['light', 'dark'] as const;
const CONTROL_KEYS = ['--ggui-color-controlOutline', '--ggui-color-controlAccentOutline'] as const;

describe('a control\'s boundary clears 3:1 on its container (ggui#1494)', () => {
  for (const id of getThemeIds()) {
    for (const mode of MODES) {
      it(`${id} ${mode}: controlOutline and controlAccentOutline ≥ 3:1 on the container`, () => {
        const v = deriveThemeVariables(getRawTheme(id, mode)!, mode);
        const container = v['--ggui-color-container']!;
        expect(contrastRatio(v['--ggui-color-controlOutline']!, container), `${id} ${mode} controlOutline`).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(v['--ggui-color-controlAccentOutline']!, container), `${id} ${mode} controlAccentOutline`).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it('the brand edge is the first primary stop that clears 3:1 on the container — the RED theme moves off primary-600, the rest keep it', () => {
    const red = deriveThemeVariables(getRawTheme('guuey-brand-v1', 'light')!, 'light');
    const container = red['--ggui-color-container']!;
    expect(contrastRatio(red['--ggui-color-primary-600']!, container)).toBeLessThan(3); // 2.55:1 — the RED
    const walk = ['600', '700', '800', '900'].map((s) => red[`--ggui-color-primary-${s}`]!);
    expect(red['--ggui-color-controlAccentOutline']).toBe(walk.find((hex) => contrastRatio(hex, container) >= 3));
    const kept = deriveThemeVariables(getRawTheme('ggui', 'light')!, 'light');
    expect(kept['--ggui-color-controlAccentOutline']).toBe(kept['--ggui-color-primary-600']);
  });

  it('the decorative outlines keep their values — the control edge is a new key beside them', () => {
    // Every key that existed before is byte-identical: the ggui#1495 digest pin re-reads all 16 stock
    // derivations with only the two new keys left out.
    const v = deriveThemeVariables(getRawTheme('ggui', 'light')!, 'light');
    expect(v['--ggui-color-controlOutline']).not.toBe(v['--ggui-color-outline']);
    expect(contrastRatio(v['--ggui-color-outline']!, v['--ggui-color-container']!)).toBeLessThan(3); // the hairline, by design
  });
});

describe('a stored projection predates the keys: completion fills them at read (ggui#1494)', () => {
  for (const id of getThemeIds()) {
    for (const mode of MODES) {
      it(`${id} ${mode}: a projection without the control keys completes to the derivation's values; its stated outline is untouched`, () => {
        const full = deriveThemeVariables(getRawTheme(id, mode)!, mode);
        const stored: Record<string, string> = { ...full };
        for (const k of CONTROL_KEYS) delete stored[k];
        const completed = completeThemeVariables(stored, mode);
        for (const k of CONTROL_KEYS) expect(completed[k], `${id} ${mode} ${k}`).toBe(full[k]);
        expect(completed['--ggui-color-outline']).toBe(full['--ggui-color-outline']);
      });
    }
  }

  it('a stated control edge is honoured verbatim', () => {
    const full = deriveThemeVariables(getRawTheme('ggui', 'light')!, 'light');
    const completed = completeThemeVariables({ ...full, '--ggui-color-controlOutline': '#123456' }, 'light');
    expect(completed['--ggui-color-controlOutline']).toBe('#123456');
  });
});

describe('a scoped surface re-declares the control edges for its own ground (ggui#1494)', () => {
  it.each([
    ['hero', HERO_SCOPE_CSS, 'heroOutline', 'heroLink'],
    ['inverted', INVERTED_SCOPE_CSS, 'inverseOutline', 'inverseLink'],
  ] as const)('%s: controlOutline is the scope\'s derived outline, controlAccentOutline its derived accent', (_name, css, outline, accent) => {
    expect(css).toContain(`--ggui-color-controlOutline:var(--ggui-color-${outline}, `);
    expect(css).toContain(`--ggui-color-controlAccentOutline:var(--ggui-color-${accent}, `);
  });
});
