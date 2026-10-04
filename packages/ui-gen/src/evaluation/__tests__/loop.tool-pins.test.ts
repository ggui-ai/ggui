/**
 * ggui#1714 — the fix round's resumed `query()` gets the same tool surface as
 * the adapter: no CLI built-ins unless opted in, no host settings, no
 * permission bypass — and its source is read from the bridged compile tool,
 * by the same rule as the adapter. Asserted on what the SDK receives and what
 * the loop returns; nothing spawns.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { EvaluationResult } from '../types.js';

const seen = vi.hoisted(() => ({ options: [] as Options[], round: 0, stream: [] as object[] }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Options }) => {
    seen.options.push(args.options);
    return (async function* () {
      yield* seen.stream;
    })();
  },
}));
vi.mock('../evaluator', () => ({
  // A failing first round forces one fix round; the second passes.
  runEvaluation: async (): Promise<EvaluationResult> => {
    seen.round++;
    const passed = seen.round > 1;
    const score = passed ? 90 : 10;
    return {
      passed,
      finalScore: score,
      dimensions: { completeness: score, visualPolish: score, interactivity: score, accessibility: score, codeQuality: score },
      issues: [],
    };
  },
}));

import { runEvaluationLoop } from '../loop.js';

const run = (generatorOptions: Parameters<typeof runEvaluationLoop>[0]['generatorOptions']) =>
  runEvaluationLoop({
    generatorSessionId: 'session-1',
    context: { sourceCode: 's', compiledCode: 'c', originalPrompt: 'p', themeTokens: '' },
    config: { enabled: true, passThreshold: 70, maxRounds: 2 },
    generatorOptions,
  });

describe('runEvaluationLoop — fix-round tool surface (ggui#1714)', () => {
  afterEach(() => {
    seen.options.length = 0;
    seen.round = 0;
    seen.stream.length = 0;
  });

  it('resumes the session with no built-ins, no host settings and no bypass; the servers it is given are approved', async () => {
    await run({ env: {}, mcpServers: { ggui: { type: 'stdio', command: 'node' } } });
    expect(seen.options).toHaveLength(1);
    const o = seen.options[0]!;
    expect(o.resume).toBe('session-1');
    expect(o.tools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.allowedTools).toEqual(['mcp__ggui']);
    expect(o.permissionMode).toBeUndefined();
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it('built-ins are an opt-in', async () => {
    await run({ env: {}, allowedTools: ['mcp__ggui__compile_component'], builtinTools: ['Write'] });
    const o = seen.options[0]!;
    expect(o.tools).toEqual(['Write']);
    expect(o.allowedTools).toEqual(['mcp__ggui__compile_component', 'Write']);
  });

  it('with no built-in Write, the fixed source comes from the bridged compile_component call, beside its compiled code', async () => {
    seen.stream.push(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__ggui__compile_component', input: { code: 'fixed source' } }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: JSON.stringify({ success: true, compiledCode: 'fixed compiled' }) }] }] },
      },
    );
    const result = await run({ env: {}, mcpServers: { ggui: { type: 'stdio', command: 'node' } } });
    expect(result.finalCode).toBe('fixed compiled');
    expect(result.finalSourceCode).toBe('fixed source');
  });

  it('refuses, before any evaluation, a fix loop that offers no tool able to return code', async () => {
    await expect(run({ env: {} })).rejects.toThrow(/needs a tool that can return code/);
    expect(seen.round).toBe(0);
    expect(seen.options).toHaveLength(0);
  });

  it('a single-round loop never fixes, so it needs no tool', async () => {
    const result = await runEvaluationLoop({
      generatorSessionId: 'session-1',
      context: { sourceCode: 's', compiledCode: 'c', originalPrompt: 'p', themeTokens: '' },
      config: { enabled: true, passThreshold: 70, maxRounds: 1 },
    });
    expect(result.finalCode).toBe('c');
    expect(seen.options).toHaveLength(0);
  });
});
