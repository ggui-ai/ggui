/**
 * Contract test: agent-server's `POST /agent` SSE producer ↔ any
 * MCP-Apps chat client (issue #360, Phase 4 cassette consumption).
 *
 * The wire contract under test (see `createAgentApp` in ./app.ts):
 *
 *   1. Frame 0 on every `kind:'chat'` stream is `event: chat-allocated`
 *      carrying `{type:'chat-allocated', chatId}` — echoed when the
 *      client supplied a chatId, server-minted otherwise.
 *   2. Every adapter yield becomes exactly one `event: message` frame,
 *      in yield order.
 *   3. An adapter throw produces a TERMINAL `event: error` frame with
 *      `{error: string}`.
 *   4. A client abort produces NO further frame — no error frame, no
 *      frame for post-abort yields.
 *   5. `tool_use_result.structuredContent` survives byte-identical
 *      end-to-end (the producer never re-shapes tool results).
 *   6. Unknown `_meta.*` / `_meta.ui.*` keys survive (forward-compat:
 *      the producer never validates or strips extension metadata).
 *
 * Realism tier: the silverprotocol cassette
 * `oss/.silverprotocol-corpus/app-update-sonnet5/claude.agjson.json`
 * (a real Claude render→update run) is ingested via
 * `@silverprotocol/core` and its `tool.done` events are projected into
 * `NormalizedMessage` tool results, then streamed through the real
 * producer.
 *
 * FIXTURES stability contract — asserted here: event types, event
 * ordering, tool names, scenario intent (render rev 1 → update rev 2),
 * structural shape. NEVER asserted: prose text content, ids, token
 * counts, timestamps.
 *
 * Hermetic: global `fetch` is stubbed to reject, so the agent-tool
 * catalog build degrades to `undefined` and the tool-result
 * interceptor's `resources/read` fails → passes every message through
 * unchanged (its documented fallback), which is exactly what the
 * byte-fidelity assertions need. All helpers live INSIDE this file on
 * purpose — no shared fixture module (published-artifact leak risk:
 * tsconfig.build only excludes `*.test.ts`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ingestAgEvents,
  type AgEvent,
  type JsonValue,
} from '@silverprotocol/core';
import { createAgentApp, type ChatAllocatedEvent } from './app.js';
import { createGuestTokenAuth } from './auth.js';
import { createInMemoryChatStore } from './chat-store.js';
import type {
  AgentAdapter,
  AgentInput,
  McpCallToolResult,
  NormalizedMessage,
} from './types.js';

// ── Corpus guard — fail LOUD, never skip ────────────────────────────
// src/ → agent-server/ → packages/ → oss/.silverprotocol-corpus/
const CASSETTE_URL = new URL(
  '../../../.silverprotocol-corpus/app-update-sonnet5/claude.agjson.json',
  import.meta.url,
);
if (!existsSync(CASSETTE_URL)) {
  throw new Error(
    'silverprotocol corpus missing — run: node oss/scripts/sync-silverprotocol-corpus.mjs',
  );
}

// ── Cassette loading (in-file, cached) ──────────────────────────────

type ToolStartEvent = Extract<AgEvent, { type: 'tool.start' }>;
type ToolDoneEvent = Extract<AgEvent, { type: 'tool.done' }>;

interface LoadedCassette {
  /** Raw JSON array length BEFORE ingestion (drop detection). */
  readonly rawCount: number;
  readonly events: readonly AgEvent[];
}

let cassetteCache: LoadedCassette | undefined;

function loadCassette(): LoadedCassette {
  if (cassetteCache) return cassetteCache;
  const rawEvents: JsonValue[] = JSON.parse(readFileSync(CASSETTE_URL, 'utf8'));
  if (!Array.isArray(rawEvents)) {
    throw new Error(
      'claude.agjson.json is not a JSON array — corpus corrupt? re-run: node oss/scripts/sync-silverprotocol-corpus.mjs',
    );
  }
  // ingestAgEvents silently DROPS unparseable entries — the zero-drop
  // assertion lives in the tests; here we only load.
  cassetteCache = {
    rawCount: rawEvents.length,
    events: ingestAgEvents(rawEvents),
  };
  return cassetteCache;
}

