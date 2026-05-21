/**
 * Complaint-feedback builders for the advanced generator's iterative
 * loop.
 *
 * The fast stage (`runRenderCheck`) returns structured
 * {@link RenderCheckIssue}s; the slow stage
 * (`validateContractBehavior`) returns structured
 * {@link BehaviorFailure}s. This module converts both into
 * prompt-augmenting text fragments the regen call appends to the
 * user prompt — same shape the existing `runEvaluationLoop` uses
 * for LLM-eval complaints.
 *
 * Format mirrors the diagnostic format the runtime-render adapter
 * already produces (see `harness/check/runtime-render/adapter.ts`),
 * so the LLM sees consistent feedback regardless of which stage
 * surfaced the issue.
 */
import type { RenderCheckIssue } from '../harness/check/runtime-render/index.js';
import type { BehaviorFailure } from '@ggui-ai/ui-visual-tester';

export interface FastStageDiagnostic {
  readonly stage: 'fast';
  readonly check: RenderCheckIssue['check'];
  readonly subject?: string;
  readonly reason: string;
}

export interface SlowStageDiagnostic {
  readonly stage: 'slow';
  readonly kind: BehaviorFailure['kind'];
  readonly actionName?: string;
  readonly diagnostic: string;
}

export type StageDiagnostic = FastStageDiagnostic | SlowStageDiagnostic;

/**
 * Convert runtime-render issues into structured diagnostics. Only
 * `failed` outcomes become complaints; `unverified` / `verified` /
 * `skipped` are not blocking (mirrors the runtime-render adapter's
 * own block-vs-warn split).
 */
export function buildFastStageComplaints(
  issues: readonly RenderCheckIssue[],
): FastStageDiagnostic[] {
  const out: FastStageDiagnostic[] = [];
  for (const issue of issues) {
    if (issue.outcome !== 'failed') continue;
    out.push({
      stage: 'fast',
      check: issue.check,
      ...(issue.subject !== undefined ? { subject: issue.subject } : {}),
      reason: issue.reason,
    });
  }
  return out;
}

export function buildSlowStageComplaints(
  failures: readonly BehaviorFailure[],
): SlowStageDiagnostic[] {
  return failures.map((f) => ({
    stage: 'slow',
    kind: f.kind,
    ...(f.actionName !== undefined ? { actionName: f.actionName } : {}),
    diagnostic: f.diagnostic,
  }));
}

/**
 * Build the prompt fragment appended to the next iteration's user
 * prompt. Same human-readable format the LLM-eval loop produces so
 * the generator sees a uniform regen surface.
 */
export function buildIterationFeedback(
  diagnostics: readonly StageDiagnostic[],
  iteration: number,
): string {
  if (diagnostics.length === 0) return '';
  const heading = `\n\n## Validation feedback (round ${iteration})\n\nThe previous generation failed validation. Address each issue below before re-emitting the component:\n`;
  const items = diagnostics
    .map((d) => {
      if (d.stage === 'fast') {
        const subj = d.subject ? ` [${d.subject}]` : '';
        return `- (fast/${d.check}${subj}) ${d.reason}`;
      }
      const subj = d.actionName ? ` [${d.actionName}]` : '';
      return `- (slow/${d.kind}${subj}) ${d.diagnostic}`;
    })
    .join('\n');
  return heading + items + '\n';
}
