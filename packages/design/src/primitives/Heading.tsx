import { createElement, type ReactElement } from 'react';
import type { HeadingProps } from './types';
import { headingStyles } from '../tokens/typography';

const HEADING_SIZE = {
  h1: 'var(--ggui-font-size-4xl, 36px)',
  h2: 'var(--ggui-font-size-3xl, 30px)',
  h3: 'var(--ggui-font-size-2xl, 24px)',
  h4: 'var(--ggui-font-size-xl, 20px)',
  h5: 'var(--ggui-font-size-lg, 18px)',
  h6: 'var(--ggui-font-size-base, 16px)',
} as const;
import { resolveToneCss } from './color-slots';

/**
 * Heading - Semantic heading elements (h1-h6) with preset styles
 */
export function Heading({
  children,
  level = 2,
  tone,
  align,
  style,
  className,
}: HeadingProps): ReactElement {
  const tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  // ggui#987 §2.2: the stops are the ramp's, not literals — h1 → 4xl … h6 → base —
  // with the heading family and weight; the layer-1 constants stay the fallback.
  // Static reads on purpose: the consumed-token manifest is derived by scan.
  const fallback = headingStyles[tag] || headingStyles.h2;
  const headingStyle = {
    fontSize: HEADING_SIZE[tag],
    fontWeight: `var(--ggui-font-weight-heading, ${fallback.fontWeight})`,
    fontFamily: 'var(--ggui-font-family-heading, var(--ggui-font-family-sans, inherit))',
    lineHeight: fallback.lineHeight,
    letterSpacing: `var(--ggui-letter-spacing-heading, ${fallback.letterSpacing})`,
  };

  const resolvedColor = tone
    ? resolveToneCss(tone)
    : 'var(--ggui-color-onContainer, #18181b)';

  return createElement(
    tag,
    {
      className,
      style: {
        ...headingStyle,
        color: resolvedColor,
        textAlign: align,
        margin: 0,
        ...style,
      },
    },
    children
  );
}
