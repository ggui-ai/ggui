import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseEvalResponse, buildMotherPrompt, runLLMEvaluation } from './llm-evaluator';
import type { LLMEvalContext, LLMEvalConfig, EvalContext, PreWarmedEvalContext } from './llm-evaluator';

// =============================================================================
// Mock LLM router
// =============================================================================

const mockCallTools = vi.fn();
const mockAgent = { callTools: mockCallTools };

vi.mock('../harness/llm-router', () => ({
  createAgent: () => mockAgent,
}));

// =============================================================================
// Helpers
// =============================================================================

/** Pre-warmed context with no dynamic criteria — skips generation call */
const NO_DYNAMIC: PreWarmedEvalContext = {
  motherPrompt: buildMotherPrompt({ originalPrompt: 'test' }),
  dynamicCriteria: [],
};

// =============================================================================
// buildMotherPrompt — unit tests
// =============================================================================

describe('buildMotherPrompt', () => {
  it('includes original prompt', () => {
    const ctx: EvalContext = { originalPrompt: 'Build a task manager' };
    const prompt = buildMotherPrompt(ctx);
    expect(prompt).toContain('Build a task manager');
    expect(prompt).toContain('Original Request');
  });

  it('includes contract when provided', () => {
    const ctx: EvalContext = {
      originalPrompt: 'Build a dashboard',
      contract: { props: { title: { schema: { type: 'string' } } } },
    };
    const prompt = buildMotherPrompt(ctx);
    expect(prompt).toContain('Data Contract');
    expect(prompt).toContain('"title"');
  });

  it('includes design system summary when provided', () => {
    const ctx: EvalContext = {
      originalPrompt: 'Build a form',
      designSystemSummary: 'Dark theme with blue accents',
    };
    const prompt = buildMotherPrompt(ctx);
    expect(prompt).toContain('Design System');
    expect(prompt).toContain('Dark theme with blue accents');
  });

  it('includes all 7 criteria definitions', () => {
    const ctx: EvalContext = { originalPrompt: 'Build something' };
    const prompt = buildMotherPrompt(ctx);
    expect(prompt).toContain('functionality');
    expect(prompt).toContain('crash');
    expect(prompt).toContain('interactivity');
    expect(prompt).toContain('accessibility');
    expect(prompt).toContain('layout');
    expect(prompt).toContain('loading');
    expect(prompt).toContain('visual');
  });

  it('omits contract section when not provided', () => {
    const ctx: EvalContext = { originalPrompt: 'Build a widget' };
    const prompt = buildMotherPrompt(ctx);
    expect(prompt).not.toContain('Data Contract');
  });
});

// =============================================================================
// parseEvalResponse — backward compatibility tests (no LLM needed)
// =============================================================================

