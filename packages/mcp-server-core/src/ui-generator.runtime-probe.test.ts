/**
 * ggui#1380 — a generation's runtime-probe record is a union the engine
 * can populate exactly, and the type refuses every other shape. `ran`
 * always carries a verdict; a `fail` verdict carries the checks that failed
 * (never an empty list); a status that produced no verdict (`timed-out`,
 * `infra-skipped`, `not-applicable`) carries none; and the repair record is
 * either the not-compiled arm (no re-probe, so no after) or the compiled arm
 * with the re-probe's own outcome. "Ran with no verdict", "timed out with a
 * verdict", "compiled with no after" and "not compiled with an after"
 * describe nothing the engine produces, so a reader narrowing on `status`,
 * `verdict` or `compiled` never has to handle them. Pinned without
 * `@ts-expect-error`: the exact unions by `toEqualTypeOf`, the refused shapes
 * by `.not.toMatchTypeOf` (assignability, which the `?: never` members make
 * false for exactly those shapes), and the narrowing by a runtime walk.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  GenerationRuntimeProbe,
  GenerationRuntimeProbeCheck,
  GenerationRuntimeProbeOutcome,
  GenerationRuntimeProbeRepair,
} from './ui-generator.js';

type FailChecks = readonly [GenerationRuntimeProbeCheck, ...GenerationRuntimeProbeCheck[]];

describe('GenerationRuntimeProbe (ggui#1380)', () => {
  it('the check-kind union is the seven checks the probe runs, declared once here', () => {
    expectTypeOf<GenerationRuntimeProbeCheck>().toEqualTypeOf<
      | 'render-no-throw'
      | 'prop-sensitivity'
      | 'action-wiring'
      | 'selection-identity'
      | 'prop-coverage'
      | 'optional-props-omitted'
      | 'stream-rerender'
    >();
  });

  it('the outcome is exactly: ran + pass, ran + fail with a non-empty failChecks, or a no-verdict status', () => {
    expectTypeOf<GenerationRuntimeProbeOutcome>().toEqualTypeOf<
      | {
          readonly status: 'ran';
          readonly verdict: 'pass';
          readonly failChecks?: never;
          readonly elapsedMs?: number;
        }
      | {
          readonly status: 'ran';
          readonly verdict: 'fail';
          readonly failChecks: FailChecks;
          readonly elapsedMs?: number;
        }
      | {
          readonly status: 'timed-out' | 'infra-skipped' | 'not-applicable';
          readonly verdict?: never;
          readonly failChecks?: never;
          readonly elapsedMs?: number;
        }
    >();
  });

  it('the probe is the outcome plus an optional repair record', () => {
    expectTypeOf<GenerationRuntimeProbe>().toEqualTypeOf<
      GenerationRuntimeProbeOutcome & { readonly repair?: GenerationRuntimeProbeRepair }
    >();
  });

  it('repair is exactly the not-compiled arm or the compiled arm with the re-probe outcome', () => {
    expectTypeOf<GenerationRuntimeProbeRepair>().toEqualTypeOf<
      | { readonly attempted: true; readonly compiled: false; readonly after?: never }
      | { readonly attempted: true; readonly compiled: true; readonly after: GenerationRuntimeProbeOutcome }
    >();
  });

  it('the shapes the engine never produces are refused', () => {
    // ran with no verdict
    expectTypeOf<{ status: 'ran' }>().not.toMatchTypeOf<GenerationRuntimeProbeOutcome>();
    // ran + fail with no failChecks, and with an empty failChecks
    expectTypeOf<{ status: 'ran'; verdict: 'fail' }>().not.toMatchTypeOf<GenerationRuntimeProbeOutcome>();
    expectTypeOf<{ status: 'ran'; verdict: 'fail'; failChecks: readonly [] }>().not.toMatchTypeOf<GenerationRuntimeProbeOutcome>();
    // ran + pass carrying failChecks
    expectTypeOf<{ status: 'ran'; verdict: 'pass'; failChecks: readonly ['action-wiring'] }>().not.toMatchTypeOf<GenerationRuntimeProbeOutcome>();
    // a no-verdict status with a verdict
    expectTypeOf<{ status: 'timed-out'; verdict: 'pass' }>().not.toMatchTypeOf<GenerationRuntimeProbeOutcome>();
    expectTypeOf<{ status: 'infra-skipped'; verdict: 'fail'; failChecks: readonly ['render-no-throw'] }>().not.toMatchTypeOf<GenerationRuntimeProbeOutcome>();
    // compiled with no after; not compiled with an after
    expectTypeOf<{ attempted: true; compiled: true }>().not.toMatchTypeOf<GenerationRuntimeProbeRepair>();
    expectTypeOf<{ attempted: true; compiled: false; after: { status: 'ran'; verdict: 'pass' } }>().not.toMatchTypeOf<GenerationRuntimeProbeRepair>();
    // controls: the legal arms are admitted by the same assertion
    expectTypeOf<{ status: 'ran'; verdict: 'pass' }>().toMatchTypeOf<GenerationRuntimeProbeOutcome>();
    expectTypeOf<{ status: 'ran'; verdict: 'fail'; failChecks: readonly ['render-no-throw'] }>().toMatchTypeOf<GenerationRuntimeProbeOutcome>();
    expectTypeOf<{ status: 'timed-out' }>().toMatchTypeOf<GenerationRuntimeProbeOutcome>();
    expectTypeOf<{ attempted: true; compiled: false }>().toMatchTypeOf<GenerationRuntimeProbeRepair>();
    expectTypeOf<{ attempted: true; compiled: true; after: { status: 'ran'; verdict: 'pass' } }>().toMatchTypeOf<GenerationRuntimeProbeRepair>();
  });

  it('narrowing on `compiled` yields the re-probe outcome, and on its `verdict` the failed checks, with no optional check', () => {
    const repairs: readonly GenerationRuntimeProbeRepair[] = [
      { attempted: true, compiled: false },
      { attempted: true, compiled: true, after: { status: 'ran', verdict: 'pass', elapsedMs: 3 } },
      { attempted: true, compiled: true, after: { status: 'ran', verdict: 'fail', failChecks: ['render-no-throw', 'prop-sensitivity'] } },
      { attempted: true, compiled: true, after: { status: 'ran', verdict: 'fail', failChecks: ['action-wiring'] } },
      { attempted: true, compiled: true, after: { status: 'timed-out', elapsedMs: 30_000 } },
    ];
    const after = repairs.map((r) => (r.compiled ? r.after.status : 'no re-probe'));
    expect(after).toEqual(['no re-probe', 'ran', 'ran', 'ran', 'timed-out']);

    // The two rates the docblock names, derived with the narrowing alone.
    const repairSucceeded = repairs.map((r) => r.compiled && r.after.verdict === 'pass');
    expect(repairSucceeded).toEqual([false, true, false, false, false]);
    const crashStillThere = repairs.map(
      (r) => r.compiled && r.after.verdict === 'fail' && r.after.failChecks.includes('render-no-throw'),
    );
    expect(crashStillThere).toEqual([false, false, true, false, false]);
  });

  it('a `ran` record narrows on `verdict` to the failed checks — the crash-class rate is one `includes`', () => {
    const probes: readonly GenerationRuntimeProbe[] = [
      { status: 'ran', verdict: 'pass', elapsedMs: 800 },
      { status: 'ran', verdict: 'fail', failChecks: ['render-no-throw'], elapsedMs: 900, repair: { attempted: true, compiled: false } },
      { status: 'ran', verdict: 'fail', failChecks: ['prop-sensitivity'] },
      { status: 'infra-skipped' },
    ];
    const crashClass = probes.map((p) => p.verdict === 'fail' && p.failChecks.includes('render-no-throw'));
    expect(crashClass).toEqual([false, true, false, false]);
    const verdicts = probes.map((p) => p.verdict ?? 'none');
    expect(verdicts).toEqual(['pass', 'fail', 'fail', 'none']);
  });
});
