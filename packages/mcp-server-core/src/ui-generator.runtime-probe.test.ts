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
          readonly queuedMs?: number;
        }
      | {
          readonly status: 'ran';
          readonly verdict: 'fail';
          readonly failChecks: FailChecks;
          readonly elapsedMs?: number;
          readonly queuedMs?: number;
        }
      | {
          readonly status: 'timed-out' | 'infra-skipped' | 'not-applicable';
          readonly verdict?: never;
          readonly failChecks?: never;
          readonly elapsedMs?: number;
          readonly queuedMs?: number;
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
      | { readonly attempted: true; readonly compiled: false; readonly trigger?: never }
      | { readonly attempted: true; readonly compiled: true; readonly trigger: GenerationRuntimeProbeOutcome }
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
    expectTypeOf<{ attempted: true; compiled: false; trigger: { status: 'ran'; verdict: 'fail'; failChecks: readonly ['render-no-throw'] } }>().not.toMatchTypeOf<GenerationRuntimeProbeRepair>();
    // controls: the legal arms are admitted by the same assertion
    expectTypeOf<{ status: 'ran'; verdict: 'pass' }>().toMatchTypeOf<GenerationRuntimeProbeOutcome>();
    expectTypeOf<{ status: 'ran'; verdict: 'fail'; failChecks: readonly ['render-no-throw'] }>().toMatchTypeOf<GenerationRuntimeProbeOutcome>();
    expectTypeOf<{ status: 'timed-out' }>().toMatchTypeOf<GenerationRuntimeProbeOutcome>();
    expectTypeOf<{ attempted: true; compiled: false }>().toMatchTypeOf<GenerationRuntimeProbeRepair>();
    expectTypeOf<{ attempted: true; compiled: true; trigger: { status: 'ran'; verdict: 'fail'; failChecks: readonly ['render-no-throw'] } }>().toMatchTypeOf<GenerationRuntimeProbeRepair>();
  });

  it('narrowing on `compiled` yields the trigger (the probe that bought the turn); the three rates the docblock names derive from a record with no optional check', () => {
    const crash: GenerationRuntimeProbeOutcome = { status: 'ran', verdict: 'fail', failChecks: ['render-no-throw'], elapsedMs: 50 };
    const records: readonly GenerationRuntimeProbe[] = [
      // served clean, no repair
      { status: 'ran', verdict: 'pass', elapsedMs: 3 },
      // a crash served at the turn cap: no repair record, the top level is the crash
      { status: 'ran', verdict: 'fail', failChecks: ['render-no-throw'], elapsedMs: 50 },
      // a repair that did not compile: the top level IS the trigger
      { status: 'ran', verdict: 'fail', failChecks: ['render-no-throw', 'prop-sensitivity'], repair: { attempted: true, compiled: false } },
      // a repair that fixed the crash
      { status: 'ran', verdict: 'pass', elapsedMs: 30, repair: { attempted: true, compiled: true, trigger: crash } },
      // a repair whose re-probe still crashes
      { status: 'ran', verdict: 'fail', failChecks: ['render-no-throw'], elapsedMs: 45, repair: { attempted: true, compiled: true, trigger: crash } },
      // a repair whose re-probe timed out
      { status: 'timed-out', elapsedMs: 30_000, repair: { attempted: true, compiled: true, trigger: crash } },
    ];
    const triggers = records.map((r) => (r.repair?.compiled ? r.repair.trigger.status : 'no trigger recorded'));
    expect(triggers).toEqual(['no trigger recorded', 'no trigger recorded', 'no trigger recorded', 'ran', 'ran', 'ran']);

    const crashHappened = records.map(
      (r) => r.repair !== undefined || (r.verdict === 'fail' && r.failChecks.includes('render-no-throw')),
    );
    expect(crashHappened).toEqual([false, true, true, true, true, true]);
    const crashServed = records.map((r) => r.verdict === 'fail' && r.failChecks.includes('render-no-throw'));
    expect(crashServed).toEqual([false, true, true, false, true, false]);
    const repairSucceeded = records.map((r) => r.repair?.compiled === true && r.verdict === 'pass');
    expect(repairSucceeded).toEqual([false, false, false, true, false, false]);
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
