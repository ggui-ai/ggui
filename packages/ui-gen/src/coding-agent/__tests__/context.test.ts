import { describe, it, expect, beforeEach } from 'vitest';
import { AgentWorkspace } from '../workspace';
import {
  buildStaticContext,
  serializeInitialContext,
  buildDynamicContext,
  serializeFixLoopContext,
} from '../context';
import type { CodingAgentInput, CommitMetadata } from '../types';

function makeInput(overrides?: Partial<CodingAgentInput>): CodingAgentInput {
  return {
    plan: { spec: 'Build a login form' },
    commitInput: {
      propsSpec: { email: 'string', password: 'string' },
      actionSpec: { onSubmit: '(data) => void' },
    },
    designSystem: 'Tokens: --ggui-color-primary-600',
    criteria: {
      selfCheck: [],
      evaluation: [],
      userRequest: 'Create a login form',
    },
    llmCaller: async () => ({ toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }),
    model: 'test-model',
    ...overrides,
  };
}

describe('serializeInitialContext', () => {
  it('renders plan, design system, contract, and criteria', () => {
    const input = makeInput();
    const staticCtx = buildStaticContext(input);
    const result = serializeInitialContext(staticCtx);
    expect(result).toContain('Build a login form');
    expect(result).toContain('--ggui-color-primary-600');
    expect(result).toContain('email');
    expect(result).toContain('onSubmit');
    expect(result).toContain('Create a login form');
  });

  it('includes evaluation feedback when present', () => {
    const input = makeInput({ evaluationFeedback: 'Needs better spacing' });
    const staticCtx = buildStaticContext(input);
    const result = serializeInitialContext(staticCtx);
    expect(result).toContain('Needs better spacing');
  });

  it('omits evaluation feedback section when absent', () => {
    const input = makeInput();
    const staticCtx = buildStaticContext(input);
    const result = serializeInitialContext(staticCtx);
    expect(result).not.toContain('Evaluation Feedback');
  });
});

describe('buildDynamicContext', () => {
  let ws: AgentWorkspace;
  const commitMeta: Map<string, CommitMetadata> = new Map();

  beforeEach(async () => {
    ws = new AgentWorkspace();
    await ws.init();
    commitMeta.clear();
  });

  it('returns null currentFile when no file exists', async () => {
    const ctx = await buildDynamicContext(ws, commitMeta);
    expect(ctx.currentFile).toContain('no file');
  });

  it('returns recent section with full diff for 1 commit', async () => {
    ws.write('const x = 1;\n');
    const oid = await ws.commit('initial');
    commitMeta.set(oid, {
      build: { success: true },
      selfCheck: { passed: true, violations: [] },
    });

    const ctx = await buildDynamicContext(ws, commitMeta);
    expect(ctx.recentCommits.length).toBe(1);
    expect(ctx.recentCommits[0].message).toContain('initial');
    expect(ctx.recentCommits[0].status).toBe('PASS');
  });

  it('returns 2 recent + 1 older for 3 commits', async () => {
    ws.write('v1\n');
    const oid1 = await ws.commit('first');
    commitMeta.set(oid1, { build: { success: true }, selfCheck: { passed: true, violations: [] } });

    ws.write('v2\n');
    const oid2 = await ws.commit('second');
    commitMeta.set(oid2, { build: { success: true }, selfCheck: { passed: true, violations: [] } });

    ws.write('v3\n');
    const oid3 = await ws.commit('third');
    commitMeta.set(oid3, { build: { success: false }, selfCheck: { passed: false, violations: ['error'] } });

    const ctx = await buildDynamicContext(ws, commitMeta);
    expect(ctx.recentCommits.length).toBe(2);
    expect(ctx.olderCommits.length).toBe(1);
    expect(ctx.olderCommits[0]).toContain('first');
  });
});

describe('serializeFixLoopContext', () => {
  let ws: AgentWorkspace;
  const commitMeta: Map<string, CommitMetadata> = new Map();

  beforeEach(async () => {
    ws = new AgentWorkspace();
    await ws.init();
    commitMeta.clear();
  });

  it('renders file with line numbers and history', async () => {
    ws.write('const x = 1;\nconst y = 2;\n');
    const oid = await ws.commit('initial');
    commitMeta.set(oid, {
      build: { success: true },
      selfCheck: { passed: false, violations: ['missing aria-label'] },
    });

    const input = makeInput();
    const staticCtx = buildStaticContext(input);
    const dynamicCtx = await buildDynamicContext(ws, commitMeta);
    const result = serializeFixLoopContext(staticCtx, dynamicCtx);

    // Should contain numbered file
    expect(result).toContain('1│');
    expect(result).toContain('const x = 1;');
    // Should contain commit info
    expect(result).toContain('initial');
    expect(result).toContain('FAIL');
    // Should contain contract reminder
    expect(result).toContain('email');
  });

  it('uses right-aligned line number padding', async () => {
    // 10+ lines to test padding
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    ws.write(lines.join('\n') + '\n');
    await ws.commit('multiline');

    const dynamicCtx = await buildDynamicContext(ws, commitMeta);
    const result = serializeFixLoopContext(buildStaticContext(makeInput()), dynamicCtx);
    // Line 1 should be padded: " 1│" (space before 1)
    expect(result).toContain(' 1│');
    expect(result).toContain('12│');
  });
});
