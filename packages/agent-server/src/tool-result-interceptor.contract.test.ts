/**
 * Cassette-boundary contract test (issue #360, Phase 4 consumption):
 * the MCP server that stamps `_meta.ui.resourceUri` on a tool result ↔
 * the tool-result interceptor that pre-resolves it via `resources/read`.
 *
 * The inputs are NOT synthetic: the `tool.done` payloads come from the
 * pinned silverprotocol fixtures (`oss/e2e/fixtures/silverprotocol/`,
 * `fixtures.lock.json`), captured from real SDK runs — Google ADK
 * (`app-spec-gemini36`) and Claude (`app-update-sonnet5`). The corpus
 * proves the exact wire shape real SDKs emit is the shape the
 * interceptor consumes.
 *
 * FIXTURES.md stability contract — this file asserts ONLY: event
 * types, event ordering, tool names, scenario intent, and structural
 * shape. It NEVER asserts prose text content, ids, token counts, or
 * timestamps: those are capture-run artifacts, not contract surface.
 *
 * Unit mechanics (isError skip, idempotence guard, fail-honest
 * pass-through, host-key fallbacks) live in
 * `tool-result-interceptor.test.ts` — not duplicated here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonValue, ingestAgEvents } from '@silverprotocol/core';
import type { AgBlock, AgEvent } from '@silverprotocol/core';
import { loadLeg } from './testing/corpus.js';
import { interceptToolResult } from './tool-result-interceptor.js';
import type { InterceptorMcpServers } from './tool-result-interceptor.js';
import type { McpCallToolResult, NormalizedMessage } from './types.js';

// ── Cassette loading (all helpers stay in this file — no shared
//    fixture modules; tsconfig.build only excludes *.test.ts) ────────

function loadCassette(scenario: string, framework: string): { raw: JsonValue[]; events: AgEvent[] } {
  const { agjson } = loadLeg(scenario, framework);
  const raw = agjson.map((entry) => JsonValue.parse(entry));
  const events = ingestAgEvents(raw);
  return { raw, events };
}

const gemini = loadCassette('app-spec-gemini36', 'adk');
const sonnet = loadCassette('app-update-sonnet5', 'claude');

// NOTE (cross-artifact, deliberately NOT asserted here): fold
// semantics (reduce()) are the reducer↔cassette contract, owned by
// silverprotocol; this file's contract is the interceptor seam, and
// the FIXTURES.md envelope (event types, ordering, tool names,
// intent, structural shape) doesn't cover fold outcomes. (At the
// bb71e0c pin the app-update-sonnet5 capture reopened the same
// messageId across the reasoning→tool.start beat, parking the
// reducer; the 3338932 cohort no longer does — each message.start
// carries a distinct id.)

// ── Typed narrowing helpers ─────────────────────────────────────────

type ToolDoneEvent = Extract<AgEvent, { type: 'tool.done' }>;
type ToolStartEvent = Extract<AgEvent, { type: 'tool.start' }>;
type TurnDoneEvent = Extract<AgEvent, { type: 'turn.done' }>;
type TextBlock = Extract<AgBlock, { type: 'text' }>;

function toolDonesOf(events: AgEvent[]): ToolDoneEvent[] {
  return events.filter((e): e is ToolDoneEvent => e.type === 'tool.done');
}

function toolStartNamesOf(events: AgEvent[]): string[] {
  return events
    .filter((e): e is ToolStartEvent => e.type === 'tool.start')
    .map((e) => e.name);
}

function turnDonesOf(events: AgEvent[]): TurnDoneEvent[] {
  return events.filter((e): e is TurnDoneEvent => e.type === 'turn.done');
}

function textBlocksOf(ev: ToolDoneEvent): TextBlock[] {
  return ev.content.filter((b): b is TextBlock => b.type === 'text');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`expected ${what} to be a plain object`);
  return v;
}

function asString(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`expected ${what} to be a string`);
  return v;
}

/** The `_meta.ui` slice, fail-loud when absent or malformed. */
function uiSliceFromMeta(meta: unknown, what: string): Record<string, unknown> {
  return asRecord(asRecord(meta, `${what} _meta`).ui, `${what} _meta.ui`);
}

