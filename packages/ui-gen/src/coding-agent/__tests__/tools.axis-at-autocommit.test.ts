/**
 * Pin (ggui#1122): the deterministic axis family runs at AUTO-COMMIT — on every commit the coding
 * agent makes, which is the serve path — not only inside the eval round a serving deployment never
 * enters. Posture is the founder's, verbatim via exec: "WARN→block on serve needs my word" —
 * so warn-as-warn (the non-blocking Warnings line the model already reads) and fail-as-fail
 * (the blocking violations tier-0 already produces). Absent the bundle, nothing runs and the
 * commit reads exactly as before.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { classifyAxes } from '../../classifier/index.js';
import type { CanvasClass } from '../../design-mode.js';
import type { AxisCheck, AxisCheckInput, EvalIssue } from '../../evaluation/types-public.js';
import { executeTool, type AutoCommitAxisChecks } from '../tools';
import type { CommitMetadata } from '../types';
import { AgentWorkspace } from '../workspace';

const CODE = `interface Props { name: string; }
export default function Hello(props: Props) {
  return <div style={{ color: 'var(--ggui-color-primary-600)' }} aria-label="c">{props.name}</div>;
}`;
const PROMPT = 'a greeting card';
const classification = classifyAxes({ contract: {}, prompt: PROMPT });

/** A check that records what it was handed and emits the issue it is told to. */
function probe(seen: Array<{ canvas: CanvasClass | undefined; prompt: string }>, issue?: EvalIssue): AxisCheck {
  return {
    id: 'probe.at_autocommit',
    axis: 'render',
    values: [classification.vector.render],
    run(input: AxisCheckInput) {
      seen.push({ canvas: input.canvas, prompt: input.originalPrompt });
      return issue === undefined ? [] : [issue];
    },
  };
}
const issue = (result: 'warn' | 'fail'): EvalIssue => ({
  tier: 1,
  result,
  severity: result === 'fail' ? 'critical' : 'major',
  category: 'visual',
  subcategory: 'probe.at_autocommit',
  description: `probe says ${result}`,
  fix: 'do the thing',
});
const bundle = (checks: readonly AxisCheck[], canvas?: CanvasClass): AutoCommitAxisChecks => ({
  checks,
  classification,
  originalPrompt: PROMPT,
  ...(canvas !== undefined ? { canvas } : {}),
});

describe('axis checks at auto-commit (ggui#1122)', () => {
  let ws: AgentWorkspace;
  let commitMeta: Map<string, CommitMetadata>;
  beforeEach(async () => {
    ws = new AgentWorkspace();
    await ws.init();
    commitMeta = new Map();
  });

  it('a WARN rides the non-blocking Warnings line: the commit PASSES, the model reads the warning', async () => {
    const seen: Array<{ canvas: CanvasClass | undefined; prompt: string }> = [];
    const result = await executeTool(ws, 'write', { code: CODE, commit_message: 'feat: hello' }, commitMeta, undefined, undefined, undefined, undefined, 'constrained', bundle([probe(seen, issue('warn'))], 'lg'));
    expect(result.done).toBe(true);
    expect(result.result).toContain('Self-check: PASS');
    expect(result.result).toContain('Warnings (non-blocking)');
    expect(result.result).toContain('[probe.at_autocommit] probe says warn');
    expect(seen).toEqual([{ canvas: 'lg', prompt: PROMPT }]); // the harness's canvas and the ORIGINAL request reach the check
    expect([...commitMeta.values()][0]!.selfCheck).toEqual({ passed: true, violations: [] });
  }, 30000);

  it('a FAIL blocks exactly as a tier-0 fail does: violations name it, the turn is told to fix', async () => {
    const seen: Array<{ canvas: CanvasClass | undefined; prompt: string }> = [];
    const result = await executeTool(ws, 'write', { code: CODE, commit_message: 'feat: hello' }, commitMeta, undefined, undefined, undefined, undefined, 'constrained', bundle([probe(seen, issue('fail'))]));
    expect(result.done).toBeUndefined();
    expect(result.result).toContain('Self-check violations');
    expect(result.result).toContain('probe says fail');
    expect(result.result).toContain('Fix the issues.');
    expect(seen).toEqual([{ canvas: undefined, prompt: PROMPT }]); // no canvas on the bundle → none on the input, never a default
    expect([...commitMeta.values()][0]!.selfCheck.passed).toBe(false);
  }, 30000);

  it('no bundle: nothing runs and the commit reads exactly as before', async () => {
    const result = await executeTool(ws, 'write', { code: CODE, commit_message: 'feat: hello' }, commitMeta);
    expect(result.done).toBe(true);
    expect(result.result).not.toContain('probe');
  }, 30000);

  it('a build failure: the checks are not asked to judge source that did not build (the trace says no check ran)', async () => {
    const seen: Array<{ canvas: CanvasClass | undefined; prompt: string }> = [];
    const broken = 'export default function Hello() { return <div>; }';
    const result = await executeTool(ws, 'write', { code: broken, commit_message: 'feat: broken' }, commitMeta, undefined, undefined, undefined, undefined, 'constrained', bundle([probe(seen, issue('warn'))], 'lg'));
    expect(result.done).toBeUndefined();
    expect(seen).toEqual([]);
  }, 30000);
});
