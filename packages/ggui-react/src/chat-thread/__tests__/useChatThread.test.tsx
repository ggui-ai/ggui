/**
 * Behavioral tests for ChatThreadProvider + useChatThread against a mock
 * MessageStorageAdapter. Covers the skeleton scope (Task 2.1):
 *   - Load-first, mount-once gate (Provider waits on loadMessages)
 *   - Seed flows through context → useInvoke.initialMessages
 *   - Persistence is content-group-scoped + idempotent
 *   - observeMessages updates feed the unified message list
 *   - Provider-owned ambient config (bearerToken, aiContext) reaches
 *     useInvoke + appendMessage without shell involvement
 *
 * Outbox / offline behavior is NOT in the skeleton — it lands in Task 2.2
 * full implementation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AppDisplayConfig } from '@ggui-ai/protocol';
import { ChatThreadProvider } from '../ChatThreadProvider';
import { useChatThread } from '../useChatThread';
import type {
  MessageStorageAdapter,
  StoredMessage,
} from '../adapters/types';
import {
  createKvOutboxStorage,
  type KvLikeStorage,
  type OutboxEntry,
} from '../outbox';

const APP_ID = 'app_test';
const ENDPOINT_URL = 'https://agent.example.com';
const THREAD_ID = 't1';

function appConfig(): AppDisplayConfig {
  return {
    appId: APP_ID,
    name: 'Test App',
    defaultShellType: 'chat',
    themeId: 'ggui',
    designSystemPreset: 'default',
    userAuthMode: 'anonymous',
    endpointUrl: ENDPOINT_URL,
  };
}

function createMockAdapter(initial: StoredMessage[] = []): {
  adapter: MessageStorageAdapter;
  state: { messages: StoredMessage[]; appendCalls: Parameters<MessageStorageAdapter['appendMessage']>[0][] };
  pushFromElsewhere: (msg: StoredMessage) => void;
} {
  const state = {
    messages: [...initial],
    appendCalls: [] as Parameters<MessageStorageAdapter['appendMessage']>[0][],
  };
  const subscribers: Array<(msgs: StoredMessage[]) => void> = [];
  const pushFromElsewhere = (msg: StoredMessage) => {
    state.messages = [...state.messages, msg];
    for (const cb of subscribers) cb([...state.messages]);
  };
  const adapter: MessageStorageAdapter = {
    async loadMessages(_threadId) {
      return [...state.messages];
    },
    observeMessages(_threadId, onNext) {
      subscribers.push(onNext);
      return () => {
        const i = subscribers.indexOf(onNext);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    async appendMessage(input) {
      state.appendCalls.push(input);
      const existing = state.messages.find(
        (m) => m.threadId === input.threadId && m.key === input.key,
      );
      if (existing) return existing;
      const stored: StoredMessage = {
        key: input.key,
        threadId: input.threadId,
        authorRole: input.authorRole,
        kind: input.kind,
        blocks: input.blocks,
        cardSnapshot: input.cardSnapshot ?? null,
        textPreview: input.textPreview,
        seq: state.messages.length + 1,
        at: new Date().toISOString(),
        aiContext: input.aiContext,
      };
      state.messages = [...state.messages, stored];
      for (const cb of subscribers) cb([...state.messages]);
      return stored;
    },
  };
  return { adapter, state, pushFromElsewhere };
}

function wrap(opts: {
  adapter: MessageStorageAdapter;
  bearerToken?: string;
  aiContext?: Record<string, unknown>;
}) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ChatThreadProvider
        threadId={THREAD_ID}
        appId={APP_ID}
        appConfig={appConfig()}
        adapter={opts.adapter}
        bearerToken={opts.bearerToken}
        aiContext={opts.aiContext}
        loadingFallback={<div data-testid="loading" />}
      >
        {children}
      </ChatThreadProvider>
    );
  };
}

function inMemoryKv(): KvLikeStorage & { snapshot: () => Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    snapshot: () => ({ ...data }),
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key]! : null;
    },
    setItem(key, value) {
      data[key] = value;
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

describe('ChatThreadProvider + useChatThread — skeleton', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads persisted history and seeds messages before the hook renders', async () => {
    const { adapter } = createMockAdapter([
      {
        key: 'msg_persisted-0',
        threadId: THREAD_ID,
        authorRole: 'user',
        kind: 'text',
        blocks: [{ type: 'text', text: 'hi from yesterday' }],
        cardSnapshot: null,
        textPreview: 'hi from yesterday',
        seq: 1,
        at: '2026-04-15T00:00:00Z',
      },
    ]);

    const { result } = renderHook(() => useChatThread(), {
      wrapper: wrap({ adapter }),
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
    });
    expect(result.current.messages[0]!.role).toBe('user');
    expect(result.current.messages[0]!.blocks[0]).toEqual({
      type: 'text',
      text: 'hi from yesterday',
    });
  });

  it('useChatThread throws if ChatThreadProvider is missing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useChatThread())).toThrow(
      /ChatThreadProvider/,
    );
    spy.mockRestore();
  });

  it('persists finalized user-sent messages via adapter.appendMessage', async () => {
    const { adapter, state } = createMockAdapter();
    // useInvoke stubs: one-turn sse
    fetchMock.mockResolvedValueOnce(sseOk('msg_a', 'ok'));

    const { result } = renderHook(() => useChatThread(), {
      wrapper: wrap({ adapter }),
    });
    await waitFor(() => {
      expect(result.current.messages).toEqual([]);
    });

    await act(async () => {
      await result.current.send('hello', { clientMessageId: 'user_stable_1' });
    });

    // Expect at least 2 appendMessage calls: user text + agent text.
    await waitFor(() => {
      expect(state.appendCalls.length).toBeGreaterThanOrEqual(2);
    });
    const roles = state.appendCalls.map((c) => c.authorRole).sort();
    expect(roles).toContain('user');
    expect(roles).toContain('agent');
  });

  it('append idempotency — the same group key is written at most once', async () => {
    const { adapter, state } = createMockAdapter();
    fetchMock.mockResolvedValueOnce(sseOk('msg_b', 'ok'));

    const { result } = renderHook(() => useChatThread(), {
      wrapper: wrap({ adapter }),
    });
    await waitFor(() => expect(result.current.messages).toEqual([]));
    await act(async () => {
      await result.current.send('x', { clientMessageId: 'user_stable_2' });
    });
    await waitFor(() =>
      expect(state.appendCalls.length).toBeGreaterThanOrEqual(2),
    );

    const beforeKeys = state.appendCalls.map((c) => c.key);
    const uniqueBefore = new Set(beforeKeys);
    expect(uniqueBefore.size).toBe(beforeKeys.length);
  });

  it('observeMessages updates feed the unified message list', async () => {
    const { adapter, pushFromElsewhere } = createMockAdapter();
    const { result } = renderHook(() => useChatThread(), {
      wrapper: wrap({ adapter }),
    });
    await waitFor(() => expect(result.current.messages).toEqual([]));

    act(() => {
      pushFromElsewhere({
        key: 'msg_remote-0',
        threadId: THREAD_ID,
        authorRole: 'agent',
        kind: 'text',
        blocks: [{ type: 'text', text: 'pushed from another device' }],
        cardSnapshot: null,
        textPreview: 'pushed from another device',
        seq: 99,
        at: '2026-04-16T00:00:00Z',
      });
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
    });
    expect(result.current.messages[0]!.role).toBe('assistant');
  });

  it('forwards Provider-level bearerToken to useInvoke (Authorization header)', async () => {
    const { adapter } = createMockAdapter();
    fetchMock.mockResolvedValueOnce(sseOk('msg_c', 'ok'));

    const { result } = renderHook(() => useChatThread(), {
      wrapper: wrap({ adapter, bearerToken: 'jwt_abc' }),
    });
    await waitFor(() => expect(result.current.messages).toEqual([]));
    await act(async () => {
      await result.current.send('hi');
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer jwt_abc');
  });

  it('stamps Provider-level aiContext onto every persisted message', async () => {
    const { adapter, state } = createMockAdapter();
    fetchMock.mockResolvedValueOnce(sseOk('msg_d', 'ok'));

    const aiContext = { appId: APP_ID, shellType: 'chat' };
    const { result } = renderHook(() => useChatThread(), {
      wrapper: wrap({ adapter, aiContext }),
    });
    await waitFor(() => expect(result.current.messages).toEqual([]));
    await act(async () => {
      await result.current.send('hi');
    });
    await waitFor(() =>
      expect(state.appendCalls.length).toBeGreaterThanOrEqual(2),
    );
    for (const call of state.appendCalls) {
      expect(call.aiContext).toEqual(aiContext);
    }
  });

  // ── offline / outbox (Task 2.2a) ─────────────────────────────────────

  it('offline send enqueues to the outbox and never hits the network', async () => {
    const { adapter, state } = createMockAdapter();
    const kv = inMemoryKv();
    const outboxStorage = createKvOutboxStorage(kv);

    const { result } = renderHook(
      () => useChatThread({ outboxStorage, isOnline: false }),
      { wrapper: wrap({ adapter }) },
    );
    await waitFor(() => expect(result.current.messages).toEqual([]));

    await act(async () => {
      await result.current.send('hello offline', {
        clientMessageId: 'user_offline_1',
      });
    });

    // Network never called
    expect(fetchMock).not.toHaveBeenCalled();
    // Adapter never appended (persistence happens only after successful turn)
    expect(state.appendCalls).toHaveLength(0);
    // Durable storage received the entry
    const raw = kv.snapshot()['ggui.chat-thread.outbox'];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as OutboxEntry[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.clientMessageId).toBe('user_offline_1');
    expect(parsed[0]!.text).toBe('hello offline');
    expect(parsed[0]!.threadId).toBe(THREAD_ID);
  });

  it('offline pending entries render as isPending bubbles in the messages list', async () => {
    const { adapter } = createMockAdapter();
    const kv = inMemoryKv();
    const outboxStorage = createKvOutboxStorage(kv);

    const { result } = renderHook(
      () => useChatThread({ outboxStorage, isOnline: false }),
      { wrapper: wrap({ adapter }) },
    );
    await waitFor(() => expect(result.current.messages).toEqual([]));

    await act(async () => {
      await result.current.send('queued', { clientMessageId: 'user_q1' });
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    const bubble = result.current.messages[0]!;
    expect(bubble.role).toBe('user');
    expect(bubble.isPending).toBe(true);
    expect(bubble.id).toBe('user_q1');
    expect(bubble.blocks).toEqual([{ type: 'text', text: 'queued' }]);
  });

  it('offline send without outboxStorage throws a clear error', async () => {
    const { adapter } = createMockAdapter();
    const { result } = renderHook(
      () => useChatThread({ isOnline: false }),
      { wrapper: wrap({ adapter }) },
    );
    await waitFor(() => expect(result.current.messages).toEqual([]));

    await act(async () => {
      await expect(
        result.current.send('nope', { clientMessageId: 'user_dropped' }),
      ).rejects.toThrow(/outboxStorage/);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offline enqueue is idempotent on clientMessageId (retried send is a no-op)', async () => {
    const { adapter } = createMockAdapter();
    const kv = inMemoryKv();
    const outboxStorage = createKvOutboxStorage(kv);

    const { result } = renderHook(
      () => useChatThread({ outboxStorage, isOnline: false }),
      { wrapper: wrap({ adapter }) },
    );
    await waitFor(() => expect(result.current.messages).toEqual([]));

    await act(async () => {
      await result.current.send('dup', { clientMessageId: 'user_dup_1' });
      await result.current.send('dup', { clientMessageId: 'user_dup_1' });
      await result.current.send('dup', { clientMessageId: 'user_dup_1' });
    });

    const parsed = JSON.parse(
      kv.snapshot()['ggui.chat-thread.outbox']!,
    ) as OutboxEntry[];
    expect(parsed).toHaveLength(1);
    expect(result.current.messages.filter((m) => m.isPending)).toHaveLength(1);
  });

  // ── replay-on-reconnect (Task 2.2b) ─────────────────────────────────

  it('drains the outbox serially when isOnline flips true', async () => {
    const { adapter } = createMockAdapter();
    const kv = inMemoryKv();
    const outboxStorage = createKvOutboxStorage(kv);

    // Pre-populate storage as if three sends happened while offline.
    kv.setItem(
      'ggui.chat-thread.outbox',
      JSON.stringify([
        { threadId: THREAD_ID, clientMessageId: 'u_r1', text: 'a', queuedAt: Date.now() },
        { threadId: THREAD_ID, clientMessageId: 'u_r2', text: 'b', queuedAt: Date.now() },
        { threadId: THREAD_ID, clientMessageId: 'u_r3', text: 'c', queuedAt: Date.now() },
      ]),
    );
    // Three successive fetch stubs, one per replayed entry.
    fetchMock
      .mockResolvedValueOnce(sseOk('msg_r1', 'ack a'))
      .mockResolvedValueOnce(sseOk('msg_r2', 'ack b'))
      .mockResolvedValueOnce(sseOk('msg_r3', 'ack c'));

    const { result, rerender } = renderHook(
      ({ isOnline }) => useChatThread({ outboxStorage, isOnline }),
      { initialProps: { isOnline: false }, wrapper: wrap({ adapter }) },
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(3));
    expect(result.current.messages.every((m) => m.isPending)).toBe(true);

    await act(async () => {
      rerender({ isOnline: true });
    });

    // All three fetch calls must have happened, in order, with the
    // stored clientMessageIds.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1]!.body as string));
    expect(bodies.map((b) => b.message)).toEqual(['a', 'b', 'c']);

    // Outbox is emptied in durable storage.
    await waitFor(() => {
      const raw = kv.snapshot()['ggui.chat-thread.outbox'];
      const parsed = raw ? (JSON.parse(raw) as OutboxEntry[]) : [];
      expect(parsed).toHaveLength(0);
    });
  });

  it('replay stops on the first failure and leaves the remaining entries in storage', async () => {
    const { adapter } = createMockAdapter();
    const kv = inMemoryKv();
    const outboxStorage = createKvOutboxStorage(kv);

    kv.setItem(
      'ggui.chat-thread.outbox',
      JSON.stringify([
        { threadId: THREAD_ID, clientMessageId: 'u_ok', text: 'first', queuedAt: Date.now() },
        { threadId: THREAD_ID, clientMessageId: 'u_fail', text: 'second', queuedAt: Date.now() },
        { threadId: THREAD_ID, clientMessageId: 'u_never', text: 'third', queuedAt: Date.now() },
      ]),
    );
    fetchMock
      .mockResolvedValueOnce(sseOk('msg_ok', 'ok'))
      .mockRejectedValueOnce(new Error('network blew up'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result, rerender } = renderHook(
      ({ isOnline }) => useChatThread({ outboxStorage, isOnline }),
      { initialProps: { isOnline: false }, wrapper: wrap({ adapter }) },
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(3));

    await act(async () => {
      rerender({ isOnline: true });
    });

    // Only the first entry should have been attempted + the second which
    // failed. The third never fires.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // Storage still holds the failed + untouched entries.
    await waitFor(() => {
      const parsed = JSON.parse(
        kv.snapshot()['ggui.chat-thread.outbox']!,
      ) as OutboxEntry[];
      expect(parsed.map((e) => e.clientMessageId)).toEqual(['u_fail', 'u_never']);
    });

    consoleWarn.mockRestore();
  });

  it('pending bubble disappears once a replayed send lands as a live user message', async () => {
    const { adapter } = createMockAdapter();
    const kv = inMemoryKv();
    const outboxStorage = createKvOutboxStorage(kv);
    kv.setItem(
      'ggui.chat-thread.outbox',
      JSON.stringify([
        { threadId: THREAD_ID, clientMessageId: 'u_solo', text: 'hello again', queuedAt: Date.now() },
      ]),
    );
    fetchMock.mockResolvedValueOnce(sseOk('msg_solo', 'welcome back'));

    const { result, rerender } = renderHook(
      ({ isOnline }) => useChatThread({ outboxStorage, isOnline }),
      { initialProps: { isOnline: false }, wrapper: wrap({ adapter }) },
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]!.isPending).toBe(true);

    await act(async () => {
      rerender({ isOnline: true });
    });

    // After replay: there must be exactly one user message, and it must
    // NOT be pending anymore. The rendered id may be either the
    // clientMessageId (live window, pre-persistence) or the persisted
    // group key (`${clientMessageId}-0`, post-persistence) — both are
    // valid post-replay states. The invariant the test guards is that
    // the pending bubble is GONE.
    await waitFor(() => {
      const userMsgs = result.current.messages.filter((m) => m.role === 'user');
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0]!.isPending).toBe(false);
      const textBlock = userMsgs[0]!.blocks.find((b) => b.type === 'text');
      expect(textBlock).toEqual({ type: 'text', text: 'hello again' });
    });
    // No pending bubbles at all.
    expect(result.current.messages.some((m) => m.isPending)).toBe(false);
  });

  // ── seed filter (Task 2.1) ───────────────────────────────────────────

  it('filters system-role messages out of the invoke seed', async () => {
    const { adapter } = createMockAdapter([
      {
        key: 'sys-0',
        threadId: THREAD_ID,
        authorRole: 'system',
        kind: 'event',
        blocks: [{ type: 'text', text: 'permission revoked' }],
        cardSnapshot: null,
        textPreview: 'permission revoked',
        seq: 0,
        at: '2026-04-15T00:00:00Z',
      },
      {
        key: 'msg_hello-0',
        threadId: THREAD_ID,
        authorRole: 'user',
        kind: 'text',
        blocks: [{ type: 'text', text: 'hi' }],
        cardSnapshot: null,
        textPreview: 'hi',
        seq: 1,
        at: '2026-04-15T00:00:01Z',
      },
    ]);
    fetchMock.mockResolvedValueOnce(sseOk('msg_e', 'sure'));

    const { result } = renderHook(() => useChatThread(), {
      wrapper: wrap({ adapter }),
    });
    await waitFor(() => expect(result.current.messages.length).toBe(2));

    // Trigger a send so we can inspect the history payload sent to the agent.
    await act(async () => {
      await result.current.send('again');
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    const roles = body.history.map((t: { role: string }) => t.role);
    // system message must not appear in history
    expect(roles).not.toContain('system');
    expect(roles).toContain('user');
  });
});

// ── test helpers ─────────────────────────────────────────────────────

function sseOk(assistantId: string, text: string): Response {
  const events = [
    { type: 'message_start', message: { id: assistantId, role: 'assistant' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    { type: 'message_stop' },
  ];
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
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