/** Structural {revision, kind} lift from a cassette `tool.done.uiData`. */
function cardRevisionOf(ev: ToolDoneEvent): { revision: number; kind: string } {
  const uiData = asRecord(ev.uiData, 'tool.done uiData');
  if (typeof uiData.revision !== 'number' || typeof uiData.kind !== 'string') {
    throw new Error('expected tool.done uiData to carry {revision: number, kind: string}');
  }
  return { revision: uiData.revision, kind: uiData.kind };
}

/**
 * Distinguishable per-revision iframe HTML the stub resource reader
 * serves — lets the replay assertions tell a frozen revision-1 inline
 * apart from a fresh revision-2 read.
 */
function cardHtml(rev: { revision: number; kind: string }): string {
  return `<html data-kind="${rev.kind}" data-revision="${String(rev.revision)}"></html>`;
}

/**
 * Project a cassette `tool.done` event onto the normalized
 * `tool_use_result` (MCP `CallToolResult`) exactly as an adapter
 * yields it: content + structuredContent + `_meta` + extension fields
 * ride through; nothing is invented.
 */
function toToolUseResult(ev: ToolDoneEvent): McpCallToolResult {
  const result: {
    content: AgBlock[];
    structuredContent?: Record<string, unknown>;
    uiData?: JsonValue;
    _meta?: Record<string, unknown>;
    isError?: boolean;
  } = { content: ev.content };
  if (ev.structuredContent !== undefined) {
    result.structuredContent = asRecord(ev.structuredContent, 'tool.done structuredContent');
  }
  if (ev.uiData !== undefined) result.uiData = ev.uiData;
  if (ev._meta !== undefined) result._meta = ev._meta;
  if (ev.isError !== undefined) result.isError = ev.isError;
  return result;
}

function toNormalizedMessage(
  ev: ToolDoneEvent,
  toolUseResult: McpCallToolResult,
): NormalizedMessage {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: ev.toolCallId,
          content: textBlocksOf(ev).map((b) => ({ type: 'text' as const, text: b.text })),
          ...(ev.isError !== undefined ? { is_error: ev.isError } : {}),
        },
      ],
    },
    tool_use_result: toolUseResult,
  };
}

/** Recursive freeze — any interceptor mutation of the input throws. */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  Object.freeze(value);
}

interface RecordedRead {
  readonly url: string;
  readonly bearer: string | null;
  readonly method: unknown;
  readonly uri: unknown;
}

/**
 * Stub the global fetch as an MCP server answering `resources/read`
 * with `contents: [content]` (the CURRENT server-authoritative
 * resource), recording every read for routing/extraction assertions.
 */
function stubResourcesRead(content: {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly _meta?: Record<string, unknown>;
}): { reads: RecordedRead[] } {
  const reads: RecordedRead[] = [];
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const bodyText = typeof init?.body === 'string' ? init.body : '';
      const parsedBody: unknown = JSON.parse(bodyText);
      const rpc = asRecord(parsedBody, 'resources/read RPC envelope');
      const params = asRecord(rpc.params, 'resources/read RPC params');
      reads.push({
        url: input instanceof Request ? input.url : String(input),
        bearer: new Headers(init?.headers).get('authorization'),
        method: rpc.method,
        uri: params.uri,
      });
      const id =
        typeof rpc.id === 'number' || typeof rpc.id === 'string' ? rpc.id : null;
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, result: { contents: [content] } }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return { reads };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Corpus shape: the FIXTURES.md-stable slices this seam relies on ─

