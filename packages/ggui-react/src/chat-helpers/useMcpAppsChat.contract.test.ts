/**
 * Contract test: agent-server's SSE wire ↔ `useMcpAppsChat`'s ingest.
 *
 * Phase 4 cassette consumption (#360). The upstream half of this seam
 * is pinned by a silverprotocol (AgJSON) fixture captured against the
 * real mock `cards` MCP server: `app-update-sonnet5/claude.agjson.json`
 * (pinned in `oss/e2e/fixtures/silverprotocol/fixtures.lock.json`) —
 * one turn, `render_card` then `update_card`, both `tool.done`s
 * carrying the SAME `_meta.ui.resourceUri` with revisions 1 → 2. That
 * two-beat is exactly the shape `addRender`'s dedupe-by-resourceUri +
 * latest-inlinedResource-wins rule exists for, so this file replays the
 * cassette through the hook and asserts the coalescing outcome.
 *
 * Projection happens IN THIS FILE: the cassette holds normalized
 * AgEvents; agent-server's wire emits `NormalizedMessage` frames
 * (`event: message` / `event: error` / first-frame `chat-allocated`).
 * The projection helpers below mirror the per-SDK adapter (tool.start +
 * tool.args.assembled → assistant `tool_use`; tool.done → user
 * `tool_result` with the full MCP result on `tool_use_result`) and the
 * tool-result interceptor's `_meta.ui.resource` stamp
 * (`oss/packages/agent-server/src/tool-result-interceptor.ts`).
 *
 * FIXTURES.md stability contract — asserted here: event types, event
 * ordering, tool names, scenario intent (revision/kind beats),
 * structural shape. NEVER asserted: prose text content, ids, token
 * counts, timestamps. Cassette-derived expectations are referential
 * (compared against the event's own fields), not hardcoded literals.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  AgEvent,
  JsonValue,
  ingestAgEvents,
  type AgBlock,
} from '@silverprotocol/core';

import { loadLeg } from './__tests__/corpus';
import { handleEvent, useMcpAppsChat } from './useMcpAppsChat';
import type {
  ChatEntry,
  GguiSessionRef,
  HostDisplayMode,
  ToolCallEntry,
} from './mcp-apps-chat-types';

// ---------------------------------------------------------------------------
// Corpus loading.
// ---------------------------------------------------------------------------

/**
 * Raw JSON entries as recorded. Validated through the `JsonValue` zod
 * schema (exported by @silverprotocol/core as both a schema const and a
 * type) so no type assertion is needed on the fetched fixture's output.
 */
const rawCassette: JsonValue[] = JsonValue.array().parse(
  loadLeg('app-update-sonnet5', 'claude').agjson,
);

/**
 * Ingested events. `ingestAgEvents` silently DROPS unparseable entries
 * (consumer parse-known-else-skip posture) — the "fully parses" test
 * below pins ingested count === raw count so a drop can never hide.
 */
const cassetteEvents: AgEvent[] = ingestAgEvents(rawCassette);

// ---------------------------------------------------------------------------
// Cassette accessors — narrow AgEvent fields with loud failures, never casts.
// ---------------------------------------------------------------------------

type ToolDoneEvent = Extract<AgEvent, { type: 'tool.done' }>;
type ToolStartEvent = Extract<AgEvent, { type: 'tool.start' }>;
type JsonObject = { [k: string]: JsonValue };

/**
 * `AgEvent` is a union of the known-event discriminated union PLUS a
 * forward-compat catch-all arm (`{ type: string; [k: string]: JsonValue }`),
 * so `ev.type === 'tool.done'` alone doesn't narrow. The predicates are
 * sound because `ingestAgEvents` parses the discriminated union FIRST —
 * an event only lands in the catch-all arm when its `type` matches no
 * known literal, so a known literal guarantees the schema-parsed shape.
 */
function isToolStartEvent(ev: AgEvent): ev is ToolStartEvent {
  return ev.type === 'tool.start';
}

function isToolDoneEvent(ev: AgEvent): ev is ToolDoneEvent {
  return ev.type === 'tool.done';
}

function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface CassetteToolCall {
  /** Tool name from the matching `tool.start` (MCP-prefixed on Claude). */
  readonly name: string;
  readonly done: ToolDoneEvent;
}