describe('parseEvalResponse', () => {
  it('parses tier 1 fail (functionality)', () => {
    const raw = {
      issues: [
        {
          tier: 1,
          result: 'fail',
          category: 'functionality',
          severity: 'critical',
          description: 'Missing search feature requested in prompt',
          fix: 'Add a search input with filtering logic',
        },
      ],
      pass: ['crash', 'interactivity', 'accessibility', 'layout', 'visual'],
    };

    const result = parseEvalResponse(raw);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual({
      tier: 1,
      result: 'fail',
      category: 'functionality',
      severity: 'critical',
      description: 'Missing search feature requested in prompt',
      fix: 'Add a search input with filtering logic',
    });
    expect(result.pass).toContain('crash');
    expect(result.pass).toContain('accessibility');
  });

  it('parses tier 1 fail (crash)', () => {
    const raw = {
      issues: [
        {
          tier: 1,
          result: 'fail',
          category: 'crash',
          severity: 'critical',
          description: 'Destructuring undefined items array',
          fix: 'Add default value: items = []',
        },
      ],
      pass: ['functionality'],
    };

    const result = parseEvalResponse(raw);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].tier).toBe(1);
    expect(result.issues[0].result).toBe('fail');
    expect(result.issues[0].category).toBe('crash');
    expect(result.issues[0].severity).toBe('critical');
  });

  it('parses tier 2 warn (quality issue, optional fix)', () => {
    const raw = {
      issues: [
        {
          tier: 2,
          result: 'warn',
          category: 'accessibility',
          severity: 'major',
          description: 'Image missing alt text',
          fix: 'Add descriptive alt attribute to img element',
        },
      ],
      pass: ['functionality', 'crash', 'interactivity', 'layout', 'visual'],
    };

    const result = parseEvalResponse(raw);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].tier).toBe(2);
    expect(result.issues[0].result).toBe('warn');
    expect(result.issues[0].category).toBe('accessibility');
    expect(result.issues[0].severity).toBe('major');
  });

  it('parses tier 2 fail (promoted quality issue — severe enough to block)', () => {
    const raw = {
      issues: [
        {
          tier: 2,
          result: 'fail',
          category: 'interactivity',
          severity: 'critical',
          description: 'Form has no submit button — users cannot complete the flow',
          fix: 'Add a submit button at the bottom of the form',
        },
      ],
      pass: ['functionality', 'crash', 'accessibility', 'layout', 'visual'],
    };

    const result = parseEvalResponse(raw);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].tier).toBe(2);
    expect(result.issues[0].result).toBe('fail');
    expect(result.issues[0].category).toBe('interactivity');
  });

  it('preserves pass notes', () => {
    const raw = {
      issues: [],
      pass: [
        'functionality',
        'crash',
        'interactivity',
        'accessibility',
        'layout',
        'loading',
        'visual',
      ],
    };

    const result = parseEvalResponse(raw);

    expect(result.issues).toHaveLength(0);
    expect(result.pass).toHaveLength(7);
    expect(result.pass).toContain('functionality');
    expect(result.pass).toContain('crash');
    expect(result.pass).toContain('visual');
  });

  it('empty issues = clean result', () => {
    const raw = {
      issues: [],
      pass: ['functionality', 'crash'],
    };

    const result = parseEvalResponse(raw);

    expect(result.issues).toHaveLength(0);
    expect(result.pass).toEqual(['functionality', 'crash']);
  });

  it('enforces tier 1 for tier 1 categories even if LLM says tier 2', () => {
    const raw = {
      issues: [
        {
          tier: 2, // LLM incorrectly said tier 2
          result: 'warn', // LLM incorrectly said warn
          category: 'functionality',
          description: 'Missing feature',
          fix: 'Add it',
        },
      ],
      pass: [],
    };

    const result = parseEvalResponse(raw);

    // Parser enforces: functionality is always tier 1, always fail
    expect(result.issues[0].tier).toBe(1);
    expect(result.issues[0].result).toBe('fail');
  });

  it('filters out invalid categories', () => {
    const raw = {
      issues: [
        {
          tier: 1,
          result: 'fail',
          category: 'unknown_category',
          description: 'Bad',
          fix: 'Fix',
        },
        {
          tier: 2,
          result: 'warn',
          category: 'layout',
          description: 'Spacing issue',
          fix: 'Use tokens',
        },
      ],
      pass: [],
    };

    const result = parseEvalResponse(raw);

    // Only the valid category survives
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe('layout');
  });

  it('handles multiple issues across tiers', () => {
    const raw = {
      issues: [
        {
          tier: 1,
          result: 'fail',
          category: 'functionality',
          severity: 'critical',
          description: 'Missing pagination',
          fix: 'Add page controls',
        },
        {
          tier: 2,
          result: 'warn',
          category: 'visual',
          severity: 'major',
          description: 'Inconsistent border radius',
          fix: 'Use --ggui-shape-radius-md',
        },
        {
          tier: 2,
          result: 'fail',
          category: 'loading',
          severity: 'critical',
          description: 'No loading state for API data',
          fix: 'Add skeleton loader',
        },
      ],
      pass: ['crash', 'accessibility'],
    };

    const result = parseEvalResponse(raw);

    expect(result.issues).toHaveLength(3);

    const functionalityIssue = result.issues.find(i => i.category === 'functionality');
    expect(functionalityIssue!.tier).toBe(1);
    expect(functionalityIssue!.result).toBe('fail');

    const visualIssue = result.issues.find(i => i.category === 'visual');
    expect(visualIssue!.tier).toBe(2);
    expect(visualIssue!.result).toBe('warn');

    const loadingIssue = result.issues.find(i => i.category === 'loading');
    expect(loadingIssue!.tier).toBe(2);
    expect(loadingIssue!.result).toBe('fail');

    expect(result.pass).toEqual(['crash', 'accessibility']);
  });

  it('defaults severity based on tier when not provided', () => {
    const raw = {
      issues: [
        {
          tier: 1,
          result: 'fail',
          category: 'crash',
          description: 'Undefined access',
          fix: 'Add null check',
        },
        {
          tier: 2,
          result: 'warn',
          category: 'layout',
          description: 'Tight spacing',
          fix: 'Add margin',
        },
      ],
      pass: [],
    };

    const result = parseEvalResponse(raw);

    expect(result.issues[0].severity).toBe('critical'); // tier 1 defaults to critical
    expect(result.issues[1].severity).toBe('major'); // tier 2 defaults to major
  });

  it('handles missing issues and pass arrays gracefully', () => {
    const raw = {};

    const result = parseEvalResponse(raw);

    expect(result.issues).toHaveLength(0);
    expect(result.pass).toHaveLength(0);
  });
});

