/**
 * ggui#1380 — a generation's runtime-probe repair record has exactly two
 * shapes, and the type says so. Either the repair turn's code did not pass
 * self-check (`compiled: false`, so no re-probe ran and there is no after
 * status), or it compiled, the re-probe ran, and `afterStatus` is that
 * re-probe's status. "Compiled with no after status" and "not compiled
 * with an after status" describe nothing the engine can produce, so a
 * reader narrowing on `compiled` must never have to handle them.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { GenerationRuntimeProbe, GenerationRuntimeProbeStatus } from './ui-generator.js';

type Repair = NonNullable<GenerationRuntimeProbe['repair']>;

describe('GenerationRuntimeProbe.repair (ggui#1380)', () => {
  it('is exactly the not-compiled arm or the compiled arm with its after status', () => {
    expectTypeOf<Repair>().toEqualTypeOf<
      | { readonly attempted: true; readonly compiled: false }
      | {
          readonly attempted: true;
          readonly compiled: true;
          readonly afterStatus: GenerationRuntimeProbeStatus;
        }
    >();
  });

  it('narrowing on `compiled` yields the after status with no optional check', () => {
    const repairs: readonly Repair[] = [
      { attempted: true, compiled: false },
      { attempted: true, compiled: true, afterStatus: 'ran' },
    ];
    const after = repairs.map((r) => (r.compiled ? r.afterStatus : 'no re-probe'));
    expect(after).toEqual(['no re-probe', 'ran']);
  });
});
