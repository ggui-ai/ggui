/**
 * Corpus seam contract (#426 Spec A), ggui-react half: do the
 * chat-helpers extract and fold REAL framework tool results the way
 * ggui defines? Stimulus realism from pinned cassettes + AgEvent-
 * validated synthetics; oracle = ggui's own helpers.
 *
 * FIXTURES.md stability contract — asserted here: event types +
 * ordering, tool names, scenario intent (which legs carry the ui
 * bootstrap and how many times, read machine-readably from the golden),
 * structural fold shape (group kinds/counts). NEVER asserted: prose,
 * ids, token counts, timestamps, per-run metadata.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AgEvent } from '@silverprotocol/core';
import type { ContentBlock } from '@ggui-ai/protocol';
import type { ConversationMessage } from '../../invoke/useInvoke';
import {
  conversationMessagesToInvokeHistory,
  extractRenderFromToolResult,
  invokeMessageToContentGroups,
  useMcpAppsChat,
  type ContentGroup,
} from '../index';
import { goldenUiToolDones, loadLeg, loadLocalLeg } from './corpus';

const LEGS = [
  ['app-spec-gemini36', 'adk'],
  ['app-spec-structured-result', 'openai'],
  ['app-update-sonnet5', 'claude'],
  ['partials-sonnet5', 'claude'],
] as const;

type Framework = (typeof LEGS)[number][1];

/** Narrow an unknown to a plain object, else undefined. */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Map a cassette leg's native frames into the ContentBlock stream the
 * helpers consume — per-framework, written against the REAL pinned
 * `.native.json` shapes (same grounding rule as agent-server's
 * nativeToolResults). Streaming partials (partials-sonnet5) are folded
 * the way the package folds them: complete frames win, deltas dedupe
 * away — `stream_event` / `raw_model_stream_event` frames are dropped
 * because the finalized `assistant` / run-item frames re-carry the
 * complete blocks (the mirror of the streaming-turn rule: nothing is
 * durable until the finalized frame).
 */