function collectToolCalls(events: ReadonlyArray<AgEvent>): CassetteToolCall[] {
  const namesById = new Map<string, string>();
  for (const ev of events) {
    if (isToolStartEvent(ev)) namesById.set(ev.toolCallId, ev.name);
  }
  const calls: CassetteToolCall[] = [];
  for (const ev of events) {
    if (!isToolDoneEvent(ev)) continue;
    const name = namesById.get(ev.toolCallId);
    if (name === undefined) {
      throw new Error(
        'cassette drift: tool.done without a matching tool.start',
      );
    }
    calls.push({ name, done: ev });
  }
  return calls;
}

function expectTwoToolCalls(): [CassetteToolCall, CassetteToolCall] {
  const calls = collectToolCalls(cassetteEvents);
  const [first, second] = calls;
  if (calls.length !== 2 || first === undefined || second === undefined) {
    throw new Error(
      `cassette drift: expected exactly 2 tool calls, got ${calls.length}`,
    );
  }
  return [first, second];
}

/** The two beats the scenario was captured for: render, then update. */
const [renderBeat, updateBeat] = expectTwoToolCalls();

function cassetteUiBlock(done: ToolDoneEvent): JsonObject {
  const ui = done._meta?.ui;
  if (!isJsonObject(ui)) {
    throw new Error('cassette drift: tool.done missing _meta.ui block');
  }
  return ui;
}

function cassetteResourceUri(done: ToolDoneEvent): string {
  const uri = cassetteUiBlock(done).resourceUri;
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Error('cassette drift: tool.done missing _meta.ui.resourceUri');
  }
  return uri;
}

function cassetteUiData(done: ToolDoneEvent): JsonObject {
  if (!isJsonObject(done.uiData)) {
    throw new Error('cassette drift: tool.done uiData is not an object');
  }
  return done.uiData;
}

/** Structural beat shape — revision + kind are FIXTURES.md-stable. */
function cassetteBeatShape(done: ToolDoneEvent): {
  readonly revision: number;
  readonly kind: string;
} {
  const ui = cassetteUiData(done);
  if (typeof ui.revision !== 'number' || typeof ui.kind !== 'string') {
    throw new Error('cassette drift: uiData missing revision/kind');
  }
  return { revision: ui.revision, kind: ui.kind };
}

function cassetteTextBlocks(
  done: ToolDoneEvent,
): Array<{ readonly type: 'text'; readonly text: string }> {
  return done.content
    .filter((b): b is Extract<AgBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => ({ type: 'text' as const, text: b.text }));
}

// ---------------------------------------------------------------------------
// Projection: cassette AgEvents → agent-server `NormalizedMessage` wire
// frames. Local mirror of `@ggui-ai/agent-server`'s `NormalizedMessage` —
// the wire shape is pinned HERE on purpose (a contract test must fail
// when either side drifts, so it cannot import the other side's types).
// ---------------------------------------------------------------------------

interface WireInlinedResource {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly _meta?: Record<string, unknown>;
}

interface WireAssistantToolUseMessage {
  readonly type: 'assistant';
  readonly message: {
    readonly content: ReadonlyArray<{
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }>;
  };
}

interface WireToolResultMessage {
  readonly type: 'user';
  readonly message: {
    readonly content: ReadonlyArray<{
      readonly type: 'tool_result';
      readonly tool_use_id: string;
      readonly content: ReadonlyArray<{
        readonly type: 'text';
        readonly text: string;
      }>;
      readonly is_error?: boolean;
    }>;
  };
  readonly tool_use_result: {
    readonly content: ReadonlyArray<unknown>;
    readonly structuredContent?: Record<string, unknown>;
    readonly _meta?: Record<string, unknown>;
    readonly isError?: boolean;
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Mirror of the tool-result interceptor's merge: keep every existing
 * `_meta` key, overwrite ONLY the `ui.resource` slot.
 */
function stampInlinedResource(
  meta: Record<string, unknown>,
  resource: WireInlinedResource,
): Record<string, unknown> {
  const existingUi = isRecord(meta.ui) ? meta.ui : {};
  return { ...meta, ui: { ...existingUi, resource } };
}

/** tool.start + tool.args.assembled → the assistant `tool_use` frame. */
function projectToolUseMessage(
  call: CassetteToolCall,
): WireAssistantToolUseMessage {
  const assembled = cassetteEvents.find(
    (ev) =>
      ev.type === 'tool.args.assembled' &&
      ev.toolCallId === call.done.toolCallId,
  );
  const input: unknown =
    assembled?.type === 'tool.args.assembled' ? assembled.input : {};
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: call.done.toolCallId,
          name: call.name,
          input,
        },
      ],
    },
  };
}

