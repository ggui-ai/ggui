/**
 * Corner-radius scale that primitives expose as the typed `radius` prop.
 *
 * Companion to `spacing-scale.ts`. Before this module, `Card` resolved
 * `radius` via a local `radiusMap` while `Box` / `Image` typed the same
 * concept as `borderRadius?: number | string` with raw passthrough —
 * so `<Box borderRadius="lg">` emitted the invalid CSS `border-radius:
 * lg`, silently dropped by the browser. Two names, two types, one
 * concept.
 *
 * This module unifies it: every primitive uses one prop, `radius`,
 * resolved through {@link resolveRadius}. A {@link RadiusScale} name
 * maps to its `--ggui-shape-radius-*` token; a `number` is pixels; any
 * other string passes through unchanged (escape hatch).
 *
 * @public
 */

/**
 * The corner-radius t-shirt scale. Each name maps to a
 * `--ggui-shape-radius-*` token; fallbacks track the canonical
 * brand-kit radii.
 *
 * | name   | token                       | fallback |
 * | ------ | --------------------------- | -------- |
 * | `none` | —                           | `0`      |
 * | `sm`   | `--ggui-shape-radius-sm`    | `4px`    |
 * | `md`   | `--ggui-shape-radius-md`    | `8px`    |
 * | `lg`   | `--ggui-shape-radius-lg`    | `12px`   |
 * | `xl`   | `--ggui-shape-radius-xl`    | `16px`   |
 *
 * @public
 */
export type RadiusScale = 'none' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * A radius prop value: a {@link RadiusScale} name (preferred), a
 * `number` of pixels, or an arbitrary CSS length string (escape hatch).
 *
 * @public
 */
export type RadiusValue = RadiusScale | number | string;

const RADIUS_SCALE_TOKEN: Readonly<Record<RadiusScale, string>> = {
  none: '0',
  sm: 'var(--ggui-shape-radius-sm, 4px)',
  md: 'var(--ggui-shape-radius-md, 8px)',
  lg: 'var(--ggui-shape-radius-lg, 12px)',
  xl: 'var(--ggui-shape-radius-xl, 16px)',
};

const RADIUS_SCALE_NAMES: ReadonlySet<string> = new Set(
  Object.keys(RADIUS_SCALE_TOKEN),
);

/**
 * Resolve a radius prop value to a CSS length expression.
 *
 * - a {@link RadiusScale} name → `var(--ggui-shape-radius-NAME, fallback)`
 * - a `number` → `${n}px`
 * - any other string → passed through verbatim (escape hatch)
 * - `undefined` → `undefined` (no declaration emitted)
 *
 * @public
 */
export function resolveRadius(value: RadiusValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return `${value}px`;
  return RADIUS_SCALE_NAMES.has(value)
    ? RADIUS_SCALE_TOKEN[value as RadiusScale]
    : value;
}
