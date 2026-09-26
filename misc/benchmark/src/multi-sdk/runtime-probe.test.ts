import { describe, it, expect } from 'vitest';
import { deriveRuntimeProbeVerdict } from './runtime-probe';
import type { EvalResult } from '@ggui-ai/ui-gen/evaluation';

function issue(subcategory: string, result: 'fail' | 'warn'): EvalResult['issues'][number] {
  // The probe stamps its findings under an existing category with a `runtime:` subcategory.
  return { tier: 1, result, category: 'contract', subcategory, description: subcategory, fix: '' };
}

function evalWith(issues: EvalResult['issues'], probe: EvalResult['runtimeProbe']): EvalResult {
  return { issues, pass: [], ...(probe ? { runtimeProbe: probe } : {}) };
}

describe('deriveRuntimeProbeVerdict (#973 — the console-only verdict becomes a report field)', () => {
  it('is skipped with a reason when eval rounds did not run at all', () => {
    expect(deriveRuntimeProbeVerdict(undefined)).toEqual({
      status: 'skipped', passed: false, failures: 0, warnings: 0, reason: 'eval rounds did not run',
    });
  });

  it('is skipped with a reason when the eval result carries no runtimeProbe stamp', () => {
    const v = deriveRuntimeProbeVerdict(evalWith([], undefined));
    expect(v.status).toBe('skipped');
    expect(v.passed).toBe(false);
    expect(v.reason).toBe('probe did not run (no runtimeProbe stamp on eval result)');
  });

  it('counts only runtime:* issues — a fail is a FAIL, warns are counted, unrelated issues ignored', () => {
    const v = deriveRuntimeProbeVerdict(
      evalWith(
        [
          issue('runtime:action-wiring:useAction', 'fail'),
          issue('runtime:stream-rerender', 'warn'),
          issue('raw-spacing', 'fail'), // not a probe finding — must not count
        ],
        { status: 'ran', verdict: 'fail', failChecks: ['action-wiring'] },
      ),
    );
    expect(v).toEqual({ status: 'ran', passed: false, failures: 1, warnings: 1 });
  });

  it('passes with zero runtime failures', () => {
    const v = deriveRuntimeProbeVerdict(evalWith([], { status: 'ran', verdict: 'pass' }));
    expect(v).toEqual({ status: 'ran', passed: true, failures: 0, warnings: 0 });
  });

  it("agrees with the engine's own verdict on the probe meta (ggui#1380 C1b): two derivations of one fact, pinned equal", () => {
    const fixtures: EvalResult[] = [
      evalWith([issue('runtime:render-no-throw', 'fail'), issue('runtime:action-wiring:save', 'fail')], {
        status: 'ran',
        verdict: 'fail',
        failChecks: ['render-no-throw', 'action-wiring'],
      }),
      evalWith([], { status: 'ran', verdict: 'pass' }),
      evalWith([], { status: 'timed-out', reason: 'did not finish' }),
    ];
    for (const ev of fixtures) {
      const derived = deriveRuntimeProbeVerdict(ev);
      const engine = ev.runtimeProbe?.verdict === 'pass';
      expect(derived.passed).toBe(engine);
    }
  });
});

describe('deriveRuntimeProbeVerdict agrees with the probe metadata\'s own verdict (#1380 C1b — two derivations of one fact)', () => {
  // Each fixture is a `ran` result whose `verdict` is what ui-gen's exit probe stamps for those
  // issues: `fail` iff a known check kind failed (failChecks in declaration order), `pass`
  // otherwise — warnings and non-probe issues never fail it. If the bench's `passed` ever drifts
  // from the metadata's verdict, this fails instead of one cell showing two different rates.
  const cases: ReadonlyArray<{ name: string; r: EvalResult }> = [
    { name: 'no findings', r: evalWith([], { status: 'ran', verdict: 'pass' }) },
    { name: 'one failing check', r: evalWith([issue('runtime:action-wiring:useAction', 'fail')], { status: 'ran', verdict: 'fail', failChecks: ['action-wiring'] }) },
    { name: 'warnings only', r: evalWith([issue('runtime:stream-rerender', 'warn')], { status: 'ran', verdict: 'pass' }) },
    {
      name: 'a fail beside a warn',
      r: evalWith(
        [issue('runtime:stream-rerender', 'warn'), issue('runtime:action-wiring:useAction', 'fail')],
        { status: 'ran', verdict: 'fail', failChecks: ['action-wiring'] },
      ),
    },
    { name: 'a non-probe fail only', r: evalWith([issue('raw-spacing', 'fail')], { status: 'ran', verdict: 'pass' }) },
  ];
  for (const { name, r } of cases) {
    it(`${name}: passed === (verdict === 'pass')`, () => {
      const probe = r.runtimeProbe;
      expect(probe?.status).toBe('ran');
      expect(deriveRuntimeProbeVerdict(r).passed).toBe(probe?.status === 'ran' && probe.verdict === 'pass');
    });
  }
});
