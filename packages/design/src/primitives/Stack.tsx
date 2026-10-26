import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { StackProps } from './types';
import { renderWithTrait, type WithTrait } from '../interact/trait';
import { resolveSpacing } from './spacing-scale';
import { applyRowCap } from './row-cap';

/** A layout effect in the browser, a plain effect where there is no layout (server render): no SSR warning. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

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
    maxRows,
    style,
    className,
    as: Trait,
    ...traitProps
  } = props;

  const resolvedGap = resolveSpacing(gap);

  // ggui#2010 — the row cap: measure the group's own rows after every render and on every width change, and hide
  // the children from the first whose rows would end past `maxRows` (the end rule). Only a wrapping horizontal group is capped.
  const groupRef = useRef<HTMLDivElement>(null);
  const capped = maxRows !== undefined && wrap && direction === 'horizontal';
  useIsomorphicLayoutEffect(() => {
    const group = groupRef.current;
    if (!capped || group === null || maxRows === undefined) return;
    applyRowCap(group, maxRows);
    if (typeof ResizeObserver === 'undefined') return;
    let width = group.getBoundingClientRect().width;
    let frame = 0;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next === undefined || next === width) return;
      width = next;
      // Re-packing changes the group's height inside the observer's own callback, which the browser reports as an
      // undelivered-notifications loop. The re-pack stays synchronous (no frame shows a half-packed group); only
      // the observation pauses, and resumes on the next frame, where the unchanged width returns early.
      observer.unobserve(group);
      applyRowCap(group, maxRows);
      frame = requestAnimationFrame(() => observer.observe(group));
    });
    observer.observe(group);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  });

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
    { className, style: composedStyle, ...(capped ? { ref: groupRef } : {}) },
    children,
  );
}
