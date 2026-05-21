import type { CSSProperties } from 'react';
import type { CardProps } from './types';
import { renderWithTrait, type WithTrait } from '../interact/trait';
import { resolveSurfaceCss } from './color-slots';
import { resolveSpacing } from './spacing-scale';
import { resolveRadius } from './radius-scale';

// Atmospheric shadow fallbacks: multi-layer with slate-tinted ambient for depth.
// Themed apps override via `--ggui-shape-shadow-*` from their DTCG theme; the
// fallback here is what un-themed iframes (e.g., LLM-generated previews
// without a theme injection) get, and it must look polished out of the box.
const shadowMap: Record<string, string> = {
  none: 'none',
  sm: 'var(--ggui-shape-shadow-sm, 0 1px 2px rgba(15, 23, 42, 0.04))',
  md: 'var(--ggui-shape-shadow-md, 0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 8px -2px rgba(15, 23, 42, 0.08))',
  lg: 'var(--ggui-shape-shadow-lg, 0 2px 4px rgba(15, 23, 42, 0.04), 0 12px 24px -6px rgba(15, 23, 42, 0.10))',
  xl: 'var(--ggui-shape-shadow-xl, 0 4px 8px rgba(15, 23, 42, 0.04), 0 20px 40px -8px rgba(15, 23, 42, 0.14))',
};

/**
 * Card — A container with background, shadow, and border.
 *
 * Trait composition via `as` — make a card interactive without
 * changing the JSX tree:
 *
 *   <Card as={Clickable} onClick={handler} shadow="md">…</Card>
 *
 * A bare `<Card>` exposes only `CardProps` — a raw `onClick` is a type
 * error; reach for `as={Clickable}` (which also carries the keyboard +
 * ARIA wiring). See `../interact/trait`.
 */
export function Card(props: WithTrait<CardProps>) {
  const {
    children,
    // Default padding is the `lg` spacing token (24px) — 16px reads
    // cramped against modern card layouts; the theme can override
    // per-app via `--ggui-spacing-lg`.
    padding = 'lg',
    shadow = 'sm',
    border = true,
    radius = 'lg',
    surface,
    style,
    className,
    as: Trait,
    ...traitProps
  } = props;

  const resolvedPadding = resolveSpacing(padding);

  // `surface` (typed slot) lets the LLM pick the variant family —
  // 'inverted' for testimonial-style dark cards on a light theme,
  // 'accent' for branded fills, etc. Default = 'default' = the theme's
  // `--ggui-color-surface`.
  const resolvedSurface = resolveSurfaceCss(surface ?? 'default');

  const composedStyle: CSSProperties = {
    backgroundColor: resolvedSurface,
    borderRadius: resolveRadius(radius),
    padding: resolvedPadding,
    boxShadow: shadowMap[shadow] || shadow,
    border: border
      ? '1px solid var(--ggui-color-outlineVariant, #e4e4e7)'
      : undefined,
    ...style,
  };

  return renderWithTrait(
    Trait,
    traitProps,
    { className, style: composedStyle },
    children,
  );
}
