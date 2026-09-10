import { describe, it, expect } from 'vitest';
import { runContractBehaviorCheck } from './contract-behavior';
import type { DataContract } from '@ggui-ai/protocol';
import type { PlaywrightModule, ValidateContractBehaviorResult } from '@ggui-ai/ui-visual-tester';

const withActions: DataContract = { actionSpec: { submit: { label: 'Submit', description: 'submit', schema: { type: 'object' } } } };
const noActions: DataContract = {};
// A real PlaywrightModule shape whose browser is never launched by these tests.
const fakePlaywright: PlaywrightModule = {
  chromium: { launch: async () => { throw new Error('unit test: browser must not launch'); } },
};

describe('runContractBehaviorCheck (#973 §5a(4): validateContractBehavior for EVERY cell, in-task)', () => {
  it('is skipped with a reason — never a pass — when the contract has actions but the runner has no Playwright', async () => {
    const r = await runContractBehaviorCheck({ compiledCode: 'x', contract: withActions, playwright: undefined });
    expect(r.status).toBe('skipped');
    expect(r.ok).toBeUndefined();
    expect(r.reason).toContain('Playwright');
  });

  it('runs and records ok + failures + duration when the validator answers', async () => {
    const validate = async (): Promise<ValidateContractBehaviorResult> => ({
      ok: false,
      failures: [{ kind: 'action-no-effect', actionName: 'submit', diagnostic: 'button never dispatched' }],
    });
    const r = await runContractBehaviorCheck({ compiledCode: 'x', contract: withActions, playwright: fakePlaywright, validate });
    expect(r.status).toBe('ran');
    expect(r.ok).toBe(false);
    expect(r.failures?.map((f) => f.actionName)).toEqual(['submit']);
    expect(typeof r.durationMs).toBe('number');
  });

  it('a contract without actions is ran + ok without needing a browser (the validator short-circuits)', async () => {
    const r = await runContractBehaviorCheck({ compiledCode: 'x', contract: noActions, playwright: undefined });
    expect(r).toMatchObject({ status: 'ran', ok: true, failures: [] });
  });

  it('a thrown validator (browser crash, timeout) is skipped with the error as reason — not a component failure, not a pass', async () => {
    const validate = async (): Promise<ValidateContractBehaviorResult> => { throw new Error('browser closed'); };
    const r = await runContractBehaviorCheck({ compiledCode: 'x', contract: withActions, playwright: fakePlaywright, validate });
    expect(r.status).toBe('skipped');
    expect(r.reason).toContain('browser closed');
  });
});

describe('the browser limiter gates only the validator call', () => {
  it('is never invoked for the no-browser short-circuits, and exactly once around a real validation', async () => {
    let calls = 0;
    const limit = async <T,>(fn: () => Promise<T>): Promise<T> => { calls += 1; return fn(); };
    await runContractBehaviorCheck({ compiledCode: 'x', contract: noActions, playwright: undefined, limit });
    await runContractBehaviorCheck({ compiledCode: 'x', contract: withActions, playwright: undefined, limit });
    expect(calls).toBe(0);
    const validate = async (): Promise<ValidateContractBehaviorResult> => ({ ok: true, failures: [] });
    await runContractBehaviorCheck({ compiledCode: 'x', contract: withActions, playwright: fakePlaywright, validate, limit });
    expect(calls).toBe(1);
  });
});

describe('sampleProps pass-through', () => {
  it('hands the commit props to the validator verbatim, and nothing when absent', async () => {
    const seen: unknown[] = [];
    const validate = async (input: { sampleProps?: unknown }) => { seen.push(input.sampleProps); return { ok: true, failures: [] }; };
    await runContractBehaviorCheck({ compiledCode: 'x', contract: withActions, playwright: fakePlaywright, validate, sampleProps: { items: [1] } });
    await runContractBehaviorCheck({ compiledCode: 'x', contract: withActions, playwright: fakePlaywright, validate });
    expect(seen).toEqual([{ items: [1] }, undefined]);
  });
});