function nativeToContentBlocks(
  native: unknown[],
  framework: Framework,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const frame of native) {
    const f = asRecord(frame);
    if (f === undefined) continue;
    if (framework === 'claude') {
      // Grounded shape: complete `assistant` frames carry the final
      // content blocks (`thinking` | `text` | `tool_use`); `user`
      // frames carry the stripped Anthropic `tool_result` in
      // `message.content` while the FULL MCP CallToolResult (the only
      // carrier of `_meta`) rides the sibling `tool_use_result` — the
      // package's own documented KEY INSIGHT (useMcpAppsChat), so the
      // adapter hands THAT to the helpers as the result content.
      // `thinking` has no ggui invoke-vocabulary projection — dropped.
      const content = asRecord(f.message)?.content;
      if (!Array.isArray(content)) continue;
      if (f.type === 'assistant') {
        for (const raw of content) {
          const b = asRecord(raw);
          if (b === undefined) continue;
          if (b.type === 'text' && typeof b.text === 'string') {
            blocks.push({ type: 'text', text: b.text });
          } else if (
            b.type === 'tool_use' &&
            typeof b.id === 'string' &&
            typeof b.name === 'string'
          ) {
            blocks.push({
              type: 'tool_use',
              id: b.id,
              name: b.name,
              input: asRecord(b.input) ?? {},
            });
          }
        }
      } else if (f.type === 'user' && f.tool_use_result !== undefined) {
        for (const raw of content) {
          const b = asRecord(raw);
          if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            blocks.push({
              type: 'tool_result',
              tool_use_id: b.tool_use_id,
              content: f.tool_use_result,
            });
          }
        }
      }
    } else if (framework === 'adk') {
      // Grounded shape: every frame is an ADK event with
      // `content.parts[]`; a part carries `functionCall` (id, name,
      // args), `functionResponse` (id, name, response = the MCP
      // CallToolResult verbatim), or `text`. `thoughtSignature` has no
      // projection — dropped.
      const parts = asRecord(f.content)?.parts;
      if (!Array.isArray(parts)) continue;
      for (const rawPart of parts) {
        const part = asRecord(rawPart);
        if (part === undefined) continue;
        const fc = asRecord(part.functionCall);
        const fr = asRecord(part.functionResponse);
        if (fc && typeof fc.id === 'string' && typeof fc.name === 'string') {
          blocks.push({
            type: 'tool_use',
            id: fc.id,
            name: fc.name,
            input: asRecord(fc.args) ?? {},
          });
        } else if (fr && typeof fr.id === 'string') {
          blocks.push({
            type: 'tool_result',
            tool_use_id: fr.id,
            content: fr.response,
          });
        } else if (typeof part.text === 'string') {
          blocks.push({ type: 'text', text: part.text });
        }
      }
    } else {
      // Grounded shape: complete `run_item_stream_event` frames only
      // (`raw_model_stream_event` deltas dedupe away). `tool_called`
      // carries the call at `item.rawItem` (callId, name, JSON-string
      // arguments); `tool_output` carries the framework-flattened
      // result at `item.rawItem` with the MCP-side extras
      // (structuredContent — and `_meta`, were the SDK to forward it)
      // on the `item.customData` channel; `message_output_created`
      // carries the final text at `rawItem.content[].text`.
      if (f.type !== 'run_item_stream_event') continue;
      const item = asRecord(f.item);
      const rawItem = asRecord(item?.rawItem);
      if (item === undefined || rawItem === undefined) continue;
      if (f.name === 'tool_called') {
        if (
          typeof rawItem.callId === 'string' &&
          typeof rawItem.name === 'string'
        ) {
          const args =
            typeof rawItem.arguments === 'string'
              ? (asRecord(JSON.parse(rawItem.arguments)) ?? {})
              : {};
          blocks.push({
            type: 'tool_use',
            id: rawItem.callId,
            name: rawItem.name,
            input: args,
          });
        }
      } else if (f.name === 'tool_output') {
        if (typeof rawItem.callId === 'string') {
          blocks.push({
            type: 'tool_result',
            tool_use_id: rawItem.callId,
            content: item.customData ?? rawItem,
          });
        }
      } else if (f.name === 'message_output_created') {
        const content = rawItem.content;
        if (!Array.isArray(content)) continue;
        for (const raw of content) {
          const b = asRecord(raw);
          if (b?.type === 'output_text' && typeof b.text === 'string') {
            blocks.push({ type: 'text', text: b.text });
          }
        }
      }
    }
  }
  return blocks;
}

