/**
 * ggui#1380 — the probe meta a round stamps on `EvalResult.runtimeProbe`
 * carries the probe's VERDICT, and the type refuses the states the probe
 * cannot be in. `RuntimeProbeMeta` is the metadata's outcome union
 * (`GenerationRuntimeProbeOutcome` in `@ggui-ai/mcp-server-core`, declared
 * there because core cannot import the engine) with the engine's own
 * timing/host fields on every arm; `failChecks` is typed on the engine's
 * check-kind name. `RuntimeProbeRepair` is the not-compiled arm or the
 * compiled arm with the re-probe's meta — `recoverableFailAfter` is gone,
 * derivable from `after.verdict` and `after.failChecks`. Pinned without
 * `@ts-expect-error`: exact unions by `toEqualTypeOf`, refusals by
 * `.not.toMatchTypeOf`, the legal arms as `satisfies` controls.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { GenerationRuntimeProbeOutcome } from '@ggui-ai/mcp-server-core';
import type { RenderCheckKind } from '../harness/check/runtime-render/render-check.js';
import type { ProbeHostLoad, RuntimeProbeMeta, RuntimeProbeRepair } from './types-public.js';

type FailMeta = Extract<RuntimeProbeMeta, { verdict: 'fail' }>;

describe('RuntimeProbeMeta carries the verdict (ggui#1380)', () => {
  it('is the metadata outcome union with reason / renderMs / hostLoad on every arm', () => {
    expectTypeOf<RuntimeProbeMeta>().toEqualTypeOf<
      GenerationRuntimeProbeOutcome & {
        readonly reason?: string;
        readonly renderMs?: number;
        readonly hostLoad?: ProbeHostLoad;
      }
    >();
    expectTypeOf<FailMeta['failChecks'][number]>().toEqualTypeOf<RenderCheckKind>();
  });

  it('a ran meta without a verdict is refused, and a no-verdict status with a verdict is refused', () => {
    expectTypeOf<{ status: 'ran' }>().not.toMatchTypeOf<RuntimeProbeMeta>();
    expectTypeOf<{ status: 'ran'; elapsedMs: 812; renderMs: 640 }>().not.toMatchTypeOf<RuntimeProbeMeta>();
    expectTypeOf<{ status: 'ran'; verdict: 'fail' }>().not.toMatchTypeOf<RuntimeProbeMeta>();
    expectTypeOf<{ status: 'timed-out'; verdict: 'pass' }>().not.toMatchTypeOf<RuntimeProbeMeta>();
    expectTypeOf<{ status: 'not-applicable'; verdict: 'fail'; failChecks: readonly ['render-no-throw'] }>().not.toMatchTypeOf<RuntimeProbeMeta>();
    // Controls: the legal arms compile as literals of the type.
    const pass = { status: 'ran', verdict: 'pass', elapsedMs: 812, renderMs: 640 } satisfies RuntimeProbeMeta;
    const fail = { status: 'ran', verdict: 'fail', failChecks: ['render-no-throw', 'prop-sensitivity'], elapsedMs: 900 } satisfies RuntimeProbeMeta;
    const timedOut = { status: 'timed-out', reason: 'did not finish', elapsedMs: 30_000, hostLoad: { start: 1, end: 2, cores: 4 } } satisfies RuntimeProbeMeta;
    const notApplicable = { status: 'not-applicable', reason: 'no compiled code' } satisfies RuntimeProbeMeta;
    expect([pass.verdict, fail.verdict, timedOut.status, notApplicable.status]).toEqual(['pass', 'fail', 'timed-out', 'not-applicable']);
    expect(fail.failChecks).toEqual(['render-no-throw', 'prop-sensitivity']);
  });

  it('the repair record is the not-compiled arm or the compiled arm with the re-probe meta', () => {
    expectTypeOf<RuntimeProbeRepair>().toEqualTypeOf<
      | { readonly attempted: true; readonly compiled: false; readonly after?: never }
      | { readonly attempted: true; readonly compiled: true; readonly after: RuntimeProbeMeta }
    >();
    expectTypeOf<{ attempted: true; compiled: true }>().not.toMatchTypeOf<RuntimeProbeRepair>();
    expectTypeOf<{ attempted: true; compiled: false; after: { status: 'ran'; verdict: 'pass' } }>().not.toMatchTypeOf<RuntimeProbeRepair>();
    expectTypeOf<{ attempted: true; compiled: true; after: { status: 'ran' } }>().not.toMatchTypeOf<RuntimeProbeRepair>();
    // Controls.
    const notCompiled = { attempted: true, compiled: false } satisfies RuntimeProbeRepair;
    const stillCrashing = {
      attempted: true,
      compiled: true,
      after: { status: 'ran', verdict: 'fail', failChecks: ['render-no-throw'], elapsedMs: 700 },
    } satisfies RuntimeProbeRepair;
    const fixed = { attempted: true, compiled: true, after: { status: 'ran', verdict: 'pass', elapsedMs: 500 } } satisfies RuntimeProbeRepair;
    const reprobeTimedOut = { attempted: true, compiled: true, after: { status: 'timed-out', reason: 'did not finish' } } satisfies RuntimeProbeRepair;
    // `recoverableFailAfter` is derived, never stored: the crash class is still there iff …
    const crashStill = [notCompiled, stillCrashing, fixed, reprobeTimedOut].map(
      (r: RuntimeProbeRepair) => r.compiled && r.after.verdict === 'fail' && r.after.failChecks.includes('render-no-throw'),
    );
    expect(crashStill).toEqual([false, true, false, false]);
  });
});
