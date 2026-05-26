/**
 * Tests for `extractMcpAppAiGguiMeta` + round-trip parse over the SSE
 * wire — the consumer side of the S1' `@ggui-ai/server` ↔
 * `@ggui-ai/react` MCP Apps tool-result convention.
 *
 * Sibling test in `@ggui-ai/server` asserts emission shape
 * (`InvokeStream.toolResultPush`). Both tests use the same
 * {@link FIXTURE_META} so a green pair proves the meta slice pair
 * survives the wire bit-for-bit.
 */
import { describe, it, expect } from 'vitest';
import { metaToMcpAppMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { McpAppAiGguiMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { InvokeEvent } from '@ggui-ai/protocol';
import { extractMcpAppAiGguiMeta } from '../mcp-apps-result';
import { parseSseStream } from '../sse-parse';

/** MUST match `@ggui-ai/server/src/invoke/__tests__/tool-result-push.test.ts`. */
const FIXTURE_META: McpAppAiGguiMeta = {
  session: {
    wsUrl: 'wss://mcp.example.test/ws',
    token: 'bootstrap_token_abc123',
    expiresAt: '2026-05-01T00:00:00.000Z',
    sessionId: 'sess_XYZ',
    appId: 'app_round_trip',
    runtimeUrl: '/_ggui/iframe-runtime.js',
  },
};

/** Encode a sequence of InvokeEvent JSON payloads as an SSE body. */
function encodeSse(events: InvokeEvent[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const chunks = events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(chunks));
      c.close();
    },
  });
}

describe('extractMcpAppAiGguiMeta', () => {
  it('returns the meta pair on well-shaped content', () => {
    const content = {
      sessionId: FIXTURE_META.session?.sessionId,
      _meta: metaToMcpAppMeta(FIXTURE_META),
    };
    expect(extractMcpAppAiGguiMeta(content)).toEqual(FIXTURE_META);
  });

  it('returns the meta pair even when structuredContent is absent', () => {
    expect(
      extractMcpAppAiGguiMeta({
        _meta: metaToMcpAppMeta(FIXTURE_META),
      }),
    ).toEqual(FIXTURE_META);
  });

  it('returns null on non-meta tool_results (legitimate)', () => {
    // ggui_update / ggui_pop / ggui_request_credential etc. have no
    // ai.ggui/* meta slices.
    expect(extractMcpAppAiGguiMeta({ ok: true })).toBeNull();
    expect(extractMcpAppAiGguiMeta({ _meta: { ggui: {} } })).toBeNull();
    expect(extractMcpAppAiGguiMeta({ _meta: { other: {} } })).toBeNull();
  });

  it('returns null on malformed session slice (missing required field)', () => {
    // Drop `runtimeUrl` from the session slice — combiner rejects.
    const malformed = {
      _meta: {
        'ai.ggui/session': {
          sessionId: FIXTURE_META.session?.sessionId,
          appId: FIXTURE_META.session?.appId,
          // runtimeUrl intentionally absent
          wsUrl: FIXTURE_META.session?.wsUrl,
          token: FIXTURE_META.session?.token,
          expiresAt: FIXTURE_META.session?.expiresAt,
        },
      },
    };
    expect(extractMcpAppAiGguiMeta(malformed)).toBeNull();
  });

  it('returns null on null / non-object inputs', () => {
    expect(extractMcpAppAiGguiMeta(null)).toBeNull();
    expect(extractMcpAppAiGguiMeta(undefined)).toBeNull();
    expect(extractMcpAppAiGguiMeta('string')).toBeNull();
    expect(extractMcpAppAiGguiMeta(42)).toBeNull();
  });
});

describe('SSE round-trip: parseSseStream → extractMcpAppAiGguiMeta', () => {
  it('recovers the fixture meta pair bit-for-bit from a tool_result frame', async () => {
    // Hand-built InvokeEvent sequence mirroring what
    // InvokeStream.toolResultPush() emits (sibling server test asserts
    // this emission shape directly).
    const toolUseId = 'tu_push_roundtrip';
    const events: InvokeEvent[] = [
      {
        type: 'message_start',
        message: { id: 'msg_rt', role: 'assistant' },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: toolUseId,
          name: 'ggui_push',
          input: {},
        },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: {
            sessionId: FIXTURE_META.session?.sessionId,
            _meta: metaToMcpAppMeta(FIXTURE_META),
          },
        },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ];

    const body = encodeSse(events);
    const received: InvokeEvent[] = [];
    for await (const e of parseSseStream(body)) received.push(e);

    const toolResultFrame = received.find(
      (e): e is Extract<InvokeEvent, { type: 'content_block_start' }> =>
        e.type === 'content_block_start' &&
        e.content_block.type === 'tool_result',
    );
    expect(toolResultFrame).toBeDefined();
    if (!toolResultFrame || toolResultFrame.content_block.type !== 'tool_result') {
      throw new Error('unreachable');
    }
    const recovered = extractMcpAppAiGguiMeta(toolResultFrame.content_block.content);
    expect(recovered).toEqual(FIXTURE_META);
  });
});
