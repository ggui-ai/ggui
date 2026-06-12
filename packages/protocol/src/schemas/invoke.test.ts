/**
 * Round-trip tests for the streamable invoke event schemas.
 *
 * These are wire-contract tests, not behavioural tests: they pin the exact
 * shape of every event variant so that any breaking change to the schema
 * surfaces in CI before @ggui-ai/server or @ggui-ai/react silently
 * drift apart.
 *
 * Spec: docs/superpowers/specs/2026-04-13-streamable-invoke-protocol.md
 */
import { describe, it, expect } from 'vitest';
import {
  invokeEventSchema,
  invokeRequestSchema,
  contentBlockSchema,
  invokeErrorCodeSchema,
} from './invoke';
import type { z } from 'zod';
import type {
  InvokeEvent,
  ContentBlock,
} from '../types/invoke';

// The published `InvokeRequest` alias was deleted in draft-2026-06-12
// (zero consumers); the schema remains the contract — infer locally.
type InvokeRequest = z.infer<typeof invokeRequestSchema>;

// ── Fixtures — one per event type ────────────────────────────────────

const fixtures: Record<InvokeEvent['type'], InvokeEvent> = {
  message_start: {
    type: 'message_start',
    message: { id: 'msg_01', role: 'assistant', model: 'claude-sonnet-4-6' },
  },
  content_block_start: {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  content_block_delta: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello' },
  },
  content_block_stop: {
    type: 'content_block_stop',
    index: 0,
  },
  message_delta: {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { input_tokens: 12, output_tokens: 34 },
  },
  message_stop: { type: 'message_stop' },
  ping: { type: 'ping' },
  error: {
    type: 'error',
    error: { code: 'invoke_in_progress', message: 'busy', retryAfterMs: 1500 },
  },
};

describe('invoke event schemas', () => {
  it('every event type round-trips through parse → JSON → parse', () => {
    for (const [name, event] of Object.entries(fixtures)) {
      const parsed = invokeEventSchema.parse(event);
      expect(parsed.type).toBe(name);
      const serialized = JSON.parse(JSON.stringify(parsed));
      expect(invokeEventSchema.parse(serialized)).toEqual(event);
    }
  });

  it('rejects unknown event types', () => {
    expect(() => invokeEventSchema.parse({ type: 'message_continue' })).toThrow();
  });

  it('rejects unknown content block types', () => {
    expect(() =>
      invokeEventSchema.parse({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'image', url: 'x' },
      }),
    ).toThrow();
  });

  it('rejects unknown delta types', () => {
    expect(() =>
      invokeEventSchema.parse({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'binary_delta', bytes: 'x' },
      }),
    ).toThrow();
  });

  it('rejects negative or non-integer block indices', () => {
    for (const bad of [-1, 1.5, '0', null]) {
      expect(() =>
        invokeEventSchema.parse({
          type: 'content_block_stop',
          index: bad,
        }),
      ).toThrow();
    }
  });
});

describe('content block schemas', () => {
  it('parses the three legal block types (text, tool_use, tool_result)', () => {
    const text: ContentBlock = { type: 'text', text: 'hi' };
    const call: ContentBlock = {
      type: 'tool_use',
      id: 'tool_1',
      name: 'ggui_render',
      input: { story: { intent: 'show weather' } },
    };
    const result: ContentBlock = {
      type: 'tool_result',
      tool_use_id: 'tool_1',
      content: { sessionId: 'render_new', shortCode: 'abc', url: 'https://render.ggui.ai/abc' },
    };
    expect(contentBlockSchema.parse(text)).toEqual(text);
    expect(contentBlockSchema.parse(call)).toEqual(call);
    expect(contentBlockSchema.parse(result)).toEqual(result);
  });

  it('accepts tool_result with is_error flag', () => {
    const errResult: ContentBlock = {
      type: 'tool_result',
      tool_use_id: 'tool_2',
      content: { error: 'not found' },
      is_error: true,
    };
    expect(contentBlockSchema.parse(errResult)).toEqual(errResult);
  });

  it('rejects tool_result without tool_use_id', () => {
    expect(() =>
      contentBlockSchema.parse({
        type: 'tool_result',
        content: { ok: true },
      }),
    ).toThrow();
  });

  it('rejects legacy ggui_session blocks (dropped in v1 final)', () => {
    expect(() =>
      contentBlockSchema.parse({
        type: 'ggui_session',
        sessionId: 'sess_1',
        stackItemId: 'card_1',
        shortCode: 'abc',
        url: 'https://render.ggui.ai/abc',
        action: 'create',
      }),
    ).toThrow();
  });
});

describe('error code enum', () => {
  it('accepts every documented code', () => {
    const codes = [
      'invalid_request',
      'unauthorized',
      'rate_limited',
      'invoke_in_progress',
      'upstream_error',
      'tool_error',
      'internal',
    ];
    for (const code of codes) {
      expect(invokeErrorCodeSchema.parse(code)).toBe(code);
    }
  });

  it('rejects undocumented codes', () => {
    expect(() => invokeErrorCodeSchema.parse('not_found')).toThrow();
  });
});

describe('invoke request schema', () => {
  it('accepts a minimal request (message only)', () => {
    const req: InvokeRequest = { message: 'hi' };
    expect(invokeRequestSchema.parse(req)).toEqual(req);
  });

  it('accepts a full request with history of mixed string + structured turns', () => {
    const req: InvokeRequest = {
      message: 'and now the weather?',
      history: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hi! How can I help?' },
            {
              type: 'tool_use',
              id: 'tool_prior',
              name: 'ggui_render',
              input: { componentId: 'cmp_prior' },
            },
          ],
        },
      ],
      requestId: 'req_xyz',
    };
    expect(invokeRequestSchema.parse(req)).toEqual(req);
  });

  it('rejects history turns with an unknown role', () => {
    expect(() =>
      invokeRequestSchema.parse({
        message: 'x',
        history: [{ role: 'system', content: 'be helpful' }],
      }),
    ).toThrow();
  });
});
