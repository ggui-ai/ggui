/**
 * ggui#1380 — `CodingSession.probeOnlyEnabled`: a serving deployment that
 * wires the runtime-render check and configures NO evaluator gets the
 * probe-only lane (the probe runs once after the coding turns, with one
 * repair turn on a recoverable crash); any configured evaluator keeps the
 * evaluation lane, whose exit probe is a different round. The six-row truth
 * table below is the whole rule, pinned at the session seam with the real
 * `initSession` (the evaluator's pre-warm stubbed at its module seam so the
 * bind-lane rows never reach a provider).
 *
 *   probe wired | evaluation          | visual      | probeOnlyEnabled
 *   ------------+---------------------+-------------+-----------------
 *   yes         | none                | none        | true   (row 1)
 *   yes         | { enabled: true }   | none        | false  (row 2, the bind lane)
 *   yes         | none                | enabled     | false  (row 3)
 *   yes         | { enabled: false }  | none        | true   (row 6 — the config is present, the evaluator is not)
 *   no          | none                | none        | false  (row 4 — nothing to probe with)
 *   no          | { enabled: true }   | none        | false  (row 5)
 *
 * The true row carries NO evaluation modules: tiersMod / costTracker /
 * llmEvalMod / visualMod all null — the lane runs the probe and nothing else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyAxes } from '../../classifier/classifier.js';
import { createHarness } from '../../create-harness.js';
import type { RuntimeRenderCheck, RuntimeRenderOutcome } from '../types-public.js';
import type { SingleComponentParams } from '../runtime.js';

vi.mock('../../evaluation/llm-evaluator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../evaluation/llm-evaluator.js')>();
  return {
    ...actual,
    preWarmEval: vi.fn(async () => null),
  };
});

const { initSession, resolveSessionAgents } = await import('./init-session.js');

const PROBE: RuntimeRenderCheck = {
  id: 'stub-runtime-render',
  run: async (): Promise<RuntimeRenderOutcome> => ({ status: 'ran', issues: [] }),
};

async function buildSession(options: {
  probe: RuntimeRenderCheck | undefined;
  evaluation?: SingleComponentParams['evaluation'];
  visualEvaluation?: SingleComponentParams['visualEvaluation'];
}) {
  const classification = classifyAxes({ contract: {}, prompt: 'a card' });
  const harness = createHarness({ classification, contract: {}, prompt: 'a card', runtimeRender: options.probe });
  const params: SingleComponentParams = {
    userPrompt: 'a card',
    ...(options.evaluation !== undefined ? { evaluation: options.evaluation } : {}),
    ...(options.visualEvaluation !== undefined ? { visualEvaluation: options.visualEvaluation } : {}),
  };
  const agents = resolveSessionAgents({ codingAgent: { provider: 'anthropic', model: 'claude-haiku-4-5' } });
  return initSession({ harness, params, agents });
}

describe('CodingSession.probeOnlyEnabled — the six-row truth table (ggui#1380)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('row 1: probe wired, no evaluation, no visual → true, and no evaluation module is loaded', async () => {
    const session = await buildSession({ probe: PROBE });
    expect(session.probeOnlyEnabled).toBe(true);
    expect(session.codeEvalEnabled).toBe(false);
    expect(session.visualEvalEnabled).toBe(false);
    expect(session.tiersMod).toBeNull();
    expect(session.costTracker).toBeNull();
    expect(session.llmEvalMod).toBeNull();
    expect(session.visualMod).toBeNull();
  });

  it('row 2 (the bind lane): probe wired + evaluation enabled → false', async () => {
    const session = await buildSession({ probe: PROBE, evaluation: { enabled: true, passThreshold: 70 } });
    expect(session.probeOnlyEnabled).toBe(false);
    expect(session.codeEvalEnabled).toBe(true);
    expect(session.tiersMod).not.toBeNull();
    expect(session.costTracker).not.toBeNull();
  });

  it('row 3: probe wired + visual evaluation enabled → false', async () => {
    const session = await buildSession({ probe: PROBE, visualEvaluation: { enabled: true } });
    expect(session.probeOnlyEnabled).toBe(false);
    expect(session.visualEvalEnabled).toBe(true);
  });

  it('row 6: probe wired + evaluation: { enabled: false } → true (a config that enables nothing is no evaluator)', async () => {
    const session = await buildSession({ probe: PROBE, evaluation: { enabled: false, passThreshold: 70 } });
    expect(session.probeOnlyEnabled).toBe(true);
    expect(session.codeEvalEnabled).toBe(false);
    expect(session.tiersMod).toBeNull();
  });

  it('row 4: no probe, no evaluation → false (nothing to probe with)', async () => {
    const session = await buildSession({ probe: undefined });
    expect(session.probeOnlyEnabled).toBe(false);
    expect(session.codeEvalEnabled).toBe(false);
  });

  it('row 5: no probe + evaluation enabled → false', async () => {
    const session = await buildSession({ probe: undefined, evaluation: { enabled: true, passThreshold: 70 } });
    expect(session.probeOnlyEnabled).toBe(false);
    expect(session.codeEvalEnabled).toBe(true);
  });
});
