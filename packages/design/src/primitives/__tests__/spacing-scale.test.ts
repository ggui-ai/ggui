/**
 * Pins the resolution map for the spacing scale. Every layout
 * primitive that exposes a `gap` / `padding` / `margin` prop (Stack,
 * Row, Card, Box, Container) routes through `resolveSpacing` so a
 * mistake here would silently propagate everywhere.
 *
 * Regression guard: before this module, `gap` / `padding` were raw
 * `number | string` passthrough — `gap="sm"` emitted the invalid CSS
 * `gap: sm`, which the browser drops, collapsing the gap to `0`. The
 * scale names now resolve to `--ggui-spacing-*` tokens, exactly the
 * way `shadow` / `radius` resolve on Card.
 */
import { describe, it, expect } from 'vitest';
import { resolveSpacing, type SpacingScale } from '../spacing-scale';

describe('resolveSpacing', () => {
  it.each([
    ['none', '0'],
    ['xs', 'var(--ggui-spacing-xs, 4px)'],
    ['sm', 'var(--ggui-spacing-sm, 8px)'],
    ['md', 'var(--ggui-spacing-md, 16px)'],
    ['lg', 'var(--ggui-spacing-lg, 24px)'],
    ['xl', 'var(--ggui-spacing-xl, 32px)'],
    ['2xl', 'var(--ggui-spacing-2xl, 48px)'],
  ] as readonly [SpacingScale, string][])(
    'scale "%s" → "%s"',
    (name, expected) => {
      expect(resolveSpacing(name)).toBe(expected);
    },
  );

  it('every scale name except "none" resolves to a var(--ggui-spacing-*) token', () => {
    const names: SpacingScale[] = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];
    for (const name of names) {
      const css = resolveSpacing(name);
      expect(
        css?.startsWith('var(--ggui-spacing-'),
        `scale "${name}" emitted "${css}" — must be var(--ggui-spacing-*)`,
      ).toBe(true);
    }
  });

  it('a number is treated as pixels', () => {
    expect(resolveSpacing(0)).toBe('0px');
    expect(resolveSpacing(12)).toBe('12px');
  });

  it('an arbitrary CSS string is passed through verbatim (escape hatch)', () => {
    expect(resolveSpacing('var(--ggui-spacing-4)')).toBe('var(--ggui-spacing-4)');
    expect(resolveSpacing('1rem')).toBe('1rem');
    expect(resolveSpacing('clamp(8px, 2vw, 24px)')).toBe('clamp(8px, 2vw, 24px)');
  });

  it('undefined stays undefined — no declaration emitted', () => {
    expect(resolveSpacing(undefined)).toBeUndefined();
  });

  it('a scale name never leaks through as an invalid raw CSS value', () => {
    // The whole point: `gap="sm"` must NOT become `gap: sm`.
    for (const name of ['xs', 'sm', 'md', 'lg', 'xl', '2xl'] as SpacingScale[]) {
      expect(resolveSpacing(name)).not.toBe(name);
    }
  });
});
