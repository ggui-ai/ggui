import type { CSSProperties } from 'react';
import type { BoxProps } from './types';
import { renderWithTrait, type WithTrait } from '../interact/trait';
import { resolveSurfaceCss, resolveSurfaceOnColorCss, resolveSurfaceScope, resolveTintCss, TINT_ON_COLOR_CSS, withoutBackground } from './color-slots';
import { resolveSpacing } from './spacing-scale';
import { resolveRadius } from './radius-scale';

/**
 * Box — A generic container primitive with padding, margin, and
 * background options.
 *
 * Trait composition via `as` — make a box interactive without changing
 * the JSX tree: `<Box as={Clickable} onClick={handler}>content</Box>`.
 * A bare `<Box>` exposes only `BoxProps`; reach for `as={Clickable}`
 * for interaction (it carries the keyboard + ARIA wiring).
 */
export function Box(props: WithTrait<BoxProps>) {
  const {
    children,
    padding,
    paddingX,
    paddingY,
    margin,
    surface,
    tint,
    assetColor,
    assetSemantic,
    radius,
    style,
    className,
    bleed,
    as: Trait,
    ...traitProps
  } = props;
  // ggui#1083 — a Box with a painted surface IS a surface; `bleed` may ride any Box.
  // A tinted Box (ggui#1847) is a painted surface too, marked with its step.
  const markedSurface = tint !== undefined ? tint : surface !== undefined && surface !== 'transparent' ? surface : undefined;
  const frame =
    markedSurface === undefined && bleed !== true
      ? undefined
      : { ...(markedSurface !== undefined ? { surface: markedSurface } : {}), ...(bleed === true ? { bleed: true } : {}) };

  // ggui#1765 — one horizontal inset per card. `padding` / `paddingY` set this box's VERTICAL rhythm; the inline
  // axis is the card's: a visible surface (a fill or a tint) insets its content by `--ggui-card-inset`, and an
  // unboxed Box adds no inline inset at all (its content keeps the edge of the content around it). `paddingX` no
  // longer moves the inline axis. A Box with no padding at all stays flush, as before.
  const blockPadding = resolveSpacing(paddingY ?? padding);
  const padded = [padding, paddingX, paddingY].some((p) => p !== undefined && p !== 'none');
  const computedPadding: string | undefined = padded
    ? `${blockPadding || '0'} ${markedSurface !== undefined ? 'var(--ggui-card-inset, var(--ggui-spacing-lg))' : '0'}`
    : resolveSpacing(padding);

  // `surface` (typed slot) is the theme-tracking path; `assetColor`
  // (paired with a non-empty `assetSemantic`) is the typed escape for
  // legitimate non-theme brand colors. `assetColor` wins when both are
  // set. Absence of both = transparent (no fill). Runtime guard: an
  // `assetColor` without a non-empty `assetSemantic` is treated as
  // undefined so the static tier-0 self-check and the runtime align.
  const validAsset =
    assetColor !== undefined &&
    typeof assetSemantic === 'string' &&
    assetSemantic.length > 0
      ? assetColor
      : undefined;
  // A categorical `tint` (ggui#1847) is the fill when no asset colour is, and
  // it replaces `surface`'s fill, ink and scope: a tinted Box reads the
  // theme's ink, which the derivation keeps at ≥ 4.5:1 on every tint.
  const tinted = !validAsset && tint !== undefined;
  const resolvedBackground = validAsset
    ? validAsset
    : tint !== undefined
      ? resolveTintCss(tint)
      : surface
        ? resolveSurfaceCss(surface)
        : undefined;

  // The surface owns its on-colour (ggui#1019): an `inverted` surface sets
  // the `inverse` ink on its root; an asset fill keeps the page ink.
  const resolvedOnColor = tinted ? TINT_ON_COLOR_CSS : !validAsset && surface ? resolveSurfaceOnColorCss(surface) : undefined;

  // An inverted surface owns ALL its on-colours (ggui#1024) — see Card.
  const scope = !validAsset && !tinted && surface ? resolveSurfaceScope(surface) : undefined;
  // A scoped surface owns its ground too — the author's style may not repaint it (see Card).
  const authorStyle = scope !== undefined ? withoutBackground(style) : style;

  const composedStyle: CSSProperties = {
    padding: computedPadding,
    margin: resolveSpacing(margin),
    background: resolvedBackground,
    ...(resolvedOnColor !== undefined ? { color: resolvedOnColor } : {}),
    borderRadius: resolveRadius(radius),
    ...authorStyle,
  };
  if (scope !== undefined) {
    return renderWithTrait(
      Trait,
      traitProps,
      {
        className: className ? `${className} ${scope.className}` : scope.className,
        style: composedStyle,
        ...(frame !== undefined ? { frame } : {}),
      },
      <>
        <style>{scope.css}</style>
        {children}
      </>,
    );
  }

  return renderWithTrait(
    Trait,
    traitProps,
    { className, style: composedStyle, ...(frame !== undefined ? { frame } : {}) },
    children,
  );
}
