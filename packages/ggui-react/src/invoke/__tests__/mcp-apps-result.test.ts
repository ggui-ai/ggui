/**
 * Tests for `extractBootstrapMeta` + round-trip parse over the SSE wire
 * — the consumer side of the S1' `@ggui-ai/server` ↔ `@ggui-ai/react`
 * MCP Apps tool-result convention.
 *
 * Sibling test in `@ggui-ai/server` asserts emission shape
 * (`InvokeStream.toolResultPush`). Both tests use the same
 * {@link FIXTURE_BOOTSTRAP} so a green pair proves the bootstrap
 * survives the wire bit-for-bit.
 */
import { describe, it, expect } from 'vitest';
import { bootstrapToMcpAppMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { GguiBootstrapMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { InvokeEvent } from '@ggui-ai/protocol';
import { extractBootstrapMeta } from '../mcp-apps-result';
import { parseSseStream } from '../sse-parse';

/** MUST match `@ggui-ai/server/src/invoke/__tests__/tool-result-push.test.ts`. */
const FIXTURE_BOOTSTRAP: GguiBootstrapMeta = {
  wsUrl: 'wss://mcp.example.test/ws',
  token: 'bootstrap_token_abc123',
  expiresAt: '2026-05-01T00:00:00.000Z',
  sessionId: 'sess_XYZ',
  appId: 'app_round_trip',
  runtimeUrl: '/_ggui/iframe-runtime.js',
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

describe('extractBootstrapMeta', () => {
  it('returns the bootstrap on well-shaped content', () => {
    const content = {
      sessionId: FIXTURE_BOOTSTRAP.sessionId,
      _meta: bootstrapToMcpAppMeta(FIXTURE_BOOTSTRAP),
    };
    expect(extractBootstrapMeta(content)).toEqual(FIXTURE_BOOTSTRAP);
  });

  it('returns the bootstrap even when structuredContent is absent', () => {
    expect(
      extractBootstrapMeta({
        _meta: bootstrapToMcpAppMeta(FIXTURE_BOOTSTRAP),
      }),
    ).toEqual(FIXTURE_BOOTSTRAP);
  });

  it('returns null on non-bootstrap tool_results (legitimate)', () => {
    // ggui_update / ggui_pop / ggui_request_credential etc. have no bootstrap.
    expect(extractBootstrapMeta({ ok: true })).toBeNull();
    expect(extractBootstrapMeta({ _meta: { ggui: {} } })).toBeNull();
    expect(extractBootstrapMeta({ _meta: { other: {} } })).toBeNull();
  });

  it('returns null on malformed bootstrap (missing required field)', () => {
    const partial = { ...FIXTURE_BOOTSTRAP, runtimeUrl: undefined };
    expect(
      extractBootstrapMeta({ _meta: bootstrapToMcpAppMeta(partial) }),
    ).toBeNull();
  });

  it('returns null on null / non-object inputs', () => {
    expect(extractBootstrapMeta(null)).toBeNull();
    expect(extractBootstrapMeta(undefined)).toBeNull();
    expect(extractBootstrapMeta('string')).toBeNull();
    expect(extractBootstrapMeta(42)).toBeNull();
  });
});

describe('SSE round-trip: parseSseStream → extractBootstrapMeta', () => {
  it('recovers the fixture bootstrap bit-for-bit from a tool_result frame', async () => {
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
            sessionId: FIXTURE_BOOTSTRAP.sessionId,
            _meta: bootstrapToMcpAppMeta(FIXTURE_BOOTSTRAP),
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
    const recovered = extractBootstrapMeta(toolResultFrame.content_block.content);
    expect(recovered).toEqual(FIXTURE_BOOTSTRAP);
  });
});
