/**
 * ggui#1567 — every shipped theme's muted ink (`onSunken`, which the `muted` and `subtle` tones both resolve to)
 * clears WCAG AA (4.5:1) as text on both grounds it sits on, `container` and `sunken`, in both schemes. Hint text
 * is still text: a theme whose muted ink falls under AA on its own ground ships unreadable labels in every card
 * that uses the tone. Every registered theme is read from the registry, so a new theme is covered the day it lands.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio, deriveThemeVariables } from './derive-theme-variables';
import { getRawTheme, getThemeIds } from './registry';
import { lightTheme } from './defaults/light';
import { darkTheme } from './defaults/dark';
import type { DtcgTheme } from './types';

const AA = 4.5;

const cases: Array<[string, DtcgTheme, 'light' | 'dark']> = [
  ['defaults light', lightTheme, 'light'],
  ['defaults dark', darkTheme, 'dark'],
];
for (const id of getThemeIds()) {
  for (const mode of ['light', 'dark'] as const) {
    const doc = getRawTheme(id, mode);
    if (doc !== undefined) cases.push([`${id} ${mode}`, doc, mode]);
  }
}

describe('every shipped theme: the muted ink is readable text on both grounds (ggui#1567)', () => {
  it('covers the registry and the defaults (a control: the list is not empty)', () => {
    expect(getThemeIds().length).toBeGreaterThan(0);
    expect(cases.length).toBeGreaterThanOrEqual(4);
  });

  it.each(cases)('%s: onSunken clears 4.5:1 on container and on sunken', (_label, doc, mode) => {
    const v = deriveThemeVariables(doc, mode);
    const ink = v['--ggui-color-onSunken'];
    expect(ink).toBeDefined();
    expect(contrastRatio(ink!, v['--ggui-color-container']!)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(ink!, v['--ggui-color-sunken']!)).toBeGreaterThanOrEqual(AA);
  });
});
