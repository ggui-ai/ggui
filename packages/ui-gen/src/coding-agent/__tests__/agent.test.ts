import { describe, it, expect } from 'vitest';
import { runCodingAgent } from '../agent';
import type { CodingAgentInput, LLMCaller, ToolCall } from '../types';

// Valid TSX that passes self-check + esbuild
const VALID_CODE = `interface Props {
  name: string;
}

export default function Hello(props: Props) {
  return (
    <div style={{ color: 'var(--ggui-color-primary-600)', padding: 'var(--ggui-spacing-md, 16px)' }}>
      <span aria-label="greeting">{props.name}</span>
    </div>
  );
}`;

// Code with a self-check violation (eval() — a fail-level security violation)
const CODE_WITH_VIOLATION = `interface Props {
  name: string;
}

export default function Hello(props: Props) {
  const x = eval("1+1");
  return <div style={{ color: 'var(--ggui-color-error-600)' }}>{props.name}{x}</div>;
}`;

// Fixed version
const FIXED_CODE = `interface Props {
  name: string;
}

export default function Hello(props: Props) {
  return (
    <div style={{ color: 'var(--ggui-color-error-600)', padding: 'var(--ggui-spacing-md, 16px)' }}>
      <span aria-label="greeting">{props.name}</span>
    </div>
  );
}`;

function makeInput(llmCaller: LLMCaller): CodingAgentInput {
  return {
    plan: { spec: 'Build a greeting component' },
    commitInput: { propsSpec: { name: 'string' } },
    designSystem: 'Tokens: --ggui-color-primary-600, --ggui-spacing-md',
    criteria: { selfCheck: [], evaluation: [], userRequest: 'Build a greeting component' },
    llmCaller,
    model: 'test-model',
    maxTurns: 5,
  };
}

function createMockLLMCaller(responses: ToolCall[][]): LLMCaller {
  let callIndex = 0;
  return async () => {
    const toolCalls = responses[callIndex] ?? [];
    callIndex++;
    return { toolCalls, usage: { inputTokens: 100, outputTokens: 50 } };
  };
}

describe('runCodingAgent', () => {
  it('happy path: write auto-commits and passes in 1 turn', async () => {
    const llmCaller = createMockLLMCaller([
      [{ tool: 'write', input: { code: VALID_CODE, commit_message: 'feat: hello' } }],
    ]);

    const result = await runCodingAgent(makeInput(llmCaller));
    expect(result.sourceCode).toContain('Hello');
    expect(result.compiledCode.length).toBeGreaterThan(0);
    expect(result.metrics.turns).toBe(1);
    expect(result.trace.outcome).toBe('success');
  });

  it('fix loop: write fails self-check, second write passes', async () => {
    const llmCaller = createMockLLMCaller([
      [{ tool: 'write', input: { code: CODE_WITH_VIOLATION, commit_message: 'feat: initial' } }],
      [{ tool: 'write', input: { code: FIXED_CODE, commit_message: 'fix: design tokens' } }],
    ]);

    const result = await runCodingAgent(makeInput(llmCaller));
    expect(result.metrics.turns).toBe(2);
    expect(result.sourceCode).toContain('var(--ggui-color-error-600)');
  });

  it('max turns exceeded returns best-effort result', async () => {
    const llmCaller = createMockLLMCaller(
      Array(5).fill([
        { tool: 'write', input: { code: CODE_WITH_VIOLATION, commit_message: 'attempt' } },
      ]),
    );

    const input = makeInput(llmCaller);
    input.maxTurns = 3;

    const result = await runCodingAgent(input);
    expect(result.metrics.maxTurnsExceeded).toBe(true);
    expect(result.sourceCode.length).toBeGreaterThan(0);
  });

  it('onProgress fires events', async () => {
    const events: unknown[] = [];
    const llmCaller = createMockLLMCaller([
      [{ tool: 'write', input: { code: VALID_CODE, commit_message: 'feat: hello' } }],
    ]);

    const input = makeInput(llmCaller);
    input.onProgress = (event) => events.push(event);

    await runCodingAgent(input);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e: unknown) => (e as { type: string }).type === 'turn_start')).toBe(true);
  });

  it('trace has correct token breakdown', async () => {
    const llmCaller = createMockLLMCaller([
      [{ tool: 'write', input: { code: VALID_CODE, commit_message: 'feat: hello' } }],
    ]);

    const result = await runCodingAgent(makeInput(llmCaller));
    expect(result.metrics.tokens.input).toBe(100);
    expect(result.metrics.tokens.output).toBe(50);
    expect(result.trace.tokenBreakdown.perTurn).toHaveLength(1);
  });

  it('commit history is populated', async () => {
    const llmCaller = createMockLLMCaller([
      [{ tool: 'write', input: { code: VALID_CODE, commit_message: 'feat: hello' } }],
    ]);

    const result = await runCodingAgent(makeInput(llmCaller));
    expect(result.commitHistory.length).toBeGreaterThan(0);
    expect(result.commitHistory[0].message).toContain('feat: hello');
  });
});

// =============================================================================
// Integration Smoke Test
// =============================================================================

describe('runCodingAgent (smoke)', () => {
  it('full pipeline: realistic component auto-compiles and passes', async () => {
    const realisticCode = `import React, { useState } from 'react';

interface Props {
  title: string;
  items: Array<{ id: string; label: string }>;
  onSelect: (id: string) => void;
}

export default function ItemList(props: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  const handleClick = (id: string) => {
    setSelected(id);
    props.onSelect(id);
  };

  return (
    <div style={{
      padding: 'var(--ggui-spacing-lg, 24px)',
      borderRadius: 'var(--ggui-shape-radius-md, 8px)',
      backgroundColor: 'var(--ggui-color-surface, #ffffff)',
    }}>
      <h2 style={{
        color: 'var(--ggui-color-onSurface, #1a1a1a)',
        marginBottom: 'var(--ggui-spacing-md, 16px)',
      }}>
        {props.title}
      </h2>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {props.items.map((item) => (
          <li
            key={item.id}
            aria-label={item.label}
            onClick={() => handleClick(item.id)}
            style={{
              padding: 'var(--ggui-spacing-sm, 8px)',
              cursor: 'pointer',
              backgroundColor: selected === item.id
                ? 'var(--ggui-color-primaryContainer, #e0f2fe)'
                : 'transparent',
              borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
            }}
          >
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}`;

    const llmCaller = createMockLLMCaller([
      [{ tool: 'write', input: { code: realisticCode, commit_message: 'feat: item list' } }],
    ]);

    const input = makeInput(llmCaller);
    const result = await runCodingAgent(input);

    expect(result.sourceCode).toContain('ItemList');
    expect(result.compiledCode.length).toBeGreaterThan(0);
    expect(result.compiledCode).not.toContain('interface Props');
    expect(result.metrics.turns).toBe(1);
    expect(result.trace.outcome).toBe('success');
  });
});