/**
 * tool.done → the user `tool_result` frame. `tool_use_result` carries
 * the FULL MCP result (`structuredContent` + `_meta`) exactly like the
 * per-SDK adapters do; `opts.inlinedResource` emulates the agent-server
 * interceptor's `_meta.ui.resource` stamp; `opts.extraUiKeys` injects
 * synthetic future spec keys for the forward-compat case.
 */
function projectToolResultMessage(
  done: ToolDoneEvent,
  opts?: {
    readonly inlinedResource?: WireInlinedResource;
    readonly extraUiKeys?: Record<string, unknown>;
  },
): WireToolResultMessage {
  const textBlocks = cassetteTextBlocks(done);
  let meta: Record<string, unknown> = { ...(done._meta ?? {}) };
  if (opts?.extraUiKeys !== undefined) {
    const existingUi = isRecord(meta.ui) ? meta.ui : {};
    meta = { ...meta, ui: { ...existingUi, ...opts.extraUiKeys } };
  }
  if (opts?.inlinedResource !== undefined) {
    meta = stampInlinedResource(meta, opts.inlinedResource);
  }
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: done.toolCallId,
          content: textBlocks,
          ...(done.isError === true ? { is_error: true } : {}),
        },
      ],
    },
    tool_use_result: {
      content: textBlocks,
      structuredContent: cassetteUiData(done),
      _meta: meta,
      ...(done.isError === true ? { isError: true } : {}),
    },
  };
}

/** Deterministic stand-in for the server-rendered iframe HTML. */
function mockCardHtml(revision: number): string {
  return `<!doctype html><div data-revision="${revision}">mock card</div>`;
}

