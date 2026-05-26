/**
 * Tests for {@link extractUiMoments} — the shell-side helper that reads
 * invoke-SSE `ConversationMessage[]` and produces the set of UI moments
 * to mount as `<McpAppIframe>`. Pure function; no React.
 *
 * Covers both recognition paths per Phase 3 Wave 1 close-out:
 *   - option (b) — session-resource URL from `{sessionId, stackItemId}`;
 *   - option (c) — inline meta pair from the `ai.ggui/*` slices.
 * Plus precedence (c > b), filtering of non-ggui tool_results, and
 * origin trimming.
 */
import { describe, it, expect } from 'vitest';
import { metaToMcpAppMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { McpAppAiGguiMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { ConversationMessage } from '../useInvoke';
import { extractUiMoments } from '../ui-moments';

const META_WITH_ITEM: McpAppAiGguiMeta = {
  session: {
    wsUrl: 'wss://mcp.example.test/ws',
    token: 'bootstrap_token_abc',
    expiresAt: '2026-05-01T00:00:00.000Z',
    sessionId: 'sess_inline',
    appId: 'app_inline',
    runtimeUrl: '/_ggui/iframe-runtime.js',
  },
  stackItem: {
    stackItemId: 'item_pinned',
  },
};

const META_NO_ITEM: McpAppAiGguiMeta = {
  session: {
    wsUrl: 'wss://mcp.example.test/ws',
    token: 'bootstrap_token_def',
    expiresAt: '2026-05-01T00:00:00.000Z',
    sessionId: 'sess_whole',
    appId: 'app_whole',
    runtimeUrl: '/_ggui/iframe-runtime.js',
  },
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

  describe('option (b) — session-resource URL from GguiPushOutput', () => {
    it('builds URL when origin + {sessionId, stackItemId} both present', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_push_1',
            content: {
              sessionId: 'sess_123',
              stackItemId: 'page_abc',
              shortCode: 'xyz',
              url: 'https://example/preview/xyz',
              action: 'create',
              codeReady: true,
            },
          },
        ]),
      ];
      const out = extractUiMoments(messages, {
        sessionResourceOrigin: 'https://api.example.test',
      });
      expect(out).toEqual([
        {
          key: 'toolu_push_1',
          itemId: 'page_abc',
          source: {
            kind: 'session-resource',
            url: 'https://api.example.test/ggui/session-resource/item/sess_123/page_abc',
          },
        },
      ]);
    });

    it('skips when origin missing even if shape matches', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_push_1',
            content: { sessionId: 's', stackItemId: 'p' },
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
            tool_use_id: 'toolu_push_1',
            content: { sessionId: 's', stackItemId: 'p' },
          },
        ]),
      ];
      const out = extractUiMoments(messages, {
        sessionResourceOrigin: 'https://api.example.test///',
      });
      expect(out[0]?.source.kind).toBe('session-resource');
      if (out[0]?.source.kind === 'session-resource') {
        expect(out[0].source.url).toBe(
          'https://api.example.test/ggui/session-resource/item/s/p',
        );
      }
    });

    it('URL-encodes session + page ids with unsafe characters', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_push_1',
            content: { sessionId: 'sess/weird id', stackItemId: 'page?x=1' },
          },
        ]),
      ];
      const out = extractUiMoments(messages, {
        sessionResourceOrigin: 'https://api.example.test',
      });
      if (out[0]?.source.kind === 'session-resource') {
        expect(out[0].source.url).toBe(
          'https://api.example.test/ggui/session-resource/item/sess%2Fweird%20id/page%3Fx%3D1',
        );
      }
    });

    it('tolerates one level of wrapping — {result: pushOutput}', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_push_1',
            content: { result: { sessionId: 's', stackItemId: 'p' } },
          },
        ]),
      ];
      const out = extractUiMoments(messages, {
        sessionResourceOrigin: 'https://api.example.test',
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.itemId).toBe('p');
    });

    it('skips tool_result with only partial shape (sessionId but no stackItemId)', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_push_1',
            content: { sessionId: 's' },
          },
        ]),
      ];
      expect(
        extractUiMoments(messages, { sessionResourceOrigin: 'https://x.test' }),
      ).toEqual([]);
    });
  });

  describe('option (c) — inline meta from ai.ggui/* slices', () => {
    it('extracts meta and uses stackItem.stackItemId as itemId when present', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_push_c1',
            content: { _meta: metaToMcpAppMeta(META_WITH_ITEM) },
          },
        ]),
      ];
      const out = extractUiMoments(messages);
      expect(out).toEqual([
        {
          key: 'toolu_push_c1',
          itemId: 'item_pinned',
          source: { kind: 'bootstrap-inline', meta: META_WITH_ITEM },
        },
      ]);
    });

    it('falls back to tool_use_id as itemId when meta has no stackItem.stackItemId', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_push_c2',
            content: { _meta: metaToMcpAppMeta(META_NO_ITEM) },
          },
        ]),
      ];
      const out = extractUiMoments(messages);
      expect(out[0]?.itemId).toBe('toolu_push_c2');
    });

    it('works without an origin (no URL construction needed)', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_push_c3',
            content: { _meta: metaToMcpAppMeta(META_WITH_ITEM) },
          },
        ]),
      ];
      const out = extractUiMoments(messages);
      expect(out).toHaveLength(1);
      expect(out[0]?.source.kind).toBe('bootstrap-inline');
    });
  });

  describe('precedence — inline meta wins over push-coordinates', () => {
    it('when both signals present, chooses bootstrap-inline', () => {
      const messages = [
        assistantWith([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_push_mixed',
            content: {
              sessionId: 'push_coord_sid',
              stackItemId: 'push_coord_pid',
              _meta: metaToMcpAppMeta(META_WITH_ITEM),
            },
          },
        ]),
      ];
      const out = extractUiMoments(messages, {
        sessionResourceOrigin: 'https://api.example.test',
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.source.kind).toBe('bootstrap-inline');
      // itemId follows stackItem.stackItemId, not pushCoord.stackItemId
      expect(out[0]?.itemId).toBe('item_pinned');
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
        extractUiMoments(messages, { sessionResourceOrigin: 'https://x.test' }),
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
        extractUiMoments(messages, { sessionResourceOrigin: 'https://x.test' }),
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
            tool_use_id: 'toolu_push_a',
            content: { sessionId: 's1', stackItemId: 'p1' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_push_b',
            content: { _meta: metaToMcpAppMeta(META_WITH_ITEM) },
          },
        ]),
      ];
      const out = extractUiMoments(messages, {
        sessionResourceOrigin: 'https://api.example.test',
      });
      expect(out.map((m) => m.key)).toEqual(['toolu_push_a', 'toolu_push_b']);
      expect(out[0]?.source.kind).toBe('session-resource');
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
              content: { sessionId: 's', stackItemId: 'p_m1' },
            },
          ],
          'msg_1',
        ),
        assistantWith(
          [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_m2_a',
              content: { sessionId: 's', stackItemId: 'p_m2' },
            },
          ],
          'msg_2',
        ),
      ];
      const out = extractUiMoments(messages, {
        sessionResourceOrigin: 'https://api.example.test',
      });
      expect(out.map((m) => m.key)).toEqual(['toolu_m1_a', 'toolu_m2_a']);
    });
  });
});
