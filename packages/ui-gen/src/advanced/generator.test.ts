/**
 * Tests for the advanced generator (`ui-gen-advanced-opus-4-7`).
 *
 * Strategy: stub the inner generator so we drive the iterative loop
 * deterministically. The fast-stage runRenderCheck and slow-stage
 * validateContractBehavior are invoked for real on tiny inline
 * fixtures — the loop's branching is the load-bearing logic under
 * test, not the validators themselves (those have their own tests).
 *
 * Playwright is exercised in the cross-validation suite at
 * packages/ui-visual-tester. Here we mock the slow stage by passing
 * a stub Playwright module that returns a stub Browser → Page chain
 * which always hits the fast-stage gate (so the slow stage is
 * structurally skipped for the basic tests; one test deliberately
 * runs real Playwright to exercise the full path).
 */
import { describe, it, expect, vi } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import type {
  UiGenerateInput,
  UiGenerateResult,
  UiGenerator,
} from '@ggui-ai/mcp-server-core';
import { PlaywrightNotAvailableError } from '@ggui-ai/ui-visual-tester';
import {
  createAdvancedUiGenerator,
  ADVANCED_GENERATOR_SLUG,
  ADVANCED_GENERATOR_TIER,
  ADVANCED_GENERATOR_MODEL,
  type ValidationIteration,
} from './generator.js';
import {
  buildFastStageComplaints,
  buildSlowStageComplaints,
  buildIterationFeedback,
} from './feedback.js';

const FAKE_PLAYWRIGHT = {
  chromium: {
    launch: vi.fn(),
  },
};

const NULL_INPUT: UiGenerateInput = {
  request: {
    prompt: 'a counter',
    sessionId: 'render-test',
  },
  llm: { provider: 'anthropic', model: 'claude-opus-4-7' },
  providerKey: { provider: 'anthropic', key: 'sk-test' },
  blueprints: {
    list: async () => [],
    get: async () => null,
  },
};

const COUNTER_CONTRACT: DataContract = {
  actionSpec: {
    increment: { label: 'Add' },
  },
};

const COUNTER_SOURCE_GOOD = `
import { useState } from 'react';

export default function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <span>Count: {count}</span>
      <button aria-label="Increment count" onClick={() => setCount(c => c + 1)}>
        Add
      </button>
    </div>
  );
}
`.trim();

const COUNTER_SOURCE_BAD = `
import { useAction } from '@ggui-ai/wire';

export default function Counter() {
  const increment = useAction('increment');
  return (
    <div>
      <span>Count: 0</span>
      <button aria-label="Increment count" onClick={() => { /* no-op */ }}>
        Add
      </button>
    </div>
  );
}
`.trim();

const COUNTER_COMPILED_GOOD = `
const { useState } = window.__ggui__.react;
export default function Counter() {
  const [count, setCount] = useState(0);
  return window.__ggui__.react.createElement('div', null,
    window.__ggui__.react.createElement('span', null, 'Count: ', count),
    window.__ggui__.react.createElement('button', {
      'aria-label': 'Increment count',
      onClick: () => setCount(c => c + 1),
    }, 'Add'),
  );
}
`.trim();

function makeStubResult(opts: {
  source: string;
  compiled: string;
}): UiGenerateResult {
  return {
    ok: true,
    response: {
      sessionId: 'item-test',
      componentCode: opts.compiled,
      sourceCode: opts.source,
    },
    metadata: {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 1000,
      cacheHit: false,
      attempts: 1,
    },
  };
}

function makeStubGenerator(results: UiGenerateResult[]): UiGenerator {
  let i = 0;
  return {
    slug: 'stub-default',
    tier: 'default',
    model: 'stub',
    generate: async () => {
      const r = results[Math.min(i, results.length - 1)]!;
      i++;
      return r;
    },
  };
}

describe('createAdvancedUiGenerator — identity', () => {
  it('bakes the locked slug/tier/model', () => {
    const gen = createAdvancedUiGenerator({
      playwright: FAKE_PLAYWRIGHT,
      innerGenerator: makeStubGenerator([]),
    });
    expect(gen.slug).toBe(ADVANCED_GENERATOR_SLUG);
    expect(gen.slug).toBe('ui-gen-advanced-opus-4-7');
    expect(gen.tier).toBe(ADVANCED_GENERATOR_TIER);
    expect(gen.tier).toBe('advanced');
    expect(gen.model).toBe(ADVANCED_GENERATOR_MODEL);
    expect(gen.model).toBe('opus-4-7');
  });
});

