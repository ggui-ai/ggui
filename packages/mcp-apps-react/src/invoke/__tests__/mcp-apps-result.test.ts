/**
 * Tests for `extractMcpAppAiGguiMeta` + round-trip parse over the SSE
 * wire — the consumer side of the `@ggui-ai/server` ↔
 * `@ggui-ai/mcp-apps-react` MCP Apps tool-result convention.
 *
 * Sibling test in `@ggui-ai/server` asserts emission shape
 * (`InvokeStream.toolResultPush`). Both tests use the same
 * {@link FIXTURE_META} so a green pair proves the meta slice survives
 * the wire bit-for-bit.
 *
 * Post-Phase-B: the two-slice `{session, stackItem}` shape collapses
 * into a single flat `McpAppAiGguiRenderMeta` slice keyed by `sessionId`.
 */
import { describe, it, expect, vi } from 'vitest';
import { toMcpAppEnvelope } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { InvokeEvent } from '@ggui-ai/protocol';
import { extractMcpAppAiGguiMeta } from '../mcp-apps-result';
import { parseSseStream } from '../sse-parse';

/** MUST match `@ggui-ai/server/src/invoke/__tests__/tool-result-push.test.ts`. */
const FIXTURE_META: McpAppAiGguiRenderMeta = {
  sessionId: 'session_XYZ',
  appId: 'app_round_trip',
  runtimeUrl: '/_ggui/iframe-runtime.js',
  wsUrl: 'wss://mcp.example.test/ws',
  wsToken: 'bootstrap_token_abc123',
  expiresAt: '2026-05-01T00:00:00.000Z',
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
  it('returns the meta on well-shaped content', () => {
    const content = {
      sessionId: FIXTURE_META.sessionId,
      _meta: toMcpAppEnvelope(FIXTURE_META),
    };
    expect(extractMcpAppAiGguiMeta(content)).toEqual(FIXTURE_META);
  });

  it('returns the meta even when structuredContent is absent', () => {
    expect(
      extractMcpAppAiGguiMeta({
        _meta: toMcpAppEnvelope(FIXTURE_META),
      }),
    ).toEqual(FIXTURE_META);
  });

  it('returns null on non-meta tool_results (legitimate)', () => {
    // ggui_amend / ggui_consume etc. have no ai.ggui/* meta slices.
    expect(extractMcpAppAiGguiMeta({ ok: true })).toBeNull();
    expect(extractMcpAppAiGguiMeta({ _meta: { ggui: {} } })).toBeNull();
    expect(extractMcpAppAiGguiMeta({ _meta: { other: {} } })).toBeNull();
  });

  it('returns null on malformed render slice (missing required field)', () => {
    // Drop `runtimeUrl` from the slice — parser rejects.
    const malformed = {
      _meta: {
        'ai.ggui/render': {
          sessionId: FIXTURE_META.sessionId,
          appId: FIXTURE_META.appId,
          // runtimeUrl intentionally absent
          wsUrl: FIXTURE_META.wsUrl,
          wsToken: FIXTURE_META.wsToken,
          expiresAt: FIXTURE_META.expiresAt,
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
  it('recovers the fixture meta bit-for-bit from a tool_result frame', async () => {
    // Hand-built InvokeEvent sequence mirroring what
    // InvokeStream.toolResultPush() emits (sibling server test asserts
    // this emission shape directly).
    const toolUseId = 'tu_render_roundtrip';
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
          name: 'ggui_render',
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
            sessionId: FIXTURE_META.sessionId,
            _meta: toMcpAppEnvelope(FIXTURE_META),
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

// ggui#1093 O2 — the host helper's read door is never silent: a theme the
// door refuses (#987 §3.4) and members it strips (#1093 belt, §3.6) reach
// the caller's observability, and warn when the caller wires none.
describe('extractMcpAppAiGguiMeta — the read door reports what it dropped', () => {
  const base = {
    sessionId: 'sess-1',
    appId: 'app-1',
    runtimeUrl: 'https://runtime.example/bundle.js',
    codeUrl: 'https://code.example/component.js',
  };
  const withTheme = (theme: unknown) => ({ _meta: { 'ai.ggui/render': { ...base, theme } } });

  it('calls onInvalidTheme with the issues and mounts without the theme', () => {
    const issues: string[][] = [];
    const meta = extractMcpAppAiGguiMeta(
      withTheme({ mode: 'dark', cssVariables: { '--ggui-color-ground': '#fff' } }),
      { onInvalidTheme: (i) => issues.push([...i]) },
    );
    expect(meta?.sessionId).toBe('sess-1');
    expect(meta?.theme).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.length).toBeGreaterThan(0);
  });

  it('calls onStrippedThemeMembers with the keys and keeps the theme', () => {
    const keys: string[][] = [];
    const meta = extractMcpAppAiGguiMeta(
      withTheme({ overlayHash: 'ab'.repeat(32), overlays: { light: {}, dark: {} }, sparkle: 1 }),
      { onStrippedThemeMembers: (k) => keys.push([...k]) },
    );
    expect(meta?.theme?.overlayHash).toBe('ab'.repeat(32));
    expect(keys).toEqual([['sparkle']]);
  });

  it('with no callbacks wired it WARNS rather than dropping in silence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    extractMcpAppAiGguiMeta(withTheme({ mode: 'dark', cssVariables: {} }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('theme');
    warn.mockClear();
    extractMcpAppAiGguiMeta(withTheme({ overlayHash: 'ab'.repeat(32), overlays: { light: {}, dark: {} } }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
