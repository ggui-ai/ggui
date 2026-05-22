import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { DataContract } from '@ggui-ai/protocol';
import {
  PlaywrightNotAvailableError,
  validateContractBehavior,
  type PlaywrightModule,
  type ValidateContractBehaviorInput,
} from '../index.js';
import { classifyAction } from '../validate.js';

async function compile(source: string): Promise<string> {
  const result = await build({
    stdin: { contents: source, loader: 'tsx', resolveDir: process.cwd() },
    bundle: false,
    format: 'esm',
    target: 'es2022',
    write: false,
    jsx: 'automatic',
    jsxImportSource: 'react',
    minify: false,
  });
  return result.outputFiles[0]!.text;
}

const playwright: PlaywrightModule = { chromium };

const COUNTER_GOOD_SRC = `
import { useState } from 'react';
import { Button } from '@ggui-ai/design/primitives';

export default function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <span>Count: {count}</span>
      <Button aria-label="Increment count" onClick={() => setCount(c => c + 1)}>
        Add
      </Button>
    </div>
  );
}
`;

const COUNTER_BAD_SRC = `
import { useAction } from '@ggui-ai/wire';
import { Button } from '@ggui-ai/design/primitives';

export default function Counter() {
  const onIncrement = useAction('increment');
  return (
    <div>
      <span>Count: 0</span>
      <Button aria-label="Increment count" onClick={() => { /* dispatched but no local state */ }}>
        Add
      </Button>
    </div>
  );
}
`;

/**
 * Agent-bound counter — fires a dispatch via useAction. With `nextStep`
 * present on the contract, the validator (Option C) expects a dispatch
 * signal and accepts the no-local-state component.
 */
const COUNTER_AGENT_BOUND_SRC = `
import { useAction } from '@ggui-ai/wire';
import { Button } from '@ggui-ai/design/primitives';

export default function Counter() {
  const increment = useAction('increment');
  return (
    <div>
      <span>Count: 0</span>
      <Button aria-label="Increment count" onClick={() => increment({})}>
        Add
      </Button>
    </div>
  );
}
`;

const RENDER_THROW_SRC = `
import { Button } from '@ggui-ai/design/primitives';

export default function Boom() {
  throw new Error('boom');
  return <Button>x</Button>;
}
`;

const NO_BUTTON_SRC = `
export default function NoButton() {
  return <div>just text, no buttons</div>;
}
`;

const CONTEXT_BOUND_CONTRACT: DataContract = {
  actionSpec: {
    increment: { label: 'Add' },
  },
};

const AGENT_BOUND_CONTRACT: DataContract = {
  actionSpec: {
    increment: { label: 'Add', nextStep: 'incrementCounter' },
  },
  agentCapabilities: {
    tools: {
      incrementCounter: { description: 'Increment the counter' },
    },
  },
};

describe('classifyAction (Option C)', () => {
  it('classifies action as context-bound when nextStep is absent', () => {
    expect(classifyAction(CONTEXT_BOUND_CONTRACT, 'increment')).toBe(
      'context-bound',
    );
  });

  it('classifies action as agent-bound when nextStep is present', () => {
    expect(classifyAction(AGENT_BOUND_CONTRACT, 'increment')).toBe(
      'agent-bound',
    );
  });

  it('defaults unknown action to context-bound', () => {
    expect(classifyAction(CONTEXT_BOUND_CONTRACT, 'nope')).toBe(
      'context-bound',
    );
  });
});