// =============================================================================
// runLLMEvaluation — parallel per-criterion tests (mocked LLM)
// =============================================================================

describe('runLLMEvaluation', () => {
  const context: LLMEvalContext = {
    sourceCode: `
import React from 'react';
import { Button } from '@ggui-ai/design/primitives';

interface Props { title: string; }

export default function MyComponent({ title }: Props) {
  return <div><h1>{title}</h1><Button>Click</Button></div>;
}`,
    originalPrompt: 'Create a dashboard with search and filtering',
  };

  const config: LLMEvalConfig = {
    provider: 'claude',
  };

  beforeEach(() => {
    mockCallTools.mockReset();
  });

  it('makes 7 parallel calls when pre-warmed with no dynamic criteria', async () => {
    // Mock all 7 calls to return pass
    mockCallTools.mockResolvedValue({
      toolCalls: [{
        name: 'evaluate_criterion',
        input: { pass: true },
      }],
      inputTokens: 500,
      outputTokens: 50,
    });

    await runLLMEvaluation(context, config, NO_DYNAMIC);

    // Should have been called 7 times (one per static criterion, no dynamic)
    expect(mockCallTools).toHaveBeenCalledTimes(7);
  });

  it('returns aggregated issues from per-criterion calls', async () => {
    let callIndex = 0;
    mockCallTools.mockImplementation(() => {
      callIndex++;
      // First call (functionality): fail
      if (callIndex === 1) {
        return Promise.resolve({
          toolCalls: [{
            name: 'evaluate_functionality',
            input: { pass: false, issues: ['Missing search feature', 'Missing filtering'] },
          }],
          inputTokens: 500,
          outputTokens: 100,
        });
      }
      // All other calls: pass
      return Promise.resolve({
        toolCalls: [{
          name: 'evaluate_criterion',
          input: { pass: true, result: 'pass' },
        }],
        inputTokens: 500,
        outputTokens: 50,
      });
    });

    const result = await runLLMEvaluation(context, config, NO_DYNAMIC);

    // Should have 2 issues from functionality
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].tier).toBe(1);
    expect(result.issues[0].result).toBe('fail');
    expect(result.issues[0].category).toBe('functionality');
    expect(result.issues[0].description).toBe('Missing search feature');
    expect(result.issues[1].description).toBe('Missing filtering');
  });

  it('returns pass categories for criteria that passed', async () => {
    mockCallTools.mockResolvedValue({
      toolCalls: [{
        name: 'evaluate_criterion',
        input: { pass: true, result: 'pass' },
      }],
      inputTokens: 500,
      outputTokens: 50,
    });

    const result = await runLLMEvaluation(context, config, NO_DYNAMIC);

    // All 7 should pass
    expect(result.pass).toHaveLength(7);
    expect(result.pass).toContain('functionality');
    expect(result.pass).toContain('crash');
    expect(result.pass).toContain('interactivity');
    expect(result.pass).toContain('accessibility');
    expect(result.pass).toContain('layout');
    expect(result.pass).toContain('loading');
    expect(result.pass).toContain('visual');
  });

  it('aggregates token counts from all criterion calls', async () => {
    mockCallTools.mockResolvedValue({
      toolCalls: [{
        name: 'evaluate_criterion',
        input: { pass: true, result: 'pass' },
      }],
      inputTokens: 1000,
      outputTokens: 100,
    });

    const result = await runLLMEvaluation(context, config, NO_DYNAMIC);

    // 7 calls x 1000 input = 7000, 7 calls x 100 output = 700
    expect(result.inputTokens).toBe(7000);
    expect(result.outputTokens).toBe(700);
  });

  it('handles tier 2 warn and fail separately', async () => {
    let callIndex = 0;
    mockCallTools.mockImplementation(() => {
      callIndex++;
      // accessibility (5th call): warn
      if (callIndex === 4) {
        return Promise.resolve({
          toolCalls: [{
            name: 'evaluate_accessibility',
            input: { result: 'warn', issues: ['Missing alt text on image'] },
          }],
          inputTokens: 500,
          outputTokens: 100,
        });
      }
      // interactivity (3rd call): fail
      if (callIndex === 3) {
        return Promise.resolve({
          toolCalls: [{
            name: 'evaluate_interactivity',
            input: { result: 'fail', issues: ['No submit button on form'] },
          }],
          inputTokens: 500,
          outputTokens: 100,
        });
      }
      // All others: pass
      return Promise.resolve({
        toolCalls: [{
          name: 'evaluate_criterion',
          input: { pass: true, result: 'pass' },
        }],
        inputTokens: 500,
        outputTokens: 50,
      });
    });

    const result = await runLLMEvaluation(context, config, NO_DYNAMIC);

    const accessibilityIssues = result.issues.filter(i => i.category === 'accessibility');
    expect(accessibilityIssues).toHaveLength(1);
    expect(accessibilityIssues[0].result).toBe('warn');
    expect(accessibilityIssues[0].tier).toBe(2);

    const interactivityIssues = result.issues.filter(i => i.category === 'interactivity');
    expect(interactivityIssues).toHaveLength(1);
    expect(interactivityIssues[0].result).toBe('fail');
    expect(interactivityIssues[0].tier).toBe(2);
  });

  it('handles LLM errors gracefully — treats failed criterion as pass', async () => {
    let callIndex = 0;
    mockCallTools.mockImplementation(() => {
      callIndex++;
      // First call: error
      if (callIndex === 1) {
        return Promise.reject(new Error('API rate limit exceeded'));
      }
      // All others: pass
      return Promise.resolve({
        toolCalls: [{
          name: 'evaluate_criterion',
          input: { pass: true, result: 'pass' },
        }],
        inputTokens: 500,
        outputTokens: 50,
      });
    });

    const result = await runLLMEvaluation(context, config, NO_DYNAMIC);

    // Should not throw — error criterion treated as pass
    expect(result.issues).toHaveLength(0);
    expect(result.pass).toHaveLength(7); // including the errored criterion
  });

  it('handles missing tool call gracefully', async () => {
    let callIndex = 0;
    mockCallTools.mockImplementation(() => {
      callIndex++;
      // Second call: no tool call returned
      if (callIndex === 2) {
        return Promise.resolve({
          toolCalls: [],
          inputTokens: 500,
          outputTokens: 0,
        });
      }
      return Promise.resolve({
        toolCalls: [{
          name: 'evaluate_criterion',
          input: { pass: true, result: 'pass' },
        }],
        inputTokens: 500,
        outputTokens: 50,
      });
    });

    const result = await runLLMEvaluation(context, config, NO_DYNAMIC);

    // Should handle gracefully — missing tool call = pass
    expect(result.pass).toHaveLength(7);
  });

  it('passes contract to mother prompt when provided', async () => {
    mockCallTools.mockResolvedValue({
      toolCalls: [{
        name: 'evaluate_criterion',
        input: { pass: true, result: 'pass' },
      }],
      inputTokens: 500,
      outputTokens: 50,
    });

    const ctxWithContracts: LLMEvalContext = {
      ...context,
      contract: { props: { items: { schema: { type: 'array' } } } },
    };

    await runLLMEvaluation(ctxWithContracts, config, { ...NO_DYNAMIC, motherPrompt: buildMotherPrompt({ originalPrompt: ctxWithContracts.originalPrompt, contract: ctxWithContracts.contract }) });

    // Verify the system prompt (first arg) includes contract info
    const systemPrompt = mockCallTools.mock.calls[0][1] as string;
    expect(systemPrompt).toContain('Data Contract');
    expect(systemPrompt).toContain('items');
  });

  it('passes designContext to mother prompt', async () => {
    mockCallTools.mockResolvedValue({
      toolCalls: [{
        name: 'evaluate_criterion',
        input: { pass: true, result: 'pass' },
      }],
      inputTokens: 500,
      outputTokens: 50,
    });

    const ctxWithDesign: LLMEvalContext = {
      ...context,
      designContext: 'Enterprise dashboard with dark theme',
    };

    await runLLMEvaluation(ctxWithDesign, config, { ...NO_DYNAMIC, motherPrompt: buildMotherPrompt({ originalPrompt: ctxWithDesign.originalPrompt, designSystemSummary: ctxWithDesign.designContext }) });

    // Verify system prompt includes design context
    const systemPrompt = mockCallTools.mock.calls[0][1] as string;
    expect(systemPrompt).toContain('Enterprise dashboard with dark theme');
    expect(systemPrompt).toContain('Design System');
  });

  it('uses same system prompt for all calls (cacheable)', async () => {
    mockCallTools.mockResolvedValue({
      toolCalls: [{
        name: 'evaluate_criterion',
        input: { pass: true, result: 'pass' },
      }],
      inputTokens: 500,
      outputTokens: 50,
    });

    await runLLMEvaluation(context, config, NO_DYNAMIC);

    // All 7 calls should use the exact same system prompt
    const systemPrompts = mockCallTools.mock.calls.map((c: unknown[]) => c[1]);
    const first = systemPrompts[0];
    for (const sp of systemPrompts) {
      expect(sp).toBe(first);
    }
  });

  it('uses default model for claude provider', async () => {
    mockCallTools.mockResolvedValue({
      toolCalls: [{
        name: 'evaluate_criterion',
        input: { pass: true, result: 'pass' },
      }],
      inputTokens: 100,
      outputTokens: 50,
    });

    await runLLMEvaluation(context, { provider: 'claude' }, NO_DYNAMIC);
    const model = mockCallTools.mock.calls[0][0] as string;
    expect(model).toBe('claude-haiku-4-5-20251001');
  });

  it('uses custom model when provided', async () => {
    mockCallTools.mockResolvedValue({
      toolCalls: [{
        name: 'evaluate_criterion',
        input: { pass: true, result: 'pass' },
      }],
      inputTokens: 100,
      outputTokens: 50,
    });

    await runLLMEvaluation(context, {
      provider: 'openai',
      model: 'gpt-5.4',
    }, NO_DYNAMIC);

    const model = mockCallTools.mock.calls[0][0] as string;
    expect(model).toBe('gpt-5.4');
  });

  it('each criterion call uses a different user prompt', async () => {
    mockCallTools.mockResolvedValue({
      toolCalls: [{
        name: 'evaluate_criterion',
        input: { pass: true, result: 'pass' },
      }],
      inputTokens: 500,
      outputTokens: 50,
    });

    await runLLMEvaluation(context, config, NO_DYNAMIC);

    // Each call should have a distinct user prompt
    const userPrompts = mockCallTools.mock.calls.map((c: unknown[]) => c[2] as string);
    const uniquePrompts = new Set(userPrompts);
    expect(uniquePrompts.size).toBe(7);
  });

  it('each criterion call uses the correct tool definition', async () => {
    mockCallTools.mockResolvedValue({
      toolCalls: [{
        name: 'evaluate_criterion',
        input: { pass: true, result: 'pass' },
      }],
      inputTokens: 500,
      outputTokens: 50,
    });

    await runLLMEvaluation(context, config, NO_DYNAMIC);

    // Check tool names for each call
    const expectedCriteria = [
      'functionality', 'crash',
      'interactivity', 'accessibility', 'layout', 'loading', 'visual',
    ];
    for (let i = 0; i < 7; i++) {
      const tools = mockCallTools.mock.calls[i][3] as Array<{ name: string }>;
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe(`evaluate_${expectedCriteria[i]}`);
    }
  });

  it('tier 1 criterion with pass=false but no issues adds generic issue', async () => {
    let callIndex = 0;
    mockCallTools.mockImplementation(() => {
      callIndex++;
      // First call (functionality): fail with no issues
      if (callIndex === 1) {
        return Promise.resolve({
          toolCalls: [{
            name: 'evaluate_functionality',
            input: { pass: false },
          }],
          inputTokens: 500,
          outputTokens: 50,
        });
      }
      return Promise.resolve({
        toolCalls: [{
          name: 'evaluate_criterion',
          input: { pass: true, result: 'pass' },
        }],
        inputTokens: 500,
        outputTokens: 50,
      });
    });

    const result = await runLLMEvaluation(context, config, NO_DYNAMIC);

    // Should add a generic issue for the failed criterion
    const funcIssues = result.issues.filter(i => i.category === 'functionality');
    expect(funcIssues).toHaveLength(1);
    expect(funcIssues[0].result).toBe('fail');
    expect(funcIssues[0].description).toContain('functionality');
  });
});

// Dynamic criteria tests removed — feature was removed.
