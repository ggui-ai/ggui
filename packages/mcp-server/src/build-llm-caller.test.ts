/**
 * Unit tests for `buildLlmCaller` — Slice 18a.
 *
 * Pins:
 *   - `callStructured` is present when provider is anthropic
 *   - `callStructured` is absent for openai/google/openrouter/bedrock
 *   - `callStructured` hits Anthropic /v1/messages with the correct
 *     headers + tool-use body shape
 *   - Forced tool_choice: `{type:'tool', name}` lands on the wire
 *   - Tool-use response → returns `input` JSON parsed as the caller's T
 *   - Non-2xx response → throws (consumer's collapse-to-null path)
 *   - Missing tool_use block → throws
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLlmCaller } from './llm-backed-negotiator.js';

describe('buildLlmCaller — callStructured wiring', () => {
  it('exposes callStructured on the anthropic provider', () => {
    const caller = buildLlmCaller(
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      { provider: 'anthropic', key: 'sk-test' },
    );
    expect(typeof caller.callStructured).toBe('function');
  });

  it('omits callStructured on every non-anthropic provider', () => {
    const others = ['openai', 'google', 'openrouter', 'bedrock'] as const;
    for (const provider of others) {
      const caller = buildLlmCaller(
        { provider, model: 'gpt-4o' },
        { provider, key: 'sk-test' },
      );
      expect(caller.callStructured, `expected absent on ${provider}`).toBeUndefined();
    }
  });
});

describe('buildLlmCaller — anthropic callStructured wire shape', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('hits /v1/messages with x-api-key + anthropic-version + tool_choice forced', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = vi.fn(async (url, init) => {
      captured.url = String(url);
      captured.init = init;
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_x',
              name: 'submit_decision',
              input: { matchId: 'a', confidence: 0.9, reason: 'ok' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const caller = buildLlmCaller(
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      { provider: 'anthropic', key: 'sk-ant-test' },
    );
    const result = await caller.callStructured!<{
      matchId: string;
      confidence: number;
      reason: string;
    }>(
      'system',
      'user',
      {
        name: 'submit_decision',
        description: 'submit a decision',
        input_schema: { type: 'object', properties: {} },
      },
      512,
    );

    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
    expect((captured.init?.headers as Record<string, string>)['x-api-key']).toBe(
      'sk-ant-test',
    );
    expect(
      (captured.init?.headers as Record<string, string>)['anthropic-version'],
    ).toBe('2023-06-01');

    const sentBody = JSON.parse(captured.init?.body as string) as {
      model: string;
      max_tokens: number;
      temperature?: number;
      system: string;
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ name: string; description: string; input_schema: unknown }>;
      tool_choice: { type: string; name: string };
    };
    expect(sentBody.model).toBe('claude-haiku-4-5');
    expect(sentBody.max_tokens).toBe(512);
    // `temperature` is intentionally NOT sent — the param is deprecated
    // on Haiku 4.5+ (dropped in f300fde58). Pin its absence so a future
    // change doesn't silently re-introduce it.
    expect(sentBody.temperature).toBeUndefined();
    expect(sentBody.system).toBe('system');
    expect(sentBody.messages[0]).toEqual({ role: 'user', content: 'user' });
    expect(sentBody.tools[0]?.name).toBe('submit_decision');
    expect(sentBody.tool_choice).toEqual({
      type: 'tool',
      name: 'submit_decision',
    });

    expect(result).toEqual({
      matchId: 'a',
      confidence: 0.9,
      reason: 'ok',
    });
  });

  it('strips the LiteLLM transport prefix before sending to Anthropic API', async () => {
    // Regression for the negotiator-404 bug: `selection.model` arrives
    // in canonical `<provider>/<model>` form per the model-string-
    // convention principle, but Anthropic's API rejects the prefix
    // with HTTP 404 ("model: anthropic/claude-haiku-4-5"). The
    // negotiator must apply `getUpstreamModelId` before the SDK call,
    // mapping `anthropic/claude-haiku-4-5` → dated id
    // `claude-haiku-4-5-20251001`. Without this strip the negotiator
    // silently degrades to its `bare-create` fallback on every
    // handshake, losing the LLM-backed decision.
    const captured: { body?: string } = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      captured.body = init?.body as string;
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'tool_use',
              name: 'submit',
              input: { ok: true },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const caller = buildLlmCaller(
      { provider: 'anthropic', model: 'anthropic/claude-haiku-4-5' },
      { provider: 'anthropic', key: 'sk' },
    );
    await caller.callStructured!('s', 'u', {
      name: 'submit',
      description: '',
      input_schema: { type: 'object' },
    });
    const body = JSON.parse(captured.body!) as { model: string };
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.model).not.toContain('anthropic/');
  });

  it('defaults max_tokens to 1024 when caller omits the parameter', async () => {
    const captured: { body?: string } = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      captured.body = init?.body as string;
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'tool_use',
              name: 'submit',
              input: {},
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const caller = buildLlmCaller(
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      { provider: 'anthropic', key: 'sk' },
    );
    await caller.callStructured!('s', 'u', {
      name: 'submit',
      description: '',
      input_schema: { type: 'object' },
    });
    const body = JSON.parse(captured.body!) as { max_tokens: number };
    expect(body.max_tokens).toBe(1024);
  });

  it('throws on non-2xx response with provider error text in the message', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('rate limited details', { status: 429 });
    }) as unknown as typeof fetch;

    const caller = buildLlmCaller(
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      { provider: 'anthropic', key: 'sk' },
    );
    await expect(
      caller.callStructured!('s', 'u', {
        name: 'submit',
        description: '',
        input_schema: { type: 'object' },
      }),
    ).rejects.toThrow(/anthropic tool-use HTTP 429.*rate limited/);
  });

  it('throws when the response carries no matching tool_use block', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'no tool here' }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const caller = buildLlmCaller(
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      { provider: 'anthropic', key: 'sk' },
    );
    await expect(
      caller.callStructured!('s', 'u', {
        name: 'submit_decision',
        description: '',
        input_schema: { type: 'object' },
      }),
    ).rejects.toThrow(/missing tool_use block.*submit_decision/);
  });
});