/** Narrow an unknown / JsonValue to a plain object, else undefined. */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Project a cassette `tool.done` into the `NormalizedMessage` a real
 * adapter would yield for that MCP tool result: user-role
 * `tool_result` content plus the full `tool_use_result` CallToolResult
 * (content, structuredContent from the AgJSON `uiData` channel, and
 * the `_meta.ui` slice verbatim).
 */
function projectToolDone(ev: ToolDoneEvent): NormalizedMessage {
  const textBlocks = ev.content.flatMap((block) =>
    block.type === 'text'
      ? [{ type: 'text' as const, text: block.text }]
      : [],
  );
  const uiData = asRecord(ev.uiData);
  const toolUseResult: McpCallToolResult = {
    content: ev.content,
    ...(uiData !== undefined ? { structuredContent: uiData } : {}),
    ...(ev._meta !== undefined ? { _meta: ev._meta } : {}),
    ...(ev.isError !== undefined ? { isError: ev.isError } : {}),
  };
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: ev.toolCallId,
          content: textBlocks,
          ...(ev.isError !== undefined ? { is_error: ev.isError } : {}),
        },
      ],
    },
    tool_use_result: toolUseResult,
  };
}

// ── SSE frame parsing (in-file, client-side of the contract) ────────

interface SseFrame {
  readonly event: string;
  readonly data: string;
}

function parseSseFrames(body: string): SseFrame[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLines = lines.filter((l) => l.startsWith('data: '));
      return {
        event: eventLine === undefined ? '' : eventLine.slice('event: '.length),
        data: dataLines.map((l) => l.slice('data: '.length)).join('\n'),
      };
    });
}

// ── App scaffolding ─────────────────────────────────────────────────

const SECRET = 'agent-stream-contract-secret-32b';

const MCP_SERVERS = {
  ggui: { url: 'http://localhost:9999/mcp', bearer: 'dev' },
};

function adapterOf(
  name: string,
  messages: readonly NormalizedMessage[],
): AgentAdapter {
  return {
    name,
    async *run(_input: AgentInput): AsyncIterable<NormalizedMessage> {
      for (const message of messages) yield message;
    },
  };
}

function buildContractApp(
  adapter: AgentAdapter,
  log?: (line: string) => void,
): ReturnType<typeof createAgentApp> {
  return createAgentApp({
    adapter,
    auth: createGuestTokenAuth({ signingSecret: SECRET }),
    chatStore: createInMemoryChatStore(),
    mcpServers: MCP_SERVERS,
    systemPrompt: null,
    sandboxProxyUrl: 'http://localhost:7790',
    ...(log !== undefined ? { log } : {}),
  });
}

async function mintGuestBearer(
  app: ReturnType<typeof createAgentApp>,
): Promise<string> {
  const res = await app.request('http://localhost/auth/guest', {
    method: 'POST',
  });
  const body = (await res.json()) as { guestToken: string };
  return body.guestToken;
}

/** POST kind:'chat', drain the completed stream, parse its frames. */
async function postChatFrames(
  app: ReturnType<typeof createAgentApp>,
  guestToken: string,
  extraBody?: Record<string, unknown>,
): Promise<SseFrame[]> {
  const res = await app.request('http://localhost/agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${guestToken}`,
    },
    body: JSON.stringify({
      kind: 'chat',
      prompt: 'drive the contract',
      ...extraBody,
    }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')?.toLowerCase()).toContain(
    'text/event-stream',
  );
  return parseSseFrames(await res.text());
}

/** Narrow a parsed message frame to the user/tool_result variant. */
function expectUserToolResult(
  msg: NormalizedMessage,
): Extract<NormalizedMessage, { type: 'user' }> {
  if (msg.type !== 'user') {
    throw new Error(`expected a user tool_result message, got '${msg.type}'`);
  }
  return msg;
}

// Hermetic network boundary: every real fetch (catalog build,
// interceptor resources/read) fails fast → documented degrade paths.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.reject(
        new TypeError(
          'agent-stream.contract.test: network disabled — MCP fetches must fail fast',
        ),
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Cassette integrity (FIXTURES stability contract) ────────────────

