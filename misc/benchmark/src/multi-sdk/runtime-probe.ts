import type { EvalResult } from '@ggui-ai/ui-gen/evaluation';

/**
 * Per-cell runtime-probe verdict, persisted on `BenchmarkRunResult` (#973).
 *
 * Contract: `status: 'skipped'` is NEVER a pass (`passed: false`) and always
 * carries `reason` — worded exactly as the runner's historical SKIP log line, so
 * `SKIP — ${reason}` reproduces it byte for byte — an infra-dead probe must not score PASS on every cell
 * (the failure mode the runner's log line was added to expose). `status:
 * 'ran'` counts only `runtime:*` issues: `failures` = result `fail`,
 * `warnings` = result `warn`; `passed` = zero failures.
 */
export interface RuntimeProbeVerdict {
  readonly status: 'ran' | 'skipped';
  readonly passed: boolean;
  readonly failures: number;
  readonly warnings: number;
  readonly reason?: string;
}

/** The `runtime:*` issues of an eval result — the probe's own findings. */
export function runtimeProbeIssues(tierEvaluation: EvalResult): EvalResult['issues'] {
  return tierEvaluation.issues.filter(
    (i) => typeof i.subcategory === 'string' && i.subcategory.startsWith('runtime:'),
  );
}

/**
 * Derive the verdict from a cell's tier evaluation. Pure; the runner logs
 * it and stamps it on the result, rnd's verdict script reads it from the
 * report (§5a of the Exp 008 design).
 */
export function deriveRuntimeProbeVerdict(tierEvaluation: EvalResult | undefined): RuntimeProbeVerdict {
  if (!tierEvaluation) {
    return { status: 'skipped', passed: false, failures: 0, warnings: 0, reason: 'eval rounds did not run' };
  }
  const probe = tierEvaluation.runtimeProbe;
  if (!probe) {
    return { status: 'skipped', passed: false, failures: 0, warnings: 0, reason: 'probe did not run (no runtimeProbe stamp on eval result)' };
  }
  if (probe.status !== 'ran') {
    const why = `${probe.status}${probe.reason ? `: ${probe.reason}` : ''}`;
    return { status: 'skipped', passed: false, failures: 0, warnings: 0, reason: `probe did not run (${why})` };
  }
  const issues = runtimeProbeIssues(tierEvaluation);
  const failures = issues.filter((i) => i.result === 'fail').length;
  const warnings = issues.filter((i) => i.result === 'warn').length;
  return { status: 'ran', passed: failures === 0, failures, warnings };
}