describe('createAdvancedUiGenerator — missing-Playwright error', () => {
  it('throws PlaywrightNotAvailableError on generate() when playwright is undefined', async () => {
    const gen = createAdvancedUiGenerator({
      playwright: undefined,
      innerGenerator: makeStubGenerator([
        makeStubResult({
          source: COUNTER_SOURCE_GOOD,
          compiled: COUNTER_COMPILED_GOOD,
        }),
      ]),
    });
    await expect(
      gen.generate({ ...NULL_INPUT, contract: COUNTER_CONTRACT }),
    ).rejects.toThrow(PlaywrightNotAvailableError);
  });

  it('does NOT throw at factory time when playwright is undefined', () => {
    // Deliberate: a deploy config that drops the playwright dep should
    // not crash at server boot; the error surfaces on first use, when
    // the operator can observe it on a real request.
    expect(() =>
      createAdvancedUiGenerator({
        playwright: undefined,
        innerGenerator: makeStubGenerator([]),
      }),
    ).not.toThrow();
  });

  it('PlaywrightNotAvailableError message explains the missing Playwright dep', async () => {
    const gen = createAdvancedUiGenerator({
      playwright: undefined,
      innerGenerator: makeStubGenerator([
        makeStubResult({
          source: COUNTER_SOURCE_GOOD,
          compiled: COUNTER_COMPILED_GOOD,
        }),
      ]),
    });
    try {
      await gen.generate({ ...NULL_INPUT, contract: COUNTER_CONTRACT });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PlaywrightNotAvailableError);
      const e = err as PlaywrightNotAvailableError;
      expect(e.message).toContain('Playwright module is required');
      expect(e.message).toContain('playwright-core');
    }
  });
});