describe('cassette integrity — app-update-sonnet5/claude.agjson.json', () => {
  it('ingests with ZERO drops — every raw entry parses as an AgEvent', () => {
    const { rawCount, events } = loadCassette();
    expect(rawCount).toBeGreaterThan(0);
    // ingestAgEvents silently drops unparseable entries; equal counts
    // prove the cassette fully parses under @silverprotocol/core.
    expect(events).toHaveLength(rawCount);
  });

  it('is a single turn bracketed by turn.start / turn.done', () => {
    const { events } = loadCassette();
    expect(events[0]?.type).toBe('turn.start');
    expect(events.at(-1)?.type).toBe('turn.done');
    // Structural single-turn check (identity of the id, not its value).
    const turnIds = new Set(
      events
        .map((e) => e.turnId)
        .filter((t): t is string => typeof t === 'string'),
    );
    expect(turnIds.size).toBe(1);
  });

  it('carries the render→update tool sequence with MCP-prefixed names', () => {
    const { events } = loadCassette();
    const toolEvents = events.filter(
      (e): e is ToolStartEvent | ToolDoneEvent =>
        e.type === 'tool.start' || e.type === 'tool.done',
    );
    // Ordering: each call fully completes before the next begins.
    expect(toolEvents.map((e) => e.type)).toEqual([
      'tool.start',
      'tool.done',
      'tool.start',
      'tool.done',
    ]);
    const starts = events.filter(
      (e): e is ToolStartEvent => e.type === 'tool.start',
    );
    expect(starts.map((s) => s.name)).toEqual([
      'mcp__cards__render_card',
      'mcp__cards__update_card',
    ]);
    // Each done pairs with its start (same toolCallId — structural
    // pairing, no id VALUE asserted).
    const dones = events.filter(
      (e): e is ToolDoneEvent => e.type === 'tool.done',
    );
    expect(dones[0]?.toolCallId).toBe(starts[0]?.toolCallId);
    expect(dones[1]?.toolCallId).toBe(starts[1]?.toolCallId);
  });

  it('both tool.done events carry the MCP-Apps ui slice + structured card payload', () => {
    const { events } = loadCassette();
    const dones = events.filter(
      (e): e is ToolDoneEvent => e.type === 'tool.done',
    );
    expect(dones).toHaveLength(2);
    for (const done of dones) {
      expect(done.outcome).toBe('ok');
      expect(done.isError).toBe(false);
      expect(done.content[0]?.type).toBe('text');
      const ui = asRecord(asRecord(done._meta)?.ui);
      expect(ui?.resourceUri).toBe('ui://mock/card');
      expect(ui?.visibility).toEqual(['model']);
      // Structural card shape only — title/body VALUES are prose and
      // deliberately not asserted.
      const card = asRecord(done.uiData);
      expect(Object.keys(card ?? {}).sort()).toEqual([
        'body',
        'kind',
        'revision',
        'title',
      ]);
    }
    // Scenario intent: render (revision 1) then update (revision 2).
    const dCards = dones.map((d) => asRecord(d.uiData));
    expect(dCards.map((c) => c?.kind)).toEqual(['render', 'update']);
    expect(dCards.map((c) => c?.revision)).toEqual([1, 2]);
  });
});

// ── POST /agent SSE frame grammar ───────────────────────────────────

