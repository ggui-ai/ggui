import type { CSSProperties } from 'react';
import type { StackProps } from './types';
import { renderWithTrait, type WithTrait } from '../interact/trait';
import { resolveSpacing } from './spacing-scale';

const justifyMap: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
  evenly: 'space-evenly',
};

const alignMap: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};

/**
 * Stack — A flexible layout primitive for arranging items vertically
 * or horizontally.
 *
 * Trait composition via `as` — make a stack interactive without
 * changing the JSX tree: `<Stack as={Clickable} onClick={handler}>`.
 * A bare `<Stack>` exposes only `StackProps`; reach for `as={Clickable}`
 * for interaction (it carries the keyboard + ARIA wiring).
 */
export function Stack(props: WithTrait<StackProps>) {
  const {
    children,
    direction = 'vertical',
    gap = 'sm',
    align = 'stretch',
    justify = 'start',
    wrap = false,
    style,
    className,
    as: Trait,
    ...traitProps
  } = props;

  const resolvedGap = resolveSpacing(gap);

  const composedStyle: CSSProperties = {
    display: 'flex',
    flexDirection: direction === 'vertical' ? 'column' : 'row',
    gap: resolvedGap,
    alignItems: alignMap[align] || align,
    justifyContent: justifyMap[justify] || justify,
    flexWrap: wrap ? 'wrap' : 'nowrap',
    ...style,
  };

  return renderWithTrait(
    Trait,
    traitProps,
    { className, style: composedStyle },
    children,
  );
}
