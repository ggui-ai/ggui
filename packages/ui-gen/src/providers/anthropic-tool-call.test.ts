/**
 * ggui#1271 — the ONE Anthropic structured (tool-use) call. The
 * negotiator's production caller, the live probes' judge and the
 * negotiator's dev caller all go through `anthropicToolCall`; these
 * tests pin the request shape it sends and the named failure it throws.
 */
import { describe, expect, it } from 'vitest';
import {
  ALWAYS_THINKING_HEADROOM_TOKENS,
  AnthropicStructuredCallError,
  anthropicToolCall,
} from './anthropic-tool-call.js';

const TOOL = {
  name: 'submit_decision',
  description: 'Submit your decision.',
  input_schema: { type: 'object', properties: { matchId: { type: ['string', 'null'] } } },
};

interface SentRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: {
    readonly model: string;
    readonly max_tokens: number;
    readonly system: string;
    readonly messages: readonly { readonly role: string; readonly content: string }[];
    readonly tools: readonly { readonly name: string }[];
    readonly tool_choice: { readonly type: string; readonly name?: string; readonly disable_parallel_tool_use?: boolean };
  };
  readonly signal: AbortSignal | undefined;
}

function fakeFetch(status: number, body: unknown, sent: SentRequest[]): typeof globalThis.fetch {
  return async (input, init) => {
    sent.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)) as SentRequest['body'],
      signal: init?.signal ?? undefined,
    });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
}

function messages(content: object[], stopReason: string, usage?: unknown): object {
  return { type: 'message', content, stop_reason: stopReason, ...(usage !== undefined ? { usage } : {}) };
}

const TOOL_USE = { type: 'tool_use', id: 'toolu_1', name: TOOL.name, input: { matchId: 'bp-1' } };

function call(model: string, fetchImpl: typeof globalThis.fetch, maxTokens?: number, signal?: AbortSignal) {
  return anthropicToolCall({
    apiKey: 'sk-ant-test',
    model,
    systemPrompt: 'sys',
    userPrompt: 'user',
    tool: TOOL,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(signal !== undefined ? { signal } : {}),
    fetch: fetchImpl,
  });
}

describe('anthropicToolCall — the request it sends', () => {
  it('a model that accepts a forced tool: the forced tool, the caller budget, the caller system prompt', async () => {
    const sent: SentRequest[] = [];
    await call('claude-haiku-4-5-20251001', fakeFetch(200, messages([TOOL_USE], 'tool_use'), sent), 512);
    expect(sent[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent[0]?.headers['x-api-key']).toBe('sk-ant-test');
    expect(sent[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(sent[0]?.body.model).toBe('claude-haiku-4-5-20251001');
    expect(sent[0]?.body.tool_choice).toEqual({ type: 'tool', name: TOOL.name });
    expect(sent[0]?.body.max_tokens).toBe(512);
    expect(sent[0]?.body.system).toBe('sys');
    expect(sent[0]?.body.messages).toEqual([{ role: 'user', content: 'user' }]);
    expect(sent[0]?.body.tools.map((t) => t.name)).toEqual([TOOL.name]);
  });

  it('a model that refuses a forced tool: auto + one call + the tool named + headroom on top of the budget', async () => {
    const sent: SentRequest[] = [];
    await call('claude-fable-5-1', fakeFetch(200, messages([TOOL_USE], 'tool_use'), sent), 512);
    expect(sent[0]?.body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(sent[0]?.body.max_tokens).toBe(512 + ALWAYS_THINKING_HEADROOM_TOKENS);
    expect(sent[0]?.body.system.startsWith('sys')).toBe(true);
    expect(sent[0]?.body.system).toContain(TOOL.name);
  });

  it('the answer budget defaults to 1024 when the caller names none', async () => {
    const sent: SentRequest[] = [];
    await call('claude-haiku-4-5-20251001', fakeFetch(200, messages([TOOL_USE], 'tool_use'), sent));
    expect(sent[0]?.body.max_tokens).toBe(1024);
  });

  it("forwards the caller's signal to fetch", async () => {
    const sent: SentRequest[] = [];
    const controller = new AbortController();
    await call('claude-haiku-4-5-20251001', fakeFetch(200, messages([TOOL_USE], 'tool_use'), sent), 512, controller.signal);
    expect(sent[0]?.signal).toBe(controller.signal);
  });
});

describe('anthropicToolCall — what it returns', () => {
  it("the named tool's input, with the response's usage", async () => {
    const result = await call(
      'claude-haiku-4-5-20251001',
      fakeFetch(200, messages([TOOL_USE], 'tool_use', { input_tokens: 10, output_tokens: 5 }), []),
    );
    expect(result).toEqual({ input: { matchId: 'bp-1' }, usage: { input: 10, output: 5 } });
  });

  it('a usage block that is not two numbers reports no usage, never zeros', async () => {
    for (const usage of [undefined, { input_tokens: '10', output_tokens: 5 }, { input_tokens: 10 }]) {
      const result = await call('claude-haiku-4-5-20251001', fakeFetch(200, messages([TOOL_USE], 'tool_use', usage), []));
      expect(result).toEqual({ input: { matchId: 'bp-1' } });
    }
  });

  it('skips a tool_use block for another tool name', async () => {
    const other = { ...TOOL_USE, name: 'something_else' };
    await expect(
      call('claude-fable-5-1', fakeFetch(200, messages([other], 'tool_use'), [])),
    ).rejects.toMatchObject({ kind: 'no_tool_call' });
  });
});

describe('anthropicToolCall — every way without the tool input is a NAMED failure', () => {
  const cases: readonly [string, number, unknown, string][] = [
    ['a max_tokens stop before the tool call', 200, messages([{ type: 'thinking', thinking: '' }], 'max_tokens'), 'max_tokens'],
    ['an answer in text', 200, messages([{ type: 'text', text: 'bp-1' }], 'end_turn'), 'no_tool_call'],
    ['a refusal', 200, messages([], 'refusal'), 'refusal'],
    ['a non-2xx', 429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'http'],
    ['a 2xx that is not a Messages response', 200, { hello: 'world' }, 'malformed'],
  ];
  for (const [what, status, body, kind] of cases) {
    it(`${what} → AnthropicStructuredCallError of kind '${kind}', the kind in the message`, async () => {
      const err: unknown = await call('claude-fable-5-1', fakeFetch(status, body, []), 512).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AnthropicStructuredCallError);
      expect(err).toMatchObject({ kind, message: expect.stringContaining(`[${kind}]`) });
    });
  }

  it('the max_tokens failure names the stop reason and the budget it ran out of', async () => {
    await expect(
      call('claude-fable-5-1', fakeFetch(200, messages([], 'max_tokens'), []), 512),
    ).rejects.toThrow(/stop_reason=max_tokens.*max_tokens=16512/);
  });

  it('the http failure carries the status', async () => {
    await expect(
      call('claude-haiku-4-5-20251001', fakeFetch(400, { error: { message: 'bad' } }, []), 512),
    ).rejects.toMatchObject({ kind: 'http', status: 400 });
  });
});