describe('POST /agent SSE contract — frame grammar', () => {
  it('(1) frame 0 is chat-allocated with a server-minted chatId when the client sends none', async () => {
    const app = buildContractApp(
      adapterOf('mint', [{ type: 'result', subtype: 'success' }]),
    );
    const guestToken = await mintGuestBearer(app);
    const frames = await postChatFrames(app, guestToken);

    expect(frames[0]?.event).toBe('chat-allocated');
    const allocated = JSON.parse(frames[0]?.data ?? '') as ChatAllocatedEvent;
    expect(allocated.type).toBe('chat-allocated');
    expect(typeof allocated.chatId).toBe('string');
    expect(allocated.chatId.length).toBeGreaterThan(0);
  });

  it('(1) frame 0 echoes the client-supplied chatId', async () => {
    const app = buildContractApp(
      adapterOf('echo', [{ type: 'result', subtype: 'success' }]),
    );
    const guestToken = await mintGuestBearer(app);
    const frames = await postChatFrames(app, guestToken, {
      chatId: 'chat_client_pinned_0001',
    });

    expect(frames[0]?.event).toBe('chat-allocated');
    const allocated = JSON.parse(frames[0]?.data ?? '') as ChatAllocatedEvent;
    expect(allocated).toEqual({
      type: 'chat-allocated',
      chatId: 'chat_client_pinned_0001',
    });
  });

  it('(2) streams one event:message frame per adapter yield, in yield order', async () => {
    const yielded: NormalizedMessage[] = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'step-one' }] },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_order',
              content: [{ type: 'text', text: 'step-two' }],
            },
          ],
        },
      },
      { type: 'result', subtype: 'success' },
    ];
    const app = buildContractApp(adapterOf('ordered', yielded));
    const guestToken = await mintGuestBearer(app);
    const frames = await postChatFrames(app, guestToken);

    expect(frames.map((f) => f.event)).toEqual([
      'chat-allocated',
      'message',
      'message',
      'message',
    ]);
    const parsed = frames
      .slice(1)
      .map((f) => JSON.parse(f.data) as NormalizedMessage);
    expect(parsed.map((m) => m.type)).toEqual(['assistant', 'user', 'result']);
    // Payloads arrive in yield order, un-reshaped.
    expect(parsed).toEqual(yielded);
  });

  it('(3) adapter throw → terminal event:error frame with {error: string}', async () => {
    const failing: AgentAdapter = {
      name: 'failing',
      async *run(_input: AgentInput): AsyncIterable<NormalizedMessage> {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'before the crash' }] },
        };
        throw new Error('adapter exploded: upstream 500');
      },
    };
    const app = buildContractApp(failing);
    const guestToken = await mintGuestBearer(app);
    const frames = await postChatFrames(app, guestToken);

    // The error frame is TERMINAL — nothing follows it.
    expect(frames.map((f) => f.event)).toEqual([
      'chat-allocated',
      'message',
      'error',
    ]);
    const errPayload = JSON.parse(frames.at(-1)?.data ?? '') as {
      error: unknown;
    };
    expect(typeof errPayload.error).toBe('string');
    expect(errPayload.error).toBe('adapter exploded: upstream 500');
  });

  it('(4) client abort → no error frame, post-abort yields never reach the wire', async () => {
    let adapterSawAbort = false;
    const abortAware: AgentAdapter = {
      name: 'abort-aware',
      async *run(input: AgentInput): AsyncIterable<NormalizedMessage> {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'pre-abort' }] },
        };
        await new Promise<void>((resolve) => {
          if (input.abortSignal.aborted) {
            resolve();
            return;
          }
          input.abortSignal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        adapterSawAbort = true;
        // A real SDK may still surface a buffered message after the
        // client vanished — the producer MUST swallow it.
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'post-abort — must not stream' }],
          },
        };
      },
    };
    const logs: string[] = [];
    const app = buildContractApp(abortAware, (line) => logs.push(line));
    const guestToken = await mintGuestBearer(app);

    const res = await app.request('http://localhost/agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${guestToken}`,
      },
      body: JSON.stringify({ kind: 'chat', prompt: 'abort me' }),
    });
    expect(res.status).toBe(200);
    if (res.body === null) throw new Error('expected an SSE body stream');

    // Read the two pre-abort frames, then abort like a real client:
    // cancel the response stream (hono wires stream cancel → onAbort →
    // the producer's AbortController).
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while ((buffer.match(/\n\n/g) ?? []).length < 2) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error('SSE stream ended before both pre-abort frames');
      }
      buffer += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    // Wait until the producer's loop exits through the NON-error path.
    // The 'POST /agent error' log line and the error frame live in the
    // same branch — the line's absence proves no error frame was
    // written after the client went away.
    await vi.waitFor(() => {
      expect(
        logs.some((line) => line.includes('POST /agent complete')),
      ).toBe(true);
    });
    expect(adapterSawAbort).toBe(true);
    expect(logs.filter((line) => line.includes('POST /agent error'))).toEqual(
      [],
    );

    // Everything the client observed: allocation + the single
    // pre-abort message. No error frame, no post-abort message.
    const frames = parseSseFrames(buffer);
    expect(frames.map((f) => f.event)).toEqual(['chat-allocated', 'message']);
  });

  it('(5) structuredContent survives byte-identical end-to-end', async () => {
    // Deliberately non-alphabetical keys + nested order so byte-level
    // comparison is meaningful (JSON.stringify preserves insertion
    // order through the producer's serialize and our parse).
    const structuredContent: Record<string, unknown> = {
      zeta: 'last',
      alpha: 'first',
      nested: { b: 2, a: 1 },
      arr: [3, 1, 2],
      nullValue: null,
      flag: false,
    };
    const sent: NormalizedMessage = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_bytes',
            content: [{ type: 'text', text: '{"ok":true}' }],
          },
        ],
      },
      tool_use_result: {
        content: [{ type: 'text', text: '{"ok":true}' }],
        structuredContent,
        isError: false,
      },
    };
    const app = buildContractApp(adapterOf('bytes', [sent]));
    const guestToken = await mintGuestBearer(app);
    const frames = await postChatFrames(app, guestToken);

    const messageFrames = frames.filter((f) => f.event === 'message');
    expect(messageFrames).toHaveLength(1);
    const received = expectUserToolResult(
      JSON.parse(messageFrames[0]?.data ?? '') as NormalizedMessage,
    );
    expect(JSON.stringify(received.tool_use_result?.structuredContent)).toBe(
      JSON.stringify(structuredContent),
    );
  });

  it('(6) unknown _meta.* and _meta.ui.* keys survive (forward-compat)', async () => {
    const sent: NormalizedMessage = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_meta',
            content: [{ type: 'text', text: 'rendered' }],
          },
        ],
      },
      tool_use_result: {
        content: [{ type: 'text', text: 'rendered' }],
        _meta: {
          'io.example/unknown-extension': { anything: 'goes', depth: [1, 2] },
          ui: {
            visibility: ['model'],
            'io.example/future-ui-key': 42,
          },
        },
      },
    };
    const app = buildContractApp(adapterOf('meta', [sent]));
    const guestToken = await mintGuestBearer(app);
    const frames = await postChatFrames(app, guestToken);

    const messageFrames = frames.filter((f) => f.event === 'message');
    expect(messageFrames).toHaveLength(1);
    const received = expectUserToolResult(
      JSON.parse(messageFrames[0]?.data ?? '') as NormalizedMessage,
    );
    const meta = received.tool_use_result?._meta;
    expect(meta?.['io.example/unknown-extension']).toEqual({
      anything: 'goes',
      depth: [1, 2],
    });
    const ui = asRecord(meta?.ui);
    expect(ui?.visibility).toEqual(['model']);
    expect(ui?.['io.example/future-ui-key']).toBe(42);
  });
});

