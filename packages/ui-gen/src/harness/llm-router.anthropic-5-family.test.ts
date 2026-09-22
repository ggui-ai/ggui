/**
 * ggui#710 / #706 — Claude Opus 4.7+ / 5-family capability guards in
 * the Anthropic adapter.
 *
 * The API returns HTTP 400 for a non-default `temperature`/`top_p`/
 * `top_k` on Opus 4.7+ (incl. Fable 5, Fable 5.1, Opus 5, Sonnet 5) and
 * for a FORCED `tool_choice` on Fable 5.1. Capability is the router's:
 * the adapter STRIPS the sampling param / downgrades the tool choice,
 * logs one line, and discloses the EFFECTIVE value on the response
 * (`LLMResponse.sampling`, `LLMToolCallResponse.appliedToolChoice`) so
 * callers keep expressing intent (the benchmark judge panel's
 * `temperature: 0` is a disclosed reproducibility property) and
 * disclosure reads what was applied. Haiku 4.5 is untouched.
 *
 * Strings per ggui#706's verified table (platform.claude.com,
 * 2026-09-02) — never from memory.
 */
import { describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicAgent,
  OpenRouterAgent,
  resolveAnthropicSampling,
} from './llm-router.js';

describe('resolveAnthropicSampling', () => {
  it('passes temperature through on Haiku 4.5 and discloses it as applied', () => {
    expect(resolveAnthropicSampling('claude-haiku-4-5-20251001', 0)).toEqual({
      request: { temperature: 0 },
      applied: { temperature: 0 },
    });
  });

  it('strips temperature on the 5-family with a reason naming model + value', () => {
    const r = resolveAnthropicSampling('anthropic/claude-opus-5', 0);
    expect(r.request).toEqual({});
    expect(r.applied.temperature).toBe('provider-default');
    expect(r.applied.strippedReason).toContain('claude-opus-5');
    expect(r.applied.strippedReason).toContain('temperature=0');
  });

  it('reports provider-default with no reason when the caller passed none', () => {
    expect(resolveAnthropicSampling('claude-fable-5-1', undefined)).toEqual({
      request: {},
      applied: { temperature: 'provider-default' },
    });
  });
});

// ─── Adapter behaviour against a fake SDK client ────────────────────────

interface FakeCreateArgs {
  model: string;
  temperature?: number;
}
interface FakeStreamArgs {
  model: string;
  tool_choice: { type: 'any' | 'auto' };
}

/**
 * AnthropicAgent whose client is a REAL SDK instance with
 * `messages.create` / `messages.stream` replaced by recording fakes —
 * the same technique as `llm-router.call-vision.test.ts`, so no cast is
 * needed to satisfy `createClient(): Promise<Anthropic>`.
 */
class FakeClientAgent extends AnthropicAgent {
  readonly create: ReturnType<typeof vi.fn>;
  readonly stream: ReturnType<typeof vi.fn>;
  private readonly sdkClient: Anthropic;

  constructor() {
    super();
    this.sdkClient = new Anthropic({ apiKey: 'test-key' });
    this.create = vi.fn().mockImplementation((args: FakeCreateArgs) =>
      Promise.resolve({
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'text', text: `ok:${args.model}` }],
      }),
    );
    this.stream = vi.fn().mockImplementation((args: FakeStreamArgs) => ({
      finalMessage: () =>
        Promise.resolve({
          usage: { input_tokens: 10, output_tokens: 5 },
          content:
            args.tool_choice.type === 'any'
              ? [{ type: 'tool_use', id: 't1', name: 'evaluate_x', input: { pass: true } }]
              : [{ type: 'text', text: 'no tool call under auto' }],
        }),
    }));
    vi.spyOn(this.sdkClient.messages, 'create').mockImplementation(this.create);
    vi.spyOn(this.sdkClient.messages, 'stream').mockImplementation(this.stream);
  }

  protected async createClient(): Promise<Anthropic> {
    return this.sdkClient;
  }
}

