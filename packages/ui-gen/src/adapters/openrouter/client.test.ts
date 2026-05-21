import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenRouterClient } from './client';
import type { OpenRouterChatResponse } from './types';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

describe('OpenRouterClient', () => {
  let client: OpenRouterClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new OpenRouterClient({ apiKey: 'sk-or-test-key' });
  });

  it('sends correct headers', async () => {
    const response: OpenRouterChatResponse = {
      id: 'gen-1',
      model: 'anthropic/claude-3.5-sonnet',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

    await client.chatCompletion({
      model: 'anthropic/claude-3.5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(options.headers['Authorization']).toBe('Bearer sk-or-test-key');
    expect(options.headers['HTTP-Referer']).toBe('https://ggui.ai');
    expect(options.headers['X-Title']).toBe('ggui');
  });

  it('passes thinking params through', async () => {
    const response: OpenRouterChatResponse = {
      id: 'gen-2',
      model: 'anthropic/claude-3.5-sonnet',
      choices: [{ index: 0, message: { role: 'assistant', content: 'thought', thinking: 'internal' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

    const result = await client.chatCompletion({
      model: 'anthropic/claude-3.5-sonnet',
      messages: [{ role: 'user', content: 'think about this' }],
      thinking: { type: 'enabled', budget_tokens: 1024 },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(result.choices[0].message.thinking).toBe('internal');
  });

  it('passes tools in OpenAI-compatible format', async () => {
    const response: OpenRouterChatResponse = {
      id: 'gen-3',
      model: 'openai/gpt-5.4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

    const result = await client.chatCompletion({
      model: 'openai/gpt-5.4',
      messages: [{ role: 'user', content: 'weather in SF' }],
      tools: [{
        type: 'function',
        function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
      }],
    });

    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
  });

  it('throws OpenRouterError on 401', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: { message: 'Invalid key' } }, 401));

    await expect(client.chatCompletion({
      model: 'test/model',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow('Invalid key');
  });

  it('throws OpenRouterError on 402 (insufficient credits)', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: { message: 'Insufficient credits' } }, 402));

    await expect(client.chatCompletion({
      model: 'test/model',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow('Insufficient credits');
  });

  it('includes cache token counts when present', async () => {
    const response: OpenRouterChatResponse = {
      id: 'gen-4',
      model: 'anthropic/claude-3.5-sonnet',
      choices: [{ index: 0, message: { role: 'assistant', content: 'cached' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cache_creation_input_tokens: 80,
        cache_read_input_tokens: 20,
      },
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

    const result = await client.chatCompletion({
      model: 'anthropic/claude-3.5-sonnet',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.usage.cache_creation_input_tokens).toBe(80);
    expect(result.usage.cache_read_input_tokens).toBe(20);
  });

  it('uses custom baseUrl when provided', async () => {
    const customClient = new OpenRouterClient({
      apiKey: 'sk-or-test',
      baseUrl: 'https://custom.openrouter.ai/api/v1',
    });
    const response: OpenRouterChatResponse = {
      id: 'gen-5',
      model: 'test/model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

    await customClient.chatCompletion({
      model: 'test/model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(mockFetch.mock.calls[0][0]).toBe('https://custom.openrouter.ai/api/v1/chat/completions');
  });
});