describe('silverprotocol corpus — app-spec-gemini36/adk.agjson.json', () => {
  const EXPECTED_EVENT_TYPES = [
    'turn.start',
    'message.start',
    'tool.start',
    'tool.args.delta',
    'tool.args.assembled',
    'state.delta',
    'content.block',
    'tool.done',
    'state.delta',
    'content.block',
    'text.start',
    'text.delta',
    'text.end',
    'state.delta',
    'content.block',
    'message.end',
    'turn.done',
  ];

  it('every raw entry ingests as a conformant AgEvent — no silent drops', () => {
    expect(gemini.events.length).toBeGreaterThan(0);
    expect(gemini.events).toHaveLength(gemini.raw.length);
  });

  it('replays the recorded event ordering, gap-free (seq 0..N-1)', () => {
    expect(gemini.events.map((e) => e.type)).toEqual(EXPECTED_EVENT_TYPES);
    expect(gemini.events.map((e) => e.seq)).toEqual(
      gemini.events.map((_, i) => i),
    );
  });

  it('scenario intent: single successful ADK turn, BARE tool name, with state.delta + content.block beats', () => {
    expect(toolStartNamesOf(gemini.events)).toEqual(['render_card']);
    const types = gemini.events.map((e) => e.type);
    expect(types).toContain('state.delta');
    expect(types).toContain('content.block');
    const turnDones = turnDonesOf(gemini.events);
    expect(turnDones).toHaveLength(1);
    const turnDone = turnDones[0];
    if (!turnDone) throw new Error('unreachable: length asserted above');
    expect(turnDone.outcome.type).toBe('success');
  });

  it('the single tool.done stamps the MCP-Apps ui slice the interceptor consumes', () => {
    const dones = toolDonesOf(gemini.events);
    expect(dones).toHaveLength(1);
    const done = dones[0];
    if (!done) throw new Error('unreachable: length asserted above');
    expect(done.outcome).toBe('ok');
    const ui = uiSliceFromMeta(done._meta, 'gemini tool.done');
    expect(ui.resourceUri).toBe('ui://mock/card');
    expect(ui.visibility).toEqual(['model']);
    // Structural: a single text block whose payload is JSON, and a
    // structured-content object with title/body/cache slots. No prose.
    expect(done.content).toHaveLength(1);
    const texts = textBlocksOf(done);
    expect(texts).toHaveLength(1);
    const first = texts[0];
    if (!first) throw new Error('unreachable: length asserted above');
    const parsedText: unknown = JSON.parse(first.text);
    expect(isRecord(parsedText)).toBe(true);
    const sc = asRecord(done.structuredContent, 'gemini structuredContent');
    expect(typeof sc.title).toBe('string');
    expect(typeof sc.body).toBe('string');
    const cache = asRecord(sc.cache, 'gemini structuredContent.cache');
    expect(typeof cache.hit).toBe('boolean');
  });
});

describe('silverprotocol corpus — app-update-sonnet5/claude.agjson.json', () => {
  const EXPECTED_EVENT_TYPES = [
    'turn.start',
    'message.start',
    'reasoning.start',
    'reasoning.delta',
    'reasoning.end',
    'reasoning.opaque',
    'tool.start',
    'tool.args.delta',
    'tool.args.assembled',
    'message.end',
    'tool.done',
    'message.start',
    'tool.start',
    'tool.args.delta',
    'tool.args.assembled',
    'message.end',
    'tool.done',
    'message.start',
    'text.start',
    'text.delta',
    'text.end',
    'message.end',
    'turn.done',
  ];

  it('every raw entry ingests as a conformant AgEvent — no silent drops', () => {
    expect(sonnet.events.length).toBeGreaterThan(0);
    expect(sonnet.events).toHaveLength(sonnet.raw.length);
  });

  it('replays the recorded event ordering, gap-free (seq 0..N-1)', () => {
    expect(sonnet.events.map((e) => e.type)).toEqual(EXPECTED_EVENT_TYPES);
    expect(sonnet.events.map((e) => e.seq)).toEqual(
      sonnet.events.map((_, i) => i),
    );
  });

  it('scenario intent: ONE successful turn, MCP-prefixed render → update tool beats', () => {
    expect(sonnet.events.filter((e) => e.type === 'turn.start')).toHaveLength(1);
    expect(toolStartNamesOf(sonnet.events)).toEqual([
      'mcp__cards__render_card',
      'mcp__cards__update_card',
    ]);
    const turnDones = turnDonesOf(sonnet.events);
    expect(turnDones).toHaveLength(1);
    const turnDone = turnDones[0];
    if (!turnDone) throw new Error('unreachable: length asserted above');
    expect(turnDone.outcome.type).toBe('success');
  });

  it('two tool.done beats: revision-1 render then revision-2 update, both stamping the ui slice', () => {
    const dones = toolDonesOf(sonnet.events);
    expect(dones).toHaveLength(2);
    expect(dones.map(cardRevisionOf)).toEqual([
      { revision: 1, kind: 'render' },
      { revision: 2, kind: 'update' },
    ]);
    for (const done of dones) {
      expect(done.outcome).toBe('ok');
      expect(done.isError).toBe(false);
      const ui = uiSliceFromMeta(done._meta, 'sonnet tool.done');
      expect(ui.resourceUri).toBe('ui://mock/card');
      expect(ui.visibility).toEqual(['model']);
      // Structural: one JSON text block that mirrors uiData's
      // revision/kind; uiData carries the {title, body} card slots.
      expect(done.content).toHaveLength(1);
      const texts = textBlocksOf(done);
      const first = texts[0];
      if (!first) throw new Error('expected the tool.done content block to be a text block');
      const parsedText: unknown = JSON.parse(first.text);
      const parsed = asRecord(parsedText, 'sonnet tool.done content JSON');
      const uiData = asRecord(done.uiData, 'sonnet tool.done uiData');
      expect(parsed.revision).toBe(uiData.revision);
      expect(parsed.kind).toBe(uiData.kind);
      expect(typeof uiData.title).toBe('string');
      expect(typeof uiData.body).toBe('string');
    }
  });
});