describe('AnthropicAgent.callText — sampling guard', () => {
  it('strips temperature for claude-fable-5-1 and discloses provider-default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = new FakeClientAgent();

    const res = await agent.callText('anthropic/claude-fable-5-1', 'sys', 'user', 100, 0);

    const args = agent.create.mock.calls[0]?.[0];
    expect(args?.model).toBe('claude-fable-5-1');
    expect(args).not.toHaveProperty('temperature');
    expect(res.sampling?.temperature).toBe('provider-default');
    expect(res.sampling?.strippedReason).toContain('claude-fable-5-1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('temperature=0');
    warn.mockRestore();
  });

  it('passes temperature verbatim for claude-haiku-4-5-20251001 and discloses it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = new FakeClientAgent();

    const res = await agent.callText('claude-haiku-4-5-20251001', 'sys', 'user', 100, 0);

    expect(agent.create.mock.calls[0]?.[0]?.temperature).toBe(0);
    expect(res.sampling).toEqual({ temperature: 0 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reports provider-default when no temperature was requested', async () => {
    const agent = new FakeClientAgent();
    const res = await agent.callText('claude-opus-5', 'sys', 'user');
    expect(agent.create.mock.calls[0]?.[0]).not.toHaveProperty('temperature');
    expect(res.sampling).toEqual({ temperature: 'provider-default' });
  });
});

interface FakeOpenRouterArgs {
  model: string;
  tool_choice: 'required' | 'auto';
}

/** An OpenRouterAgent whose client is a fake `chatCompletion` recorder. */
class FakeOpenRouterAgent extends OpenRouterAgent {
  readonly chatCompletion = vi.fn().mockImplementation((args: FakeOpenRouterArgs) =>
    Promise.resolve({
      choices: [
        {
          message:
            args.tool_choice === 'required'
              ? { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'evaluate_x', arguments: '{}' } }] }
              : { content: 'no tool call under auto', tool_calls: undefined },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  );

  protected override async createClient(): Promise<{ chatCompletion: FakeOpenRouterAgent['chatCompletion'] }> {
    return { chatCompletion: this.chatCompletion };
  }
}

describe('OpenRouterAgent.callTools — the same forced tool_choice guard (ggui#1254)', () => {
  const tool = { name: 'evaluate_x', description: 'x', parameters: { type: 'object' } };

  it("downgrades 'required' to auto for anthropic/claude-opus-5.5 and discloses appliedToolChoice", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = new FakeOpenRouterAgent();

    const res = await agent.callTools('openrouter/anthropic/claude-opus-5.5', 'sys', 'user', [tool], 'required');

    expect(agent.chatCompletion.mock.calls[0]?.[0]?.tool_choice).toBe('auto');
    expect(res.appliedToolChoice).toBe('auto');
    expect(res.toolCalls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("keeps 'required' for a model that accepts it", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = new FakeOpenRouterAgent();

    const res = await agent.callTools('anthropic/claude-haiku-4.5', 'sys', 'user', [tool], 'required');

    expect(agent.chatCompletion.mock.calls[0]?.[0]?.tool_choice).toBe('required');
    expect(res.appliedToolChoice).toBe('required');
    expect(res.toolCalls).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('AnthropicAgent.callTools — forced tool_choice guard', () => {
  const tool = { name: 'evaluate_x', description: 'x', parameters: { type: 'object' } };

  it("downgrades 'required' to auto on Fable 5.1 and discloses appliedToolChoice", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = new FakeClientAgent();

    const res = await agent.callTools('anthropic/claude-fable-5-1', 'sys', 'user', [tool], 'required');

    expect(agent.stream.mock.calls[0]?.[0]?.tool_choice).toEqual({ type: 'auto' });
    expect(res.appliedToolChoice).toBe('auto');
    // A downgraded call may return no tool call — that is the honest
    // outcome the evaluator's criteriaCoverage records as `skipped`.
    expect(res.toolCalls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("downgrades 'required' to auto on Opus 5.5 too (ggui#1254)", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = new FakeClientAgent();

    const res = await agent.callTools('claude-opus-5-5', 'sys', 'user', [tool], 'required');

    expect(agent.stream.mock.calls[0]?.[0]?.tool_choice).toEqual({ type: 'auto' });
    expect(res.appliedToolChoice).toBe('auto');
    warn.mockRestore();
  });

  it("keeps 'required' (tool_choice any) on Haiku 4.5 and Opus 5", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const id of ['claude-haiku-4-5-20251001', 'claude-opus-5']) {
      const agent = new FakeClientAgent();
      const res = await agent.callTools(id, 'sys', 'user', [tool], 'required');
      expect(agent.stream.mock.calls[0]?.[0]?.tool_choice).toEqual({ type: 'any' });
      expect(res.appliedToolChoice).toBe('required');
      expect(res.toolCalls).toHaveLength(1);
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