// ---------------------------------------------------------------------------
// SSE + handleEvent harness helpers.
// ---------------------------------------------------------------------------

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(frames: string): Response {
  return new Response(frames, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

interface CapturedDeps {
  readonly entries: ChatEntry[];
  readonly renders: GguiSessionRef[];
  readonly displayModes: Array<HostDisplayMode | undefined>;
  readonly patches: Array<{
    readonly toolUseId: string;
    readonly result?: unknown;
    readonly isError?: boolean;
  }>;
}

function makeDeps(): {
  readonly captured: CapturedDeps;
  readonly deps: Parameters<typeof handleEvent>[3];
} {
  const captured: CapturedDeps = {
    entries: [],
    renders: [],
    displayModes: [],
    patches: [],
  };
  return {
    captured,
    deps: {
      append: (e) => {
        captured.entries.push(e);
      },
      addRender: (r) => {
        captured.renders.push(r);
      },
      setHostDisplayMode: (m) => {
        captured.displayModes.push(m);
      },
      patchToolCall: (toolUseId, patch) => {
        captured.patches.push({ toolUseId, ...patch });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Cassette shape — the FIXTURES.md-stable structural facts everything
// downstream leans on.
// ---------------------------------------------------------------------------

describe('cassette corpus — app-update-sonnet5/claude.agjson.json', () => {
  it('fully parses: ingestAgEvents drops nothing', () => {
    expect(cassetteEvents).toHaveLength(rawCassette.length);
    expect(cassetteEvents.length).toBeGreaterThan(0);
  });

  it('is a single turn: exactly one turn.start and one turn.done', () => {
    // Structural single-turn fact, read from the events themselves.
    // Deliberately NOT via `reduce()`: the Claude capture re-emits
    // `message.start` with the same message id between content blocks,
    // which parks the normative reducer (`needsResync: true` at the
    // first tool.start) — reducer fold behavior is silverprotocol's
    // contract, not this seam's, and FIXTURES.md only stabilizes event
    // types/ordering/tool names/intent/shape.
    const types = cassetteEvents.map((e) => e.type);
    expect(types.filter((t) => t === 'turn.start')).toHaveLength(1);
    expect(types.filter((t) => t === 'turn.done')).toHaveLength(1);
    expect(types[0]).toBe('turn.start');
    expect(types.at(-1)).toBe('turn.done');
  });

  it('scenario intent: render beat then update beat on ONE resource, both ok', () => {
    expect(collectToolCalls(cassetteEvents).map((c) => c.name)).toEqual([
      'mcp__cards__render_card',
      'mcp__cards__update_card',
    ]);
    // Same resourceUri on both beats — the coalescing precondition.
    expect(cassetteResourceUri(updateBeat.done)).toBe(
      cassetteResourceUri(renderBeat.done),
    );
    // Revision/kind beats: 1/'render' → 2/'update'.
    expect(cassetteBeatShape(renderBeat.done)).toEqual({
      revision: 1,
      kind: 'render',
    });
    expect(cassetteBeatShape(updateBeat.done)).toEqual({
      revision: 2,
      kind: 'update',
    });
    // Both results succeeded — no failure-envelope semantics in play.
    expect(renderBeat.done.outcome).toBe('ok');
    expect(renderBeat.done.isError).toBe(false);
    expect(updateBeat.done.outcome).toBe('ok');
    expect(updateBeat.done.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SSE wire → hook state. Exercises the real SSE parser + the real
// addRender (the coalescing rule is NOT reachable through bare
// handleEvent — it lives inside the hook).
// ---------------------------------------------------------------------------

describe('agent-server SSE wire ↔ useMcpAppsChat ingest (cassette-driven)', () => {
  let fetchMock: ReturnType<
    typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>
  >;

  beforeEach(() => {
    fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => sseResponse(''),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('chat-allocated is intercepted: fires onChatAllocated and appends NO entry', async () => {
    const onChatAllocated = vi.fn();
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        sseFrame('chat-allocated', {
          type: 'chat-allocated',
          chatId: 'chat_contract_1',
        }) + sseFrame('message', { type: 'result', subtype: 'success' }),
      ),
    );
    const { result } = renderHook(() =>
      useMcpAppsChat({ chatEndpoint: 'http://contract.test/agent', onChatAllocated }),
    );
    await act(async () => {
      await result.current.send('hello');
    });
    expect(onChatAllocated).toHaveBeenCalledTimes(1);
    expect(onChatAllocated).toHaveBeenCalledWith('chat_contract_1');
    // The allocation frame produced NO chat entry — only the user's own
    // prompt and the end marker from the subsequent result frame.
    expect(result.current.entries.map((e) => e.kind)).toEqual(['user', 'end']);
  });

  it('a cassette tool.done → exactly one render entry; structuredContent lands as ToolCallEntry.result', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        sseFrame('chat-allocated', {
          type: 'chat-allocated',
          chatId: 'chat_contract_2',
        }) +
          sseFrame('message', projectToolUseMessage(renderBeat)) +
          sseFrame('message', projectToolResultMessage(renderBeat.done)) +
          sseFrame('message', { type: 'result', subtype: 'success' }),
      ),
    );
    const { result } = renderHook(() =>
      useMcpAppsChat({ chatEndpoint: 'http://contract.test/agent' }),
    );
    await act(async () => {
      await result.current.send('render a card');
    });

    // Event ordering on the chat log mirrors the wire ordering.
    expect(result.current.entries.map((e) => e.kind)).toEqual([
      'user',
      'tool-call',
      'session',
      'end',
    ]);
    // Exactly one render entry, keyed by the cassette's own resourceUri.
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0]?.resourceUri).toBe(
      cassetteResourceUri(renderBeat.done),
    );
    // structuredContent (projected from the cassette's uiData) lands
    // verbatim as ToolCallEntry.result — not the stripped text join.
    const toolEntries = result.current.entries.filter(
      (e): e is ToolCallEntry => e.kind === 'tool-call',
    );
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]?.name).toBe('mcp__cards__render_card');
    expect(toolEntries[0]?.toolUseId).toBe(renderBeat.done.toolCallId);
    expect(toolEntries[0]?.result).toEqual(cassetteUiData(renderBeat.done));
    expect(toolEntries[0]?.isError).toBeUndefined();
  });

  it('THE TWO-BEAT: render_card then update_card coalesce onto ONE render entry; latest inlinedResource wins', async () => {
    const inlinedFor = (done: ToolDoneEvent): WireInlinedResource => ({
      uri: cassetteResourceUri(done),
      mimeType: 'text/html',
      text: mockCardHtml(cassetteBeatShape(done).revision),
    });
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        sseFrame('chat-allocated', {
          type: 'chat-allocated',
          chatId: 'chat_contract_3',
        }) +
          sseFrame('message', projectToolUseMessage(renderBeat)) +
          sseFrame(
            'message',
            projectToolResultMessage(renderBeat.done, {
              inlinedResource: inlinedFor(renderBeat.done),
            }),
          ) +
          sseFrame('message', projectToolUseMessage(updateBeat)) +
          sseFrame(
            'message',
            projectToolResultMessage(updateBeat.done, {
              inlinedResource: inlinedFor(updateBeat.done),
            }),
          ) +
          sseFrame('message', { type: 'result', subtype: 'success' }),
      ),
    );
    const { result } = renderHook(() =>
      useMcpAppsChat({ chatEndpoint: 'http://contract.test/agent' }),
    );
    await act(async () => {
      await result.current.send('render then update the card');
    });

    // The chat LOG keeps both beats (two tool-calls, two session
    // markers) — the wire ordering is preserved…
    expect(result.current.entries.map((e) => e.kind)).toEqual([
      'user',
      'tool-call',
      'session',
      'tool-call',
      'session',
      'end',
    ]);
    const toolEntries = result.current.entries.filter(
      (e): e is ToolCallEntry => e.kind === 'tool-call',
    );
    expect(toolEntries.map((e) => e.name)).toEqual([
      'mcp__cards__render_card',
      'mcp__cards__update_card',
    ]);
    expect(toolEntries[0]?.result).toEqual(cassetteUiData(renderBeat.done));
    expect(toolEntries[1]?.result).toEqual(cassetteUiData(updateBeat.done));

    // …but SESSIONS coalesce: ONE render entry for the shared
    // resourceUri, and its inlinedResource is the LATEST beat's HTML
    // (revision 2) — the addRender rule the cassette was captured for.
    expect(result.current.sessions).toHaveLength(1);
    const session = result.current.sessions[0];
    expect(session?.resourceUri).toBe(cassetteResourceUri(updateBeat.done));
    expect(session?.inlinedResource?.text).toBe(
      mockCardHtml(cassetteBeatShape(updateBeat.done).revision),
    );
    expect(session?.inlinedResource?.text).not.toBe(
      mockCardHtml(cassetteBeatShape(renderBeat.done).revision),
    );
  });

  it('an `event: error` frame appends an error entry', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        sseFrame('chat-allocated', {
          type: 'chat-allocated',
          chatId: 'chat_contract_4',
        }) + sseFrame('error', { error: 'agent exploded' }),
      ),
    );
    const { result } = renderHook(() =>
      useMcpAppsChat({ chatEndpoint: 'http://contract.test/agent' }),
    );
    await act(async () => {
      await result.current.send('boom');
    });
    expect(result.current.entries.map((e) => e.kind)).toEqual([
      'user',
      'error',
    ]);
    const errorEntry = result.current.entries[1];
    expect(errorEntry?.kind === 'error' ? errorEntry.text : undefined).toBe(
      'agent exploded',
    );
  });
});