// ── The contract seam: cassette tool.done payload → interceptor ────

describe('interceptor consumes the real app-spec-gemini36 tool.done payload', () => {
  // Two servers: the URI host (`ui://mock/…` → key "mock") must win
  // over the conventional `ggui` fallback — proving extraction feeds
  // routing, not just that a read happened somewhere.
  const SERVERS: InterceptorMcpServers = {
    ggui: { url: 'http://localhost:6791/mcp', bearer: 'decoy-bearer' },
    mock: { url: 'http://localhost:6792/mcp', bearer: 'mock-bearer' },
  };

  function geminiToolDoneClone(): ToolDoneEvent {
    const dones = toolDonesOf(gemini.events);
    const done = dones[0];
    if (!done) throw new Error('app-spec-gemini36: expected a tool.done event');
    // Clone so deep-freezing the test input never touches the shared
    // module-scope cassette events.
    return structuredClone(done);
  }

  it('extracts the stamped resourceUri and routes resources/read to the URI-named server', async () => {
    const done = geminiToolDoneClone();
    const toolUseResult = toToolUseResult(done);
    const stampedUri = asString(
      uiSliceFromMeta(toolUseResult._meta, 'gemini tool.done').resourceUri,
      'stamped resourceUri',
    );
    const message = toNormalizedMessage(done, toolUseResult);
    deepFreeze(message);

    const { reads } = stubResourcesRead({
      uri: stampedUri,
      mimeType: 'text/html',
      text: cardHtml({ revision: 1, kind: 'render' }),
    });

    await interceptToolResult({ message, mcpServers: SERVERS });

    expect(reads).toHaveLength(1);
    const read = reads[0];
    if (!read) throw new Error('unreachable: length asserted above');
    expect(read.method).toBe('resources/read');
    expect(read.uri).toBe(stampedUri);
    expect(read.url).toBe(SERVERS['mock']?.url);
    expect(read.bearer).toBe(`Bearer ${SERVERS['mock']?.bearer ?? ''}`);
  });

  it('inlines the read under _meta.ui.resource, preserving every stamped key, structuredContent, and the frozen input', async () => {
    const done = geminiToolDoneClone();
    const toolUseResult = toToolUseResult(done);
    const stampedMeta = asRecord(toolUseResult._meta, 'gemini tool.done _meta');
    const stampedUi = uiSliceFromMeta(toolUseResult._meta, 'gemini tool.done');
    const stampedUri = asString(stampedUi.resourceUri, 'stamped resourceUri');
    const message = toNormalizedMessage(done, toolUseResult);
    deepFreeze(message);
    const inputSnapshot = JSON.stringify(message);

    const RESOURCE = {
      uri: stampedUri,
      mimeType: 'text/html',
      text: cardHtml({ revision: 1, kind: 'render' }),
      _meta: { ui: { csp: { connectDomains: [] } } },
    };
    stubResourcesRead(RESOURCE);

    const out = await interceptToolResult({ message, mcpServers: SERVERS });

    expect(out).not.toBe(message);
    if (out.type !== 'user') throw new Error('expected a user message');
    const outResult = out.tool_use_result;
    if (outResult === undefined) throw new Error('expected tool_use_result on the output');

    // The resource is written under _meta.ui.resource, verbatim from the read.
    const outUi = uiSliceFromMeta(outResult._meta, 'intercepted tool.done');
    expect(outUi.resource).toEqual(RESOURCE);

    // EVERY pre-existing _meta.ui key survives (resourceUri, visibility, …).
    for (const [key, value] of Object.entries(stampedUi)) {
      expect(outUi[key]).toEqual(value);
    }
    expect(outUi.visibility).toEqual(['model']);
    expect(outUi.resourceUri).toBe(stampedUri);

    // EVERY other top-level _meta key survives too.
    const outMeta = asRecord(outResult._meta, 'intercepted _meta');
    for (const [key, value] of Object.entries(stampedMeta)) {
      if (key === 'ui') continue;
      expect(outMeta[key]).toEqual(value);
    }

    // structuredContent and content are untouched — deep-equal to the input.
    expect(outResult.structuredContent).toEqual(toolUseResult.structuredContent);
    expect(outResult.content).toEqual(done.content);

    // The frozen input never mutated (a write would have thrown; the
    // snapshot proves value-identity as well).
    expect(JSON.stringify(message)).toBe(inputSnapshot);
  });
});

