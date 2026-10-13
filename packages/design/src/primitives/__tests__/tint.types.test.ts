/**
 * ggui#1847 — the `tint` prop's union is spelled out on BoxProps and CardProps
 * so the generated reference shows the eight names. This pins it to
 * `TintStep`, the type derived from `TINT_STEPS`, so the two can never drift.
 * Compile-time only.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type { BoxProps, CardProps } from '../types';
import type { TintStep } from '../color-slots';

describe('tint prop type equals TintStep (ggui#1847)', () => {
  it('Box and Card', () => {
    expectTypeOf<NonNullable<BoxProps['tint']>>().toEqualTypeOf<TintStep>();
    expectTypeOf<NonNullable<CardProps['tint']>>().toEqualTypeOf<TintStep>();
  });
});
