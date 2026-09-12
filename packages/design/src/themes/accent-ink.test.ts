/**
 * Pin (ggui#1035, the #1019 / #1024 / #1034 family): accent TEXT is a readable
 * ink derived per mode, never a bare ladder stop. RED fixture — the registry
 * audit of 2026-09-12: with `link` falling back to `primary-600` and `loud`
 * painting `primary-500`, four themes' light mode failed AA on their own
 * container (link: claudic 3.85, premium-neon-noir 4.33, premium-botanical
 * 3.22, guuey-brand-v1 2.55; loud: claudic 3.11, premium-zen 3.75,
 * premium-botanical 2.22, guuey-brand-v1 1.60). Every served page composes
 * its theme CSS at render, so the fix heals without a re-mint.
 */
import { describe, expect, it } from 'vitest';
import { getThemeIds, getRawTheme } from './registry';
import { contrastRatio, deriveThemeVariables } from './derive-theme-variables';
import { resolveToneCss } from '../primitives/color-slots';

const MODES = ['light', 'dark'] as const;

describe('accent ink reads on its surface (ggui#1035)', () => {
  for (const id of getThemeIds()) {
    for (const mode of MODES) {
      it(`${id} ${mode}: link ≥ 4.5:1 on container and on ground; emphasized (primary-700) ≥ 4.5:1 on container`, () => {
        const v = deriveThemeVariables(getRawTheme(id, mode)!, mode);
        const link = v['--ggui-color-link']!;
        const container = v['--ggui-color-container']!;
        const ground = v['--ggui-color-ground']!;
        expect(contrastRatio(link, container), `${id} ${mode} link on container`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(link, ground), `${id} ${mode} link on ground`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(v['--ggui-color-primary-700']!, container), `${id} ${mode} emphasized on container`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('`loud` resolves through the readable accent (`link`) with the 500 stop beneath it', () => {
    expect(resolveToneCss('loud')).toBe('var(--ggui-color-link, var(--ggui-color-primary-500, #0ea5e9))');
  });

  it('a stated `link` is honoured verbatim; an unstated one is the first primary stop that clears 4.5:1 on the container, else the on-colour', () => {
    const base = getRawTheme('guuey-brand-v1', 'light')!;
    const stated = deriveThemeVariables({ ...base, color: { ...base.color, link: { $type: 'color', $value: '#123456' } } }, 'light');
    expect(stated['--ggui-color-link']).toBe('#123456');
    const unstated = deriveThemeVariables(base, 'light');
    const walk = ['600', '700', '800', '900'].map((s) => unstated[`--ggui-color-primary-${s}`]!);
    const first = walk.find((hex) => contrastRatio(hex, unstated['--ggui-color-container']!) >= 4.5) ?? unstated['--ggui-color-onContainer'];
    expect(unstated['--ggui-color-link']).toBe(first);
    expect(unstated['--ggui-color-link']).not.toBe(unstated['--ggui-color-primary-600']); // 2.55:1 today — the RED
  });
});
