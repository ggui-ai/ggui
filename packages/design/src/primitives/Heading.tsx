import { createElement, type ReactElement } from 'react';
import type { HeadingProps } from './types';
import { headingStyles } from '../tokens/typography';
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
  const headingStyle = headingStyles[tag] || headingStyles.h2;

  const resolvedColor = tone
    ? resolveToneCss(tone)
    : 'var(--ggui-color-onSurface, #18181b)';

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
