/**
 * Pins the resolution map for the corner-radius scale. Card, Box and
 * Image all route their `radius` prop through `resolveRadius` so a
 * mistake here would silently propagate everywhere.
 *
 * Regression guard: before this module, `Box` / `Image` typed the
 * concept as `borderRadius?: number | string` with raw passthrough —
 * `borderRadius="lg"` emitted the invalid CSS `border-radius: lg`,
 * dropped by the browser. The scale names now resolve to
 * `--ggui-shape-radius-*` tokens.
 */
import { describe, it, expect } from 'vitest';
import { resolveRadius, type RadiusScale } from '../radius-scale';

describe('resolveRadius', () => {
  it.each([
    ['none', '0'],
    ['sm', 'var(--ggui-shape-radius-sm, 4px)'],
    ['md', 'var(--ggui-shape-radius-md, 8px)'],
    ['lg', 'var(--ggui-shape-radius-lg, 12px)'],
    ['xl', 'var(--ggui-shape-radius-xl, 16px)'],
  ] as readonly [RadiusScale, string][])(
    'scale "%s" → "%s"',
    (name, expected) => {
      expect(resolveRadius(name)).toBe(expected);
    },
  );

  it('every scale name except "none" resolves to a var(--ggui-shape-radius-*) token', () => {
    for (const name of ['sm', 'md', 'lg', 'xl'] as RadiusScale[]) {
      const css = resolveRadius(name);
      expect(
        css?.startsWith('var(--ggui-shape-radius-'),
        `scale "${name}" emitted "${css}" — must be var(--ggui-shape-radius-*)`,
      ).toBe(true);
    }
  });

  it('a number is treated as pixels', () => {
    expect(resolveRadius(0)).toBe('0px');
    expect(resolveRadius(12)).toBe('12px');
  });

  it('an arbitrary CSS string is passed through verbatim (escape hatch)', () => {
    expect(resolveRadius('50%')).toBe('50%');
    expect(resolveRadius('var(--ggui-shape-radius-full)')).toBe('var(--ggui-shape-radius-full)');
  });

  it('undefined stays undefined — no declaration emitted', () => {
    expect(resolveRadius(undefined)).toBeUndefined();
  });

  it('a scale name never leaks through as an invalid raw CSS value', () => {
    // The whole point: `radius="lg"` must NOT become `border-radius: lg`.
    for (const name of ['sm', 'md', 'lg', 'xl'] as RadiusScale[]) {
      expect(resolveRadius(name)).not.toBe(name);
    }
  });
});
