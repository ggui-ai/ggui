import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenRouterRawAdapter } from './raw';
import type { ToolDefinition } from '../types';
import { z } from 'zod';

// Mock the client module
const mockChatCompletion = vi.fn();
vi.mock('./client', () => ({
  OpenRouterClient: vi.fn().mockImplementation(() => ({
    chatCompletion: mockChatCompletion,
  })),
}));

function makeCompileTool(): ToolDefinition {
  return {
    name: 'compile_component',
    description: 'Compile TSX to JS',
    inputSchema: z.object({ code: z.string() }),
    handler: async (args) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true, compiledCode: `compiled: ${(args as { code: string }).code}` }) }],
    }),
  };
}

describe('OpenRouterRawAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
  });

  it('isAvailable returns true when OPENROUTER_API_KEY is set', () => {
    const adapter = new OpenRouterRawAdapter();
    expect(adapter.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when no key', () => {
    delete process.env.OPENROUTER_API_KEY;
    const adapter = new OpenRouterRawAdapter();
    expect(adapter.isAvailable()).toBe(false);
  });

  it('has correct provider and mode', () => {
    const adapter = new OpenRouterRawAdapter();
    expect(adapter.provider).toBe('openrouter');
    expect(adapter.mode).toBe('raw');
    expect(adapter.displayName).toBe('OpenRouter (Raw API)');
  });

  it('resolves model ID by stripping first prefix', () => {
    const adapter = new OpenRouterRawAdapter();
    expect(adapter.resolveModelId('openrouter/anthropic/claude-3.5-sonnet')).toBe('anthropic/claude-3.5-sonnet');
  });

  it('generates code through tool loop', async () => {
    const adapter = new OpenRouterRawAdapter();
    const compileTool = makeCompileTool();

    // Turn 1: LLM calls compile_component
    mockChatCompletion.mockResolvedValueOnce({
      id: 'gen-1',
      model: 'anthropic/claude-3.5-sonnet',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-1',
            type: 'function',
            function: { name: 'compile_component', arguments: JSON.stringify({ code: 'const App = () => <div>Hello</div>' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    // Turn 2: LLM finishes
    mockChatCompletion.mockResolvedValueOnce({
      id: 'gen-2',
      model: 'anthropic/claude-3.5-sonnet',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Done!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
    });

    const result = await adapter.generate({
      systemPrompt: 'You are a UI generator.',
      userPrompt: 'Build a hello world component.',
      model: 'anthropic/claude-3.5-sonnet',
      tools: [compileTool],
      maxTurns: 10,
    });

    expect(result.compiledCode).toContain('compiled:');
    expect(result.tokens.input).toBe(300);
    expect(result.tokens.output).toBe(80);
    expect(result.turnsUsed).toBe(2);
  });

  it('tracks cache tokens', async () => {
    const adapter = new OpenRouterRawAdapter();
    const compileTool = makeCompileTool();

    mockChatCompletion.mockResolvedValueOnce({
      id: 'gen-1',
      model: 'anthropic/claude-3.5-sonnet',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-1',
            type: 'function',
            function: { name: 'compile_component', arguments: JSON.stringify({ code: 'export default () => <div/>' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {
        prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
        cache_creation_input_tokens: 80,
        cache_read_input_tokens: 20,
      },
    });

    mockChatCompletion.mockResolvedValueOnce({
      id: 'gen-2',
      model: 'anthropic/claude-3.5-sonnet',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    const result = await adapter.generate({
      systemPrompt: 'test',
      userPrompt: 'test',
      model: 'anthropic/claude-3.5-sonnet',
      tools: [compileTool],
      maxTurns: 10,
    });

    expect(result.cacheCreationTokens).toBe(80);
    expect(result.cacheReadTokens).toBe(20);
  });
});
