import type { CSSProperties } from 'react';
import type { BoxProps } from './types';
import { renderWithTrait, type WithTrait } from '../interact/trait';
import { resolveSurfaceCss, resolveSurfaceOnColorCss, resolveSurfaceScope, withoutBackground } from './color-slots';
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
    assetColor,
    assetSemantic,
    radius,
    style,
    className,
    as: Trait,
    ...traitProps
  } = props;

  // Compute padding with paddingX/paddingY overrides. Each spacing
  // prop resolves a SpacingScale name to its `--ggui-spacing-*` token.
  let computedPadding: string | undefined;
  if (paddingX !== undefined || paddingY !== undefined) {
    const px = resolveSpacing(paddingX) || '0';
    const py = resolveSpacing(paddingY) || '0';
    computedPadding = `${py} ${px}`;
  } else {
    computedPadding = resolveSpacing(padding);
  }

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
  const resolvedBackground = validAsset
    ? validAsset
    : surface
      ? resolveSurfaceCss(surface)
      : undefined;

  // The surface owns its on-colour (ggui#1019): an `inverted` surface sets
  // the `inverse` ink on its root; an asset fill keeps the page ink.
  const resolvedOnColor = !validAsset && surface ? resolveSurfaceOnColorCss(surface) : undefined;

  // An inverted surface owns ALL its on-colours (ggui#1024) — see Card.
  const scope = !validAsset && surface ? resolveSurfaceScope(surface) : undefined;
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
    { className, style: composedStyle },
    children,
  );
}