// ── Realism tier — cassette tool results through the live producer ──

describe('realism tier — cassette renders streamed through POST /agent', () => {
  it('projects both cassette tool.done events end-to-end intact and in order', async () => {
    const { rawCount, events } = loadCassette();
    expect(events).toHaveLength(rawCount); // zero ingestion drops
    const dones = events.filter(
      (e): e is ToolDoneEvent => e.type === 'tool.done',
    );
    expect(dones).toHaveLength(2);

    const projected = dones.map(projectToolDone);
    const app = buildContractApp(adapterOf('cassette-replay', projected));
    const guestToken = await mintGuestBearer(app);
    const frames = await postChatFrames(app, guestToken);

    expect(frames[0]?.event).toBe('chat-allocated');
    expect(frames.filter((f) => f.event === 'error')).toEqual([]);
    const messageFrames = frames.filter((f) => f.event === 'message');
    expect(messageFrames).toHaveLength(2);

    const received = messageFrames.map((f) =>
      expectUserToolResult(JSON.parse(f.data) as NormalizedMessage),
    );
    received.forEach((msg, i) => {
      // Structured card payload survives byte-identical from the
      // cassette's uiData channel through the SSE producer.
      expect(JSON.stringify(msg.tool_use_result?.structuredContent)).toBe(
        JSON.stringify(dones[i]?.uiData),
      );
      // The MCP-Apps ui slice survives verbatim.
      const ui = asRecord(msg.tool_use_result?._meta?.ui);
      expect(ui?.resourceUri).toBe('ui://mock/card');
      expect(ui?.visibility).toEqual(['model']);
    });

    // Scenario intent preserved in wire order: render rev 1 → update
    // rev 2 (structural — no prose/id assertions).
    const cards = received.map((m) =>
      asRecord(m.tool_use_result?.structuredContent),
    );
    expect(cards.map((c) => c?.kind)).toEqual(['render', 'update']);
    expect(cards.map((c) => c?.revision)).toEqual([1, 2]);
  });
});
