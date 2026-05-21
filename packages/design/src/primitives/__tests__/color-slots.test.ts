/**
 * Pins the resolution map for tone/surface semantic slots. Every
 * primitive that exposes a `tone` or `surface` prop (Text, Heading,
 * Divider, Icon, Link, Spinner; Box, Card) reads from this single
 * source so a mistake here would silently propagate everywhere.
 *
 * T-3 retired the legacy `color?: string` / `background?: string`
 * escapes — these slot resolvers are now the only path to set color
 * / surface on every typed primitive.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveToneCss,
  resolveSurfaceCss,
  type ToneSlot,
  type SurfaceSlot,
} from '../color-slots';

describe('resolveToneCss', () => {
  it.each([
    ['default', 'var(--ggui-color-onSurface, #18181b)'],
    ['muted', 'var(--ggui-color-onSurfaceVariant, #52525b)'],
    ['subtle', 'var(--ggui-color-neutral-500, #71717a)'],
    ['emphasized', 'var(--ggui-color-primary-700, #0369a1)'],
    ['loud', 'var(--ggui-color-primary-500, #0ea5e9)'],
    ['success', 'var(--ggui-color-success, #15803d)'],
    ['warning', 'var(--ggui-color-warning, #b45309)'],
    ['error', 'var(--ggui-color-error, #b91c1c)'],
    ['info', 'var(--ggui-color-info, #0e7490)'],
    ['inverse', 'var(--ggui-color-surface, #ffffff)'],
    ['inherit', 'inherit'],
  ] as readonly [ToneSlot, string][])(
    'tone "%s" → "%s"',
    (slot, expected) => {
      expect(resolveToneCss(slot)).toBe(expected);
    },
  );

  it('every slot emits either a var() reference OR the literal "inherit" — never raw hex', () => {
    const slots: ToneSlot[] = [
      'default', 'muted', 'subtle', 'emphasized', 'loud',
      'success', 'warning', 'error', 'info', 'inverse', 'inherit',
    ];
    for (const slot of slots) {
      const css = resolveToneCss(slot);
      const isVarRef = css.startsWith('var(--ggui-color-');
      const isInherit = css === 'inherit';
      expect(
        isVarRef || isInherit,
        `slot "${slot}" emitted "${css}" — must be var(--ggui-color-*) or "inherit"`,
      ).toBe(true);
    }
  });
});

describe('resolveSurfaceCss', () => {
  it.each([
    ['default', 'var(--ggui-color-surface, #ffffff)'],
    ['elevated', 'var(--ggui-color-surface, #ffffff)'],
    ['sunken', 'var(--ggui-color-surfaceVariant, #f4f4f5)'],
    ['accent', 'var(--ggui-color-primary-50, #f0f9ff)'],
    ['inverted', 'var(--ggui-color-onSurface, #18181b)'],
    ['transparent', 'transparent'],
  ] as readonly [SurfaceSlot, string][])(
    'surface "%s" → "%s"',
    (slot, expected) => {
      expect(resolveSurfaceCss(slot)).toBe(expected);
    },
  );

  it('default and elevated emit the same fill — elevated picks up shadow on Card, NOT a different bg', () => {
    expect(resolveSurfaceCss('default')).toBe(resolveSurfaceCss('elevated'));
  });

  it('every slot emits either a var() reference OR "transparent" — never raw hex', () => {
    const slots: SurfaceSlot[] = [
      'default', 'elevated', 'sunken', 'accent', 'inverted', 'transparent',
    ];
    for (const slot of slots) {
      const css = resolveSurfaceCss(slot);
      const isVarRef = css.startsWith('var(--ggui-color-');
      const isTransparent = css === 'transparent';
      expect(
        isVarRef || isTransparent,
        `slot "${slot}" emitted "${css}" — must be var(--ggui-color-*) or "transparent"`,
      ).toBe(true);
    }
  });
});