describe('validateContractBehavior — missing-Playwright error', () => {
  it('throws PlaywrightNotAvailableError when playwright is undefined', async () => {
    // Bypass the type guard to test the runtime branch — operators using
    // dynamic config (require()/dlopen) may legitimately pass `undefined`.
    const input = {
      componentCode: '',
      contract: CONTEXT_BOUND_CONTRACT,
    } as unknown as ValidateContractBehaviorInput;
    await expect(validateContractBehavior(input)).rejects.toThrow(
      PlaywrightNotAvailableError,
    );
  });

  it('does NOT throw on missing-playwright when actionSpec is empty (short-circuit)', async () => {
    // Empty actionSpec returns early before touching Playwright. This
    // matters for the OSS default install: a contract without actions
    // should never block on a missing browser.
    const result = await validateContractBehavior({
      componentCode: '',
      contract: { actionSpec: {} },
    } as unknown as ValidateContractBehaviorInput);
    expect(result.ok).toBe(true);
  });

  it('error message explains how to enable behavioral validation', () => {
    const err = new PlaywrightNotAvailableError();
    expect(err.message).toContain('Playwright module is required');
    expect(err.message).toContain('playwright-core');
    expect(err.message).toContain('optional peer dependency');
  });
});

describe('validateContractBehavior', () => {
  it('passes for a known-good local-state component (context-bound)', async () => {
    const code = await compile(COUNTER_GOOD_SRC);
    const result = await validateContractBehavior({
      componentCode: code,
      contract: CONTEXT_BOUND_CONTRACT,
      timeoutMs: 2000,
      playwright,
    });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  }, 60_000);

  it('fails action-no-effect for context-bound click that neither dispatches nor mutates DOM', async () => {
    const code = await compile(COUNTER_BAD_SRC);
    const result = await validateContractBehavior({
      componentCode: code,
      contract: CONTEXT_BOUND_CONTRACT,
      timeoutMs: 1000,
      playwright,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]?.kind).toBe('action-no-effect');
    expect(result.failures[0]?.actionName).toBe('increment');
    // The diagnostic should make the classification reason explicit.
    expect(result.failures[0]?.diagnostic).toContain('context-bound');
  }, 60_000);

  it('passes agent-bound counter that dispatches even with no DOM change', async () => {
    // This is the Option C payoff — with `nextStep` set, the validator
    // accepts dispatch-only flow and does not require local DOM mutation.
    const code = await compile(COUNTER_AGENT_BOUND_SRC);
    const result = await validateContractBehavior({
      componentCode: code,
      contract: AGENT_BOUND_CONTRACT,
      timeoutMs: 2000,
      playwright,
    });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  }, 60_000);

  it('fails action-no-effect for agent-bound click that does not dispatch', async () => {
    // Same broken counter (no dispatch in the click handler), but
    // contract says `nextStep` → fails for a different reason than the
    // context-bound case: missing dispatch signal.
    const code = await compile(COUNTER_BAD_SRC);
    const result = await validateContractBehavior({
      componentCode: code,
      contract: AGENT_BOUND_CONTRACT,
      timeoutMs: 1000,
      playwright,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]?.kind).toBe('action-no-effect');
    expect(result.failures[0]?.diagnostic).toContain('agent-bound');
    expect(result.failures[0]?.diagnostic).toContain('dispatch');
  }, 60_000);

  it('fails render-failed for a component that throws on mount', async () => {
    const code = await compile(RENDER_THROW_SRC);
    const result = await validateContractBehavior({
      componentCode: code,
      contract: CONTEXT_BOUND_CONTRACT,
      timeoutMs: 1000,
      playwright,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]?.kind).toBe('render-failed');
  }, 60_000);

  it('fails action-not-rendered when actionSpec is declared but no matching button exists', async () => {
    const code = await compile(NO_BUTTON_SRC);
    const result = await validateContractBehavior({
      componentCode: code,
      contract: CONTEXT_BOUND_CONTRACT,
      timeoutMs: 1000,
      playwright,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]?.kind).toBe('action-not-rendered');
    expect(result.failures[0]?.actionName).toBe('increment');
  }, 60_000);

  it('returns ok with empty failures when no actionSpec is declared', async () => {
    const result = await validateContractBehavior({
      componentCode: await compile(NO_BUTTON_SRC),
      contract: {},
      playwright,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});
