/**
 * Unit tests for useInvoke — drives the streamable invoke protocol with
 * mocked fetch returning synthetic SSE bodies. No network, no jsdom WS.
 *
 * Spec: docs/superpowers/specs/2026-04-13-streamable-invoke-protocol.md
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AppDisplayConfig, ToolUseBlock } from '@ggui-ai/protocol';
import { GguiProvider } from '../../components/GguiProvider';
import { useInvoke } from '../useInvoke';

const APP_ID = 'app_test';
const ENDPOINT_URL = 'https://agent.example.com';

function makeAppConfig(overrides?: Partial<AppDisplayConfig>): AppDisplayConfig {
  return {
    appId: APP_ID,
    name: 'Test App',
    defaultShellType: 'chat',
    themeId: 'ggui',
    designSystemPreset: 'default',
    userAuthMode: 'anonymous',
    endpointUrl: ENDPOINT_URL,
    ...overrides,
  };
}

function wrap(appConfig: AppDisplayConfig | null) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <GguiProvider appId={APP_ID} appConfig={appConfig}>
        {children}
      </GguiProvider>
    );
  };
}

/** Build a Response whose body is a stream of pre-encoded SSE frames. */
function sseResponse(events: unknown[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        const json = JSON.stringify(ev);
        const type = (ev as { type?: string }).type ?? 'message';
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${json}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('useInvoke', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the assistant message from a streamed text + tool_use(ggui_render) sequence', async () => {
    const renderBlock = {
      type: 'tool_use',
      id: 'tool_1',
      name: 'ggui_render',
      input: { componentId: 'cmp_abc' },
    };
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { type: 'message_start', message: { id: 'msg_1', role: 'assistant', model: 'test' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Pulling ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'that up…' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: renderBlock },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: ' done.' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 7 } },
        { type: 'message_stop' },
      ]),
    );

    const onToolUse = vi.fn();
    const { result } = renderHook(() => useInvoke({ onToolUse }), {
      wrapper: wrap(makeAppConfig()),
    });

    await act(async () => {
      await result.current.send('weather please');
    });

    // fetch shape
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${ENDPOINT_URL}/invoke`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Ggui-Protocol-Version']).toBe('1');
    expect(headers['X-Ggui-App-Id']).toBe(APP_ID);
    expect(headers['Accept']).toBe('text/event-stream');
    expect(JSON.parse(init.body as string)).toEqual({
      message: 'weather please',
      history: [],
    });

    // messages shape
    expect(result.current.messages).toHaveLength(2);
    const [user, assistant] = result.current.messages;
    expect(user?.role).toBe('user');
    expect(user?.content).toEqual([{ type: 'text', text: 'weather please' }]);
    expect(assistant?.role).toBe('assistant');
    // adopted message id from message_start
    expect(assistant?.id).toBe('msg_1');
    expect(assistant?.isStreaming).toBe(false);
    expect(assistant?.content).toHaveLength(3);
    expect(assistant?.content[0]).toEqual({ type: 'text', text: 'Pulling that up…' });
    expect(assistant?.content[1]?.type).toBe('tool_use');
    expect(assistant?.content[2]).toEqual({ type: 'text', text: ' done.' });

    // onToolUse callback fired with the tool_use block
    expect(onToolUse).toHaveBeenCalledTimes(1);
    const forwarded = onToolUse.mock.calls[0]?.[0] as ToolUseBlock;
    expect(forwarded.name).toBe('ggui_render');
    expect(forwarded.input).toEqual({ componentId: 'cmp_abc' });

    // streaming flag returned to false
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('forwards conversation history on the second turn (excluding the in-flight assistant)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          { type: 'message_start', message: { id: 'msg_a', role: 'assistant' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi back' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 2 } },
          { type: 'message_stop' },
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          { type: 'message_start', message: { id: 'msg_b', role: 'assistant' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sure' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 2 } },
          { type: 'message_stop' },
        ]),
      );

    const { result } = renderHook(() => useInvoke(), { wrapper: wrap(makeAppConfig()) });

    await act(async () => {
      await result.current.send('hi');
    });
    await act(async () => {
      await result.current.send('and again');
    });

    const secondCall = fetchMock.mock.calls[1]![1];
    const body = JSON.parse(secondCall.body as string);
    expect(body.message).toBe('and again');
    expect(body.history).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] },
    ]);
  });

  it('surfaces an error frame as the hook error and stops streaming', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { type: 'message_start', message: { id: 'msg_x', role: 'assistant' } },
        { type: 'error', error: { code: 'upstream_error', message: 'LLM down' } },
      ]),
    );
    const onError = vi.fn();
    const { result } = renderHook(() => useInvoke({ onError }), {
      wrapper: wrap(makeAppConfig()),
    });

    await act(async () => {
      await result.current.send('hi');
    });

    expect(result.current.error).toEqual({ code: 'upstream_error', message: 'LLM down' });
    expect(onError).toHaveBeenCalledWith({ code: 'upstream_error', message: 'LLM down' });
    expect(result.current.isStreaming).toBe(false);
    // assistant placeholder still present but marked done
    const assistant = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistant?.isStreaming).toBe(false);
  });

  it('returns retryAfterMs when the server responds 409 invoke_in_progress', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 'invoke_in_progress', message: 'busy', retryAfterMs: 2_500 } }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { result } = renderHook(() => useInvoke(), { wrapper: wrap(makeAppConfig()) });

    await act(async () => {
      await result.current.send('hi');
    });

    expect(result.current.error).toEqual({
      code: 'invoke_in_progress',
      message: 'busy',
      retryAfterMs: 2_500,
    });
  });

  it('refuses to send when endpointUrl is missing and reports a clear error', async () => {
    const config = makeAppConfig();
    delete config.endpointUrl;
    const onError = vi.fn();
    const { result } = renderHook(() => useInvoke({ onError }), { wrapper: wrap(config) });

    await act(async () => {
      await result.current.send('hi');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.error?.message).toMatch(/endpointUrl/);
    expect(onError).toHaveBeenCalled();
  });

  it('reset clears messages, error, and aborts any in-flight turn', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { type: 'message_start', message: { id: 'msg_1', role: 'assistant' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
    );

    const { result } = renderHook(() => useInvoke(), { wrapper: wrap(makeAppConfig()) });
    await act(async () => {
      await result.current.send('hi');
    });
    expect(result.current.messages.length).toBeGreaterThan(0);

    act(() => {
      result.current.reset();
    });
    await waitFor(() => {
      expect(result.current.messages).toEqual([]);
      expect(result.current.error).toBeNull();
      expect(result.current.isStreaming).toBe(false);
    });
  });

  // ── initialMessages (Task 1.1) ─────────────────────────────────────

  it('seeds messages state on mount from initialMessages', () => {
    const seed = [
      {
        id: 'u1',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'hi' }],
        isStreaming: false,
      },
    ];
    const { result } = renderHook(() => useInvoke({ initialMessages: seed }), {
      wrapper: wrap(makeAppConfig()),
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe('u1');
  });

  it('changing initialMessages after mount does not re-seed', () => {
    const seed1 = [
      {
        id: 'u1',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'hi' }],
        isStreaming: false,
      },
    ];
    const { result, rerender } = renderHook(
      ({ seed }) => useInvoke({ initialMessages: seed }),
      {
        initialProps: { seed: seed1 },
        wrapper: wrap(makeAppConfig()),
      },
    );
    rerender({ seed: [] });
    expect(result.current.messages).toHaveLength(1);
  });

  // ── send({ clientMessageId }) (Task 1.1) ───────────────────────────

  it('send uses caller-supplied clientMessageId for the user message', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { type: 'message_start', message: { id: 'msg_1', role: 'assistant' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
    );
    const { result } = renderHook(() => useInvoke(), { wrapper: wrap(makeAppConfig()) });
    await act(async () => {
      await result.current.send('hello', { clientMessageId: 'stable_1' });
    });
    const userMsg = result.current.messages.find((m) => m.role === 'user');
    expect(userMsg?.id).toBe('stable_1');
  });

  it('send falls back to random id when clientMessageId is absent', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { type: 'message_start', message: { id: 'msg_1', role: 'assistant' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
    );
    const { result } = renderHook(() => useInvoke(), { wrapper: wrap(makeAppConfig()) });
    await act(async () => {
      await result.current.send('hello');
    });
    const userMsg = result.current.messages.find((m) => m.role === 'user');
    expect(userMsg?.id).toMatch(/^user_/);
  });
});
