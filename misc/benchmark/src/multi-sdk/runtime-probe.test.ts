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
        { status: 'ran' },
      ),
    );
    expect(v).toEqual({ status: 'ran', passed: false, failures: 1, warnings: 1 });
  });

  it('passes with zero runtime failures', () => {
    const v = deriveRuntimeProbeVerdict(evalWith([], { status: 'ran' }));
    expect(v).toEqual({ status: 'ran', passed: true, failures: 0, warnings: 0 });
  });
});
