import { createElement, type CSSProperties, type ReactElement } from 'react';
import type { TextProps } from './types';
import { textStyles } from '../tokens/typography';
import { resolveToneCss } from './color-slots';

const sizeMap: Record<string, string> = {
  xs: 'var(--ggui-font-size-xs, 12px)',
  sm: 'var(--ggui-font-size-sm, 14px)',
  base: 'var(--ggui-font-size-base, 16px)',
  lg: 'var(--ggui-font-size-lg, 18px)',
  xl: 'var(--ggui-font-size-xl, 20px)',
  '2xl': 'var(--ggui-font-size-2xl, 24px)',
  '3xl': 'var(--ggui-font-size-3xl, 30px)',
  '4xl': 'var(--ggui-font-size-4xl, 36px)',
};

const weightMap: Record<string, string> = {
  normal: 'var(--ggui-font-weight-normal, 400)',
  medium: 'var(--ggui-font-weight-medium, 500)',
  semibold: 'var(--ggui-font-weight-semibold, 600)',
  bold: 'var(--ggui-font-weight-bold, 700)',
};

/**
 * Text — A versatile typography primitive for body text, captions, and
 * labels.
 *
 * Text is a *content* primitive: its root is a semantic element
 * (`<p>` / `<span>` / `<div>` / `<label>`, chosen by `is`), not a
 * generic `<div>`. It is therefore deliberately NOT a trait host — it
 * takes no `as={Trait}`. Clickable text is a semantic concern: reach
 * for `Link`, or wrap the Text in a structural trait host
 * (`<Box as={Clickable}>…`). See `../interact/trait`.
 */
export function Text({
  children,
  variant = 'body',
  size,
  weight,
  tone,
  align,
  truncate,
  is = 'p',
  id,
  htmlFor,
  style,
  className,
}: TextProps): ReactElement {
  const variantStyle = textStyles[variant] || textStyles.body;

  // `tone` is the only color-control prop — there is no raw `color`
  // escape; all color flows through theme tokens.
  const resolvedColor = tone
    ? resolveToneCss(tone)
    : 'var(--ggui-color-onSurface, #18181b)';

  const textStyle = {
    ...variantStyle,
    fontSize: size ? sizeMap[size] || size : undefined,
    fontWeight: weight ? weightMap[weight] : undefined,
    color: resolvedColor,
    textAlign: align,
    margin: 0,
    ...(truncate && {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }),
    ...style,
  };

  // `htmlFor` is meaningful only on `is="label"`; React renders it as
  // the `for` attribute and omits it (like `id`) when undefined.
  const elementProps: {
    id?: string;
    htmlFor?: string;
    className?: string;
    style: CSSProperties;
  } = { id, htmlFor, className, style: textStyle };

  return createElement(is, elementProps, children);
}
