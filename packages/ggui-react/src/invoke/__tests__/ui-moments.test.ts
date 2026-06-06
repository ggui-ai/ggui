/**
 * Tests for {@link extractUiMoments} — the shell-side helper that reads
 * invoke-SSE `ConversationMessage[]` and produces the set of UI moments
 * to mount as `<AppRenderer>`. Pure function; no React.
 *
 * Covers both recognition paths:
 *   - render-resource — URL from `{sessionId}` (GguiRenderOutput shape);
 *   - inline meta — `_meta["ai.ggui/render"]` slice
 *     ({@link McpAppAiGguiRenderMeta}).
 * Plus precedence (inline wins), filtering of non-ggui tool_results,
 * and origin trimming.
 *
 * Post-Phase-B: the old two-slice `{session, stackItem}` shape collapses
 * into a single flat render slice; the URL path collapses to
 * `/api/sessions/<sessionId>/resource`.
 */
import { describe, it, expect } from 'vitest';
import { toMcpAppEnvelope } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { ConversationMessage } from '../useInvoke';
import { extractUiMoments } from '../ui-moments';

const META_INLINE: McpAppAiGguiRenderMeta = {
  sessionId: 'session_inline',
  appId: 'app_inline',
  runtimeUrl: '/_ggui/iframe-runtime.js',
  wsUrl: 'wss://mcp.example.test/ws',
  wsToken: 'bootstrap_token_abc',
  expiresAt: '2026-05-01T00:00:00.000Z',
};

const META_INLINE_B: McpAppAiGguiRenderMeta = {
  sessionId: 'session_inline_b',
  appId: 'app_inline_b',
  runtimeUrl: '/_ggui/iframe-runtime.js',
  wsUrl: 'wss://mcp.example.test/ws',
  wsToken: 'bootstrap_token_def',
  expiresAt: '2026-05-01T00:00:00.000Z',
};

function assistantWith(
  content: ConversationMessage['content'],
  id = 'msg_1',
): ConversationMessage {
  return { id, role: 'assistant', content, isStreaming: false };
}