describe('replay two-beat (app-update-sonnet5) — forceReinline reflects the CURRENT resource', () => {
  const SERVERS: InterceptorMcpServers = {
    mock: { url: 'http://localhost:6793/mcp', bearer: 'replay-bearer' },
  };

  it('re-reads on BOTH beats and inlines the revision-2 resource, not the frozen revision-1 inline', async () => {
    const dones = toolDonesOf(sonnet.events).map((ev) => structuredClone(ev));
    expect(dones).toHaveLength(2);
    const [renderDone, updateDone] = dones;
    if (!renderDone || !updateDone) throw new Error('unreachable: length asserted above');

    const renderRev = cardRevisionOf(renderDone); // {revision: 1, kind: 'render'}
    const updateRev = cardRevisionOf(updateDone); // {revision: 2, kind: 'update'}

    // Beat 1 as SNAPSHOTTED at record time: the live interceptor had
    // already inlined the revision-1 HTML. On replay this frozen
    // inline is exactly what must NOT survive.
    const renderResult = toToolUseResult(renderDone);
    const renderMeta = asRecord(renderResult._meta, 'render tool.done _meta');
    const renderUi = uiSliceFromMeta(renderResult._meta, 'render tool.done');
    const resourceUri = asString(renderUi.resourceUri, 'render resourceUri');
    const frozenRenderResult: McpCallToolResult = {
      ...renderResult,
      _meta: {
        ...renderMeta,
        ui: {
          ...renderUi,
          resource: {
            uri: resourceUri,
            mimeType: 'text/html',
            text: cardHtml(renderRev),
          },
        },
      },
    };
    const beat1 = toNormalizedMessage(renderDone, frozenRenderResult);
    // Beat 2 as recorded (no inline yet) — covers the not-yet-inlined
    // replay input alongside beat 1's already-inlined one.
    const beat2 = toNormalizedMessage(updateDone, toToolUseResult(updateDone));
    deepFreeze(beat1);
    deepFreeze(beat2);

    // CURRENT server state at replay time: the update landed, the
    // resource now serves revision-2 HTML.
    const { reads } = stubResourcesRead({
      uri: resourceUri,
      mimeType: 'text/html',
      text: cardHtml(updateRev),
    });

    const replayed1 = await interceptToolResult({
      message: beat1,
      mcpServers: SERVERS,
      forceReinline: true,
    });
    const replayed2 = await interceptToolResult({
      message: beat2,
      mcpServers: SERVERS,
      forceReinline: true,
    });

    // One re-read per beat — the already-inlined beat 1 included.
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.method).toBe('resources/read');
      expect(read.uri).toBe(resourceUri);
    }

    for (const replayed of [replayed1, replayed2]) {
      if (replayed.type !== 'user') throw new Error('expected a user message');
      const ui = uiSliceFromMeta(replayed.tool_use_result?._meta, 'replayed tool.done');
      const resource = asRecord(ui.resource, 'replayed _meta.ui.resource');
      expect(resource.text).toBe(cardHtml(updateRev));
      expect(resource.text).not.toBe(cardHtml(renderRev));
      // The stamped slice still rides along after the overwrite.
      expect(ui.resourceUri).toBe(resourceUri);
      expect(ui.visibility).toEqual(['model']);
    }

    // Extension fields on the CallToolResult (uiData) survive the
    // replay rewrite — the interceptor only touches _meta.ui.resource.
    if (replayed2.type !== 'user') throw new Error('expected a user message');
    expect(replayed2.tool_use_result?.uiData).toEqual(updateDone.uiData);
  });
});