// ---------------------------------------------------------------------------
// handleEvent-level contract points that don't need the hook: CSP lift
// and forward-compat tolerance.
// ---------------------------------------------------------------------------

describe('handleEvent — CSP lift + forward-compat (cassette-projected)', () => {
  it('lifts CSP from the inlined resource\'s own _meta.ui.csp', () => {
    const { captured, deps } = makeDeps();
    const csp = {
      connectDomains: ['https://api.contract.test'],
      resourceDomains: ['https://cdn.contract.test'],
    };
    handleEvent(
      'message',
      projectToolResultMessage(renderBeat.done, {
        inlinedResource: {
          uri: cassetteResourceUri(renderBeat.done),
          mimeType: 'text/html',
          text: mockCardHtml(cassetteBeatShape(renderBeat.done).revision),
          _meta: { ui: { csp } },
        },
      }),
      'csp.1',
      deps,
    );
    expect(captured.renders).toHaveLength(1);
    expect(captured.renders[0]?.inlinedResource?.csp).toEqual(csp);
  });

  it('ignores unknown _meta.ui.* keys (cassette-real `visibility` + a synthetic future key) without throwing', () => {
    // The cassette's own _meta.ui block already carries `visibility` —
    // a key the hook has never heard of. Prove that structurally, then
    // pile on a second synthetic future key.
    const ui = cassetteUiBlock(renderBeat.done);
    expect(Array.isArray(ui.visibility)).toBe(true);

    const { captured, deps } = makeDeps();
    expect(() =>
      handleEvent(
        'message',
        projectToolResultMessage(renderBeat.done, {
          extraUiKeys: { futureHint: { window: 'pip-2' } },
        }),
        'fc.1',
        deps,
      ),
    ).not.toThrow();
    // Unknown keys neither poison the mount nor leak into state.
    expect(captured.renders).toHaveLength(1);
    expect(captured.renders[0]?.resourceUri).toBe(
      cassetteResourceUri(renderBeat.done),
    );
    expect(captured.displayModes).toEqual([]);
  });

  it('ignores an unknown msg.type without throwing and appends nothing', () => {
    const { captured, deps } = makeDeps();
    expect(() =>
      handleEvent(
        'message',
        { type: 'telemetry.frame', payload: { x: 1 } },
        'fc.2',
        deps,
      ),
    ).not.toThrow();
    expect(captured.entries).toHaveLength(0);
    expect(captured.renders).toHaveLength(0);
    expect(captured.patches).toHaveLength(0);
  });
});
