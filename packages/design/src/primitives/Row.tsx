import { createElement } from 'react';
import type { RowProps } from './types';
import type { WithTrait } from '../interact/trait';
import { Stack } from './Stack';

/**
 * Row — a horizontal Stack (shorthand for `Stack direction="horizontal"`).
 *
 * Forwards every prop — including a trait (`as={Clickable}`) and its
 * props — straight to Stack, which owns the layout + trait runtime.
 * `createElement` (not JSX) keeps the discriminated-union props of
 * `WithTrait` intact across the forward.
 */
export function Row(props: WithTrait<RowProps>) {
  return createElement(Stack, { ...props, direction: 'horizontal' });
}