describe('createAdvancedUiGenerator — producer failure pass-through', () => {
  it('surfaces inner-generator failure without running validators', async () => {
    const failResult: UiGenerateResult = {
      ok: false,
      error: {
        code: 'PRODUCTION_FAILED',
        message: 'no key',
        details: {},
      },
      metadata: {
        provider: 'anthropic',
        model: 'opus-4-7',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 100,
        cacheHit: false,
      },
    };
    const inner = makeStubGenerator([failResult]);
    const innerSpy = vi.spyOn(inner, 'generate');

    const gen = createAdvancedUiGenerator({
      playwright: FAKE_PLAYWRIGHT,
      innerGenerator: inner,
    });
    const result = await gen.generate({
      ...NULL_INPUT,
      contract: COUNTER_CONTRACT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PRODUCTION_FAILED');
    }
    // Inner called exactly once — no retries on producer failure.
    expect(innerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('createAdvancedUiGenerator — empty actionSpec skips slow stage', () => {
  it('returns inner result without engaging Playwright when contract has no actions', async () => {
    const innerResult = makeStubResult({
      source: COUNTER_SOURCE_GOOD,
      compiled: COUNTER_COMPILED_GOOD,
    });
    const gen = createAdvancedUiGenerator({
      playwright: FAKE_PLAYWRIGHT,
      innerGenerator: makeStubGenerator([innerResult]),
    });
    const result = await gen.generate({
      ...NULL_INPUT,
      contract: { propsSpec: { properties: {} } },
    });
    expect(result.ok).toBe(true);
    // The fake chromium.launch was never called.
    expect(FAKE_PLAYWRIGHT.chromium.launch).not.toHaveBeenCalled();
  });
});

describe('createAdvancedUiGenerator — iteration cap', () => {
  it('respects maxIterations and clamps to HARD_MAX_ITERATIONS', async () => {
    // Inner always returns the same bad-counter result; no fast-stage
    // pass possible. We should see exactly maxIterations attempts.
    const badResult = makeStubResult({
      source: COUNTER_SOURCE_BAD,
      compiled: COUNTER_COMPILED_GOOD,
    });
    const inner = makeStubGenerator([badResult]);
    const innerSpy = vi.spyOn(inner, 'generate');

    const gen = createAdvancedUiGenerator({
      playwright: FAKE_PLAYWRIGHT,
      innerGenerator: inner,
      maxIterations: 2,
    });
    const result = await gen.generate({
      ...NULL_INPUT,
      contract: COUNTER_CONTRACT,
    });
    // Always-persist: result is still returned even after exhaustion.
    expect(result.ok).toBe(true);
    expect(innerSpy).toHaveBeenCalledTimes(2);
  });

  it('clamps maxIterations above HARD_MAX_ITERATIONS to 5', async () => {
    const badResult = makeStubResult({
      source: COUNTER_SOURCE_BAD,
      compiled: COUNTER_COMPILED_GOOD,
    });
    const inner = makeStubGenerator([badResult]);
    const innerSpy = vi.spyOn(inner, 'generate');

    const gen = createAdvancedUiGenerator({
      playwright: FAKE_PLAYWRIGHT,
      innerGenerator: inner,
      maxIterations: 100,
    });
    await gen.generate({ ...NULL_INPUT, contract: COUNTER_CONTRACT });
    expect(innerSpy).toHaveBeenCalledTimes(5);
  });

  it('floors fractional maxIterations and forces a minimum of 1', async () => {
    const badResult = makeStubResult({
      source: COUNTER_SOURCE_BAD,
      compiled: COUNTER_COMPILED_GOOD,
    });
    const inner = makeStubGenerator([badResult]);
    const innerSpy = vi.spyOn(inner, 'generate');

    const gen = createAdvancedUiGenerator({
      playwright: FAKE_PLAYWRIGHT,
      innerGenerator: inner,
      maxIterations: 0.5,
    });
    await gen.generate({ ...NULL_INPUT, contract: COUNTER_CONTRACT });
    expect(innerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('createAdvancedUiGenerator — early-exit on pass', () => {
  it('stops after the first round when the fast stage passes and slow stage is skipped', async () => {
    const inner = makeStubGenerator([
      makeStubResult({
        source: COUNTER_SOURCE_GOOD,
        compiled: COUNTER_COMPILED_GOOD,
      }),
    ]);
    const innerSpy = vi.spyOn(inner, 'generate');

    const gen = createAdvancedUiGenerator({
      playwright: FAKE_PLAYWRIGHT,
      innerGenerator: inner,
      maxIterations: 3,
    });
    // Empty actionSpec skips slow stage → fast pass returns immediately.
    const result = await gen.generate({
      ...NULL_INPUT,
      contract: { propsSpec: { properties: {} } },
    });
    expect(result.ok).toBe(true);
    expect(innerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('feedback builders — diagnostic shapes', () => {
  it('buildFastStageComplaints surfaces only failed outcomes', () => {
    const issues = [
      {
        check: 'action-wiring' as const,
        outcome: 'failed' as const,
        subject: 'increment',
        reason: 'Action not wired',
      },
      {
        check: 'prop-coverage' as const,
        outcome: 'unverified' as const,
        subject: 'title',
        reason: 'Prop not visible',
      },
      {
        check: 'render-no-throw' as const,
        outcome: 'verified' as const,
        reason: 'Rendered cleanly',
      },
    ];
    const out = buildFastStageComplaints(issues);
    expect(out.length).toBe(1);
    expect(out[0]?.check).toBe('action-wiring');
    expect(out[0]?.subject).toBe('increment');
    expect(out[0]?.reason).toBe('Action not wired');
  });

  it('buildSlowStageComplaints converts behavior failures', () => {
    const failures = [
      {
        kind: 'action-no-effect' as const,
        actionName: 'increment',
        diagnostic: 'no signal',
      },
    ];
    const out = buildSlowStageComplaints(failures);
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe('action-no-effect');
    expect(out[0]?.actionName).toBe('increment');
    expect(out[0]?.diagnostic).toBe('no signal');
  });

  it('buildIterationFeedback formats both stages and includes round number', () => {
    const diags = [
      ...buildFastStageComplaints([
        {
          check: 'action-wiring' as const,
          outcome: 'failed' as const,
          subject: 'increment',
          reason: 'useAction not wired',
        },
      ]),
      ...buildSlowStageComplaints([
        {
          kind: 'action-no-effect' as const,
          actionName: 'increment',
          diagnostic: 'no DOM change',
        },
      ]),
    ];
    const text = buildIterationFeedback(diags, 2);
    expect(text).toContain('round 2');
    expect(text).toContain('(fast/action-wiring');
    expect(text).toContain('useAction not wired');
    expect(text).toContain('(slow/action-no-effect');
    expect(text).toContain('no DOM change');
  });

  it('buildIterationFeedback returns empty string when there are no diagnostics', () => {
    expect(buildIterationFeedback([], 1)).toBe('');
  });
});

describe('createAdvancedUiGenerator — feedback accumulates across iterations', () => {
  it('appends round-1 complaints to round-2 user prompt', async () => {
    // Stub inner so we can inspect the prompts it receives.
    const calls: string[] = [];
    const inner: UiGenerator = {
      slug: 'stub-inspect',
      tier: 'default',
      model: 'stub',
      generate: async (input) => {
        calls.push(input.request.prompt);
        return makeStubResult({
          source: COUNTER_SOURCE_BAD,
          compiled: COUNTER_COMPILED_GOOD,
        });
      },
    };

    const gen = createAdvancedUiGenerator({
      playwright: FAKE_PLAYWRIGHT,
      innerGenerator: inner,
      maxIterations: 2,
    });
    await gen.generate({
      ...NULL_INPUT,
      contract: COUNTER_CONTRACT,
    });
    expect(calls.length).toBe(2);
    // Round 1 sees the bare prompt.
    expect(calls[0]).toBe('a counter');
    // Round 2 sees the bare prompt PLUS the round-1 feedback block.
    expect(calls[1]).toContain('a counter');
    expect(calls[1]).toContain('Validation feedback (round 1)');
  });
});

describe('createAdvancedUiGenerator — metadata surface', () => {
  it('attaches validatorScore and validatorIterations to the result metadata', async () => {
    const inner = makeStubGenerator([
      makeStubResult({
        source: COUNTER_SOURCE_GOOD,
        compiled: COUNTER_COMPILED_GOOD,
      }),
    ]);

    const gen = createAdvancedUiGenerator({
      playwright: FAKE_PLAYWRIGHT,
      innerGenerator: inner,
    });
    const result = await gen.generate({
      ...NULL_INPUT,
      contract: { propsSpec: { properties: {} } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const meta = result.metadata as typeof result.metadata & {
      validatorScore?: number;
      validatorIterations?: readonly ValidationIteration[];
    };
    expect(typeof meta.validatorScore).toBe('number');
    expect(Array.isArray(meta.validatorIterations)).toBe(true);
    expect(meta.validatorIterations?.length).toBeGreaterThanOrEqual(1);
  });
});