describe('extractUiMoments', () => {
  it('returns empty when no messages', () => {
    expect(extractUiMoments([])).toEqual([]);
  });

  it('returns empty when messages have no tool_result blocks', () => {
    const messages = [
      assistantWith([{ type: 'text', text: 'hi' }]),
      {
        id: 'msg_2',
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        isStreaming: false,
      } as ConversationMessage,
    ];
    expect(extractUiMoments(messages)).toEqual([]);
  });

  describe('render-resource URL from GguiRenderOutput', () => {
    it('builds URL when origin + {sessionId} are present', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_render_1',
            content: {
              sessionId: 'session_abc',
              shortCode: 'xyz',
              url: 'https://example/preview/xyz',
              action: 'create',
              codeReady: true,
            },
          },
        ]),
      ];
      const out = extractUiMoments(messages, {
        renderResourceOrigin: 'https://api.example.test',
      });
      expect(out).toEqual([
        {
          key: 'toolu_render_1',
          sessionId: 'session_abc',
          source: {
            kind: 'render-resource',
            url: 'https://api.example.test/api/sessions/render_abc/resource',
          },
        },
      ]);
    });

    it('skips when origin missing even if shape matches', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_render_1',
            content: { sessionId: 'session_p' },
          },
        ]),
      ];
      expect(extractUiMoments(messages)).toEqual([]);
    });

    it('trims trailing slashes on origin', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_render_1',
            content: { sessionId: 'session_p' },
          },
        ]),
      ];
      const out = extractUiMoments(messages, {
        renderResourceOrigin: 'https://api.example.test///',
      });
      expect(out[0]?.source.kind).toBe('render-resource');
      if (out[0]?.source.kind === 'render-resource') {
        expect(out[0].source.url).toBe(
          'https://api.example.test/api/sessions/render_p/resource',
        );
      }
    });

    it('URL-encodes sessionId with unsafe characters', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_render_1',
            content: { sessionId: 'session/weird id?x=1' },
          },
        ]),
      ];
      const out = extractUiMoments(messages, {
        renderResourceOrigin: 'https://api.example.test',
      });
      if (out[0]?.source.kind === 'render-resource') {
        expect(out[0].source.url).toBe(
          'https://api.example.test/api/sessions/session%2Fweird%20id%3Fx%3D1/resource',
        );
      }
    });

    it('tolerates one level of wrapping — {result: renderOutput}', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_render_1',
            content: { result: { sessionId: 'session_p' } },
          },
        ]),
      ];
      const out = extractUiMoments(messages, {
        renderResourceOrigin: 'https://api.example.test',
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.sessionId).toBe('session_p');
    });

    it('skips tool_result with no sessionId field', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_render_1',
            content: { other: 'irrelevant' },
          },
        ]),
      ];
      expect(
        extractUiMoments(messages, { renderResourceOrigin: 'https://x.test' }),
      ).toEqual([]);
    });
  });

  describe('inline meta from ai.ggui/render slice', () => {
    it('extracts meta and uses meta.sessionId', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_render_c1',
            content: { _meta: toMcpAppEnvelope(META_INLINE) },
          },
        ]),
      ];
      const out = extractUiMoments(messages);
      expect(out).toEqual([
        {
          key: 'toolu_render_c1',
          sessionId: META_INLINE.sessionId,
          source: { kind: 'bootstrap-inline', meta: META_INLINE },
        },
      ]);
    });

    it('works without an origin (no URL construction needed)', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_render_c3',
            content: { _meta: toMcpAppEnvelope(META_INLINE) },
          },
        ]),
      ];
      const out = extractUiMoments(messages);
      expect(out).toHaveLength(1);
      expect(out[0]?.source.kind).toBe('bootstrap-inline');
    });
  });

  describe('precedence — inline meta wins over render-resource coords', () => {
    it('when both signals present, chooses bootstrap-inline', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_render_mixed',
            content: {
              sessionId: 'session_coord_only',
              _meta: toMcpAppEnvelope(META_INLINE),
            },
          },
        ]),
      ];
      const out = extractUiMoments(messages, {
        renderResourceOrigin: 'https://api.example.test',
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.source.kind).toBe('bootstrap-inline');
      // sessionId follows meta.sessionId, not the coordinate field.
      expect(out[0]?.sessionId).toBe(META_INLINE.sessionId);
    });
  });

  describe('filtering — non-ggui tool_results drop silently', () => {
    it('drops text-only tool_result (no sessionId, no _meta)', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_search',
            content: { text: 'search hit: ...' },
          },
        ]),
      ];
      expect(
        extractUiMoments(messages, { renderResourceOrigin: 'https://x.test' }),
      ).toEqual([]);
    });

    it('drops error tool_result (is_error: true, no coordinates)', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_failed',
            content: { error: 'something broke' },
            is_error: true,
          },
        ]),
      ];
      expect(
        extractUiMoments(messages, { renderResourceOrigin: 'https://x.test' }),
      ).toEqual([]);
    });

    it('interleaves ggui and non-ggui tool_results correctly', () => {
      const messages = [
        assistantWith([
          { type: 'text', text: 'okay, one sec' },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_search',
            content: { text: 'non-ui tool' },
          },
          { type: 'text', text: 'now rendering…' },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_render_a',
            content: { sessionId: 'session_a' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_render_b',
            content: { _meta: toMcpAppEnvelope(META_INLINE_B) },
          },
        ]),
      ];
      const out = extractUiMoments(messages, {
        renderResourceOrigin: 'https://api.example.test',
      });
      expect(out.map((m) => m.key)).toEqual(['toolu_render_a', 'toolu_render_b']);
      expect(out[0]?.source.kind).toBe('render-resource');
      expect(out[1]?.source.kind).toBe('bootstrap-inline');
    });
  });

  describe('ordering — message order is preserved', () => {
    it('moments across multiple messages come out in stream order', () => {
      const messages = [
        assistantWith(
          [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_m1_a',
              content: { sessionId: 'session_m1' },
            },
          ],
          'msg_1',
        ),
        assistantWith(
          [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_m2_a',
              content: { sessionId: 'session_m2' },
            },
          ],
          'msg_2',
        ),
      ];
      const out = extractUiMoments(messages, {
        renderResourceOrigin: 'https://api.example.test',
      });
      expect(out.map((m) => m.key)).toEqual(['toolu_m1_a', 'toolu_m2_a']);
    });
  });
});