describe('cassette realism tier', () => {
  for (const [scenario, fw] of LEGS) {
    it(`${scenario}/${fw}: extract finds exactly the golden's ui-bearing results; groups are stable`, () => {
      const leg = loadLeg(scenario, fw);
      const blocks = nativeToContentBlocks(leg.native, fw);
      // Scenario intent (stable set): every consumed leg carries at
      // least one mappable block — an empty mapping means the MAPPER
      // missed the frames, so a zero `renders` below can only mean the
      // extract said no.
      expect(blocks.length).toBeGreaterThan(0);
      const renders = blocks
        .map((b) => extractRenderFromToolResult(b))
        .filter((r) => r !== null).length;
      // The golden is machine-readable stable-set INPUT: the extract
      // must find exactly as many render-bearing tool results in the
      // native frames as the golden declares tool.done events carrying
      // the `_meta.ui` bootstrap. (Grounded: app-spec-gemini36 declares
      // 1, app-update-sonnet5 declares 2; the structured-result and
      // partials legs declare 0 — for those the equality is the
      // false-positive check on a real stream.)
      expect(renders).toBe(goldenUiToolDones(leg.agjson));

      // Folding: card groups appear for exactly the render-bearing
      // results; group KINDS + counts are stable-set assertions
      // (types/ordering), never prose. Construction per the
      // message-groups.test.ts fixture idiom: one finalized assistant
      // ConversationMessage carrying the mapped block stream.
      const groups = invokeMessageToContentGroups({
        id: `${scenario}-${fw}`,
        role: 'assistant',
        content: blocks,
        isStreaming: false,
      });
      expect(groups.length).toBeGreaterThan(0);
      expect(groups.filter((g) => g.kind === 'card').length).toBe(renders);
    });
  }

  it('the corpus exercises the positive arm (non-vacuity)', () => {
    // Guard against a silent corpus refresh degrading every leg to the
    // zero case: across the four pinned legs the goldens must declare
    // at least one `_meta.ui`-bearing tool completion.
    const total = LEGS.reduce(
      (n, [scenario, fw]) => n + goldenUiToolDones(loadLeg(scenario, fw).agjson),
      0,
    );
    expect(total).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Synthetic contract tier (AgEvent-validated stimulus).
// ---------------------------------------------------------------------------

type TextDeltaEvent = Extract<AgEvent, { type: 'text.delta' }>;

/**
 * Sound for the same reason as the #360 contract test's predicates:
 * `AgEvent`'s catch-all arm only admits `ext.*` types, so a known
 * literal guarantees the schema-parsed shape.
 */
function isTextDelta(ev: AgEvent): ev is TextDeltaEvent {
  return ev.type === 'text.delta';
}

/**
 * Map a synthetic turn's AgEvents to the package's real input shape
 * (the message-groups.test.ts ConversationMessage idiom). Stimulus
 * plumbing only — the rule it encodes is ggui's own documented
 * streaming flag: `isStreaming` is true while blocks are still
 * receiving deltas, and a turn that never reached `turn.done` never
 * finalized (useInvoke.ConversationMessage docs).
 */
function agTurnToConversationMessage(
  events: readonly AgEvent[],
  id: string,
): ConversationMessage {
  const text = events
    .filter(isTextDelta)
    .map((e) => e.delta)
    .join('');
  const finalized = events.some((e) => e.type === 'turn.done');
  return {
    id,
    role: 'assistant',
    content: text.length > 0 ? [{ type: 'text', text }] : [],
    isStreaming: !finalized,
  };
}

describe('synthetic contract tier', () => {
  it('abort mid-stream: folding drops the streaming turn, keeps durable groups', () => {
    // Producer stance: synthetics must be spec-valid (strict parse).
    // Field shapes mirror the pinned goldens (block-id'd text events,
    // outcome-bearing turn.done).
    const durableStimulus = [
      { type: 'turn.start', seq: 0, turnId: 't_dur', threadId: 'th_syn' },
      {
        type: 'message.start',
        seq: 1,
        id: 'm_dur',
        turnId: 't_dur',
        threadId: 'th_syn',
        role: 'assistant',
      },
      { type: 'text.start', seq: 2, id: 'm_dur:text:0', messageId: 'm_dur' },
      {
        type: 'text.delta',
        seq: 3,
        id: 'm_dur:text:0',
        messageId: 'm_dur',
        delta: 'settled answer',
      },
      { type: 'text.end', seq: 4, id: 'm_dur:text:0', messageId: 'm_dur' },
      { type: 'message.end', seq: 5, id: 'm_dur' },
      {
        type: 'turn.done',
        seq: 6,
        turnId: 't_dur',
        outcome: { type: 'success', result: 'settled answer' },
        finishReason: 'stop',
      },
    ].map((e) => AgEvent.parse(e));
    const abortedStimulus = [
      { type: 'turn.start', seq: 0, turnId: 't_abr', threadId: 'th_syn' },
      { type: 'text.start', seq: 1, id: 'm_abr:text:0', messageId: 'm_abr' },
      {
        type: 'text.delta',
        seq: 2,
        id: 'm_abr:text:0',
        messageId: 'm_abr',
        delta: 'partial…',
      },
      { type: 'turn.abort', seq: 3, turnId: 't_abr' },
    ].map((e) => AgEvent.parse(e));
    expect(durableStimulus).toHaveLength(7); // stimulus validity only
    expect(abortedStimulus).toHaveLength(4); // stimulus validity only

    const durable = agTurnToConversationMessage(durableStimulus, 'm_dur');
    const aborted = agTurnToConversationMessage(abortedStimulus, 'm_abr');
    const user: ConversationMessage = {
      id: 'u_syn',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      isStreaming: false,
    };

    // ggui's documented rule, half one: streaming turns yield [] groups
    // (nothing durable yet); finalized turns fold normally.
    expect(aborted.isStreaming).toBe(true);
    expect(invokeMessageToContentGroups(aborted)).toEqual([]);
    expect(invokeMessageToContentGroups(durable).map((g) => g.kind)).toEqual([
      'text',
    ]);

    // Half two: the streaming turn is stripped from the wire history;
    // durable turns survive intact.
    expect(
      conversationMessagesToInvokeHistory([user, durable, aborted]),
    ).toEqual([
      { role: 'user', content: user.content },
      { role: 'assistant', content: durable.content },
    ]);
  });

  it('forward-compat: unrecognized tool families and junk result shapes fold as "other"/skip — never a throw', () => {
    // Constructed per the ContentGroup docs: kinds are text|card|other.
    // Grounded adjustment from the brief's sketch (which posited an
    // unknown block TYPE): `ContentBlock` is a closed discriminated
    // union, so an unrecognized block type cannot reach the fold at all
    // — the wire schema rejects it upstream and typing one locally
    // would require a banned cast. The forward-compat surface this seam
    // actually owns is (a) tool families ggui has never heard of and
    // (b) result content of arbitrary unknown shape.
    const tu: ContentBlock = {
      type: 'tool_use',
      id: 'tu_fc',
      name: 'quantum_flux_tool',
      input: {},
    };
    const junkResult: ContentBlock = {
      type: 'tool_result',
      tool_use_id: 'tu_fc',
      content: { totally: { unexpected: ['shape', 42] } },
    };
    const m: ConversationMessage = {
      id: 'm_fc',
      role: 'assistant',
      content: [tu, junkResult],
      isStreaming: false,
    };
    let groups: ContentGroup[] = [];
    expect(() => {
      groups = invokeMessageToContentGroups(m);
    }).not.toThrow();
    expect(groups.map((g) => g.kind)).toEqual(['other']);
    expect(groups[0]!.cardSnapshot).toBeNull();

    // A standalone tool_result (no owning tool_use) is the fold's skip
    // arm: no group, no throw.
    const orphan: ConversationMessage = {
      id: 'm_fc2',
      role: 'assistant',
      content: [junkResult],
      isStreaming: false,
    };
    expect(invokeMessageToContentGroups(orphan)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guest-gesture Layer-B fixture (ggui-authored, committed — not fetched).
// ---------------------------------------------------------------------------

/**
 * Label a transcript frame by its stable kind. Stable-set vocabulary
 * only: JSON-RPC method + tool name for calls, 'result' for responses.
 * Fixture-reading plumbing (same tolerant-narrow idiom as the cassette
 * mappers above) — the seam under test is imported from src.
 */
function frameKind(frame: unknown): string {
  const f = asRecord(frame);
  if (f === undefined) return 'unknown';
  if (typeof f.method === 'string') {
    if (f.method === 'tools/call') {
      const name = asRecord(f.params)?.name;
      return `tools/call:${typeof name === 'string' ? name : '?'}`;
    }
    return f.method;
  }
  return f.result !== undefined ? 'result' : 'unknown';
}

/** Build a Response whose body is an empty SSE stream (so the hook's
 *  POST resolves) — the useMcpAppsChat harness idiom from
 *  useMcpAppsChat.handleAppMessage.test.tsx. */
function emptySseResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('guest-gesture Layer-B fixture (ggui-authored)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('transcript is the documented round-trip: render result → gesture → doorbell → consume (types + ordering + tool names)', () => {
    const leg = loadLocalLeg('guest-gesture', 'ggui');

    // Stable set: frame types + ordering + tool/method names (the
    // six-frame round-trip the ENROLLMENT.md stable set declares).
    expect(leg.native.map(frameKind)).toEqual([
      'result',
      'tools/call:ggui_runtime_submit_action',
      'result',
      'ui/message',
      'tools/call:ggui_consume',
      'result',
    ]);

    // ggui's own extract (imported from src) recognizes the render
    // result's `_meta.ui` bootstrap — the same oracle as the cassette
    // tier, applied to the authored transcript.
    const renderResult = asRecord(asRecord(leg.native[0])?.result);
    expect(renderResult).toBeDefined();
    expect(
      extractRenderFromToolResult({
        type: 'tool_result',
        tool_use_id: 'render-frame',
        content: renderResult,
      }),
    ).not.toBeNull();

    // Correlation EQUALITIES (stable as equalities across frames; the
    // literal id values are incidental): one sessionId threads render →
    // gesture → consume, and the gesture's intent/actionId reappear on
    // the drained ConsumeEventEntry.
    const sessionId = asRecord(renderResult?.structuredContent)?.sessionId;
    expect(typeof sessionId).toBe('string');
    const gestureArgs = asRecord(
      asRecord(asRecord(leg.native[1])?.params)?.arguments,
    );
    expect(gestureArgs?.kind).toBe('dispatch');
    expect(gestureArgs?.sessionId).toBe(sessionId);
    const consumeArgs = asRecord(
      asRecord(asRecord(leg.native[4])?.params)?.arguments,
    );
    expect(consumeArgs?.sessionId).toBe(sessionId);
    const consumeStructured = asRecord(
      asRecord(asRecord(leg.native[5])?.result)?.structuredContent,
    );
    const events = consumeStructured?.events;
    expect(Array.isArray(events)).toBe(true);
    expect((events as unknown[]).length).toBe(1); // scenario intent: ONE gesture
    const entry = asRecord((events as unknown[])[0]);
    expect(entry?.type).toBe('action');
    expect(entry?.sessionId).toBe(sessionId);
    expect(entry?.intent).toBe(asRecord(gestureArgs?.payload)?.intent);
    expect(entry?.actionId).toBe(gestureArgs?.actionId);
  });

  it('handleAppMessage forwards the doorbell: directive text AS the prompt, _meta opaquely', async () => {
    const leg = loadLocalLeg('guest-gesture', 'ggui');
    const doorbell = asRecord(asRecord(leg.native[3])?.params);
    const blocks = Array.isArray(doorbell?.content) ? doorbell.content : [];
    const block = asRecord(blocks[0]);
    const text = typeof block?.text === 'string' ? block.text : '';
    const meta = asRecord(block?._meta);
    expect(text.length).toBeGreaterThan(0);
    expect(meta).toBeDefined();

    // The structured mirror (`GguiUserActionMeta` on the wire) points
    // the agent at the transcript's follow-up tool — stable: tool name
    // ties doorbell → consume frame. Tolerant narrow, same idiom as
    // the cassette mappers.
    const userAction = asRecord(meta?.['ai.ggui/userAction']);
    expect(userAction?.kind).toBe('user-action');
    const nextTool = asRecord(userAction?.nextStep)?.tool;
    expect(frameKind(leg.native[4])).toBe(
      `tools/call:${typeof nextTool === 'string' ? nextTool : '?'}`,
    );

    // The package's documented stance (chat-helpers/index.ts): the
    // iframe-runtime authored the full directive; the hook forwards the
    // text as the prompt and the content-block `_meta` OPAQUELY as
    // `data.meta` — no synthesis, no key allow-list, no validation.
    const fetchMock = vi.fn<
      (input: string, init?: RequestInit) => Promise<Response>
    >(async () => emptySseResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() =>
      useMcpAppsChat({ chatEndpoint: 'http://x/agent' }),
    );
    let res: Record<string, unknown> = { isError: true };
    await act(async () => {
      res = await result.current.handleAppMessage({
        role: typeof doorbell?.role === 'string' ? doorbell.role : undefined,
        content: [{ type: 'text', text, _meta: meta }],
      });
    });
    expect(res).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
    const body = JSON.parse(typeof rawBody === 'string' ? rawBody : '{}') as {
      kind?: string;
      prompt?: string;
      data?: { meta?: Record<string, unknown> };
    };
    expect(body.kind).toBe('chat');
    // Forwarding EQUALITY input→output — not a prose-content pin: the
    // fixture's directive text (whatever its wording) IS the prompt.
    expect(body.prompt).toBe(text);
    // Opaque `_meta` forwarding — deep-equal, `ai.ggui/userAction`
    // key intact, nothing stripped or rewritten.
    expect(body.data?.meta).toEqual(meta);
  });
});
