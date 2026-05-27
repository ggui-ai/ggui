/**
 * Tests for `buildRows` — ChatShell's internal presentation helper that
 * interleaves invoke-SSE ConversationMessage content blocks with derived
 * UiMoments into a render-ordered row list.
 *
 * Pure function, no React. The helper is `@internal` (exported for
 * these tests only); ChatShell consumes it inside useMemo.
 */
import { describe, it, expect } from 'vitest';
import type { ConversationMessage } from '../../invoke/useInvoke';
import type { UiMoment } from '../../invoke/ui-moments';
import { buildRows, type ChatRow } from '../ChatShell';

function userMessage(id: string, text: string): ConversationMessage {
  return { id, role: 'user', content: [{ type: 'text', text }], isStreaming: false };
}

function assistantMessage(
  id: string,
  content: ConversationMessage['content'],
  isStreaming = false,
): ConversationMessage {
  return { id, role: 'assistant', content, isStreaming };
}

function renderMoment(key: string, url: string, renderId: string): UiMoment {
  return { key, renderId, source: { kind: 'render-resource', url } };
}

describe('buildRows', () => {
  it('returns empty for empty messages', () => {
    expect(buildRows([], [])).toEqual([]);
  });

  it('emits one text row per user message (text sender=user)', () => {
    const rows = buildRows([userMessage('u1', 'hello')], []);
    expect(rows).toEqual<ChatRow[]>([
      { kind: 'text', key: 'u1:user', sender: 'user', text: 'hello', streaming: false },
    ]);
  });

  it('emits one text row per assistant text block', () => {
    const messages = [
      assistantMessage('m1', [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    ];
    const rows = buildRows(messages, []);
    expect(rows).toEqual<ChatRow[]>([
      { kind: 'text', key: 'm1:0', sender: 'agent', text: 'first', streaming: false },
      { kind: 'text', key: 'm1:1', sender: 'agent', text: 'second', streaming: false },
    ]);
  });

  it('skips empty-text assistant blocks (no bubble for in-progress deltas with no text yet)', () => {
    const messages = [
      assistantMessage('m1', [{ type: 'text', text: '' }], true),
    ];
    expect(buildRows(messages, [])).toEqual([]);
  });

  it('propagates isStreaming onto all text rows from a streaming assistant message', () => {
    const messages = [
      assistantMessage(
        'm1',
        [
          { type: 'text', text: 'streaming…' },
        ],
        true,
      ),
    ];
    const rows = buildRows(messages, []);
    expect(rows[0]).toMatchObject({ streaming: true, sender: 'agent' });
  });

  it('attaches UiMoments to their paired tool_result by tool_use_id', () => {
    const moment = renderMoment('toolu_abc', 'https://x.test/api/renders/p/resource', 'p');
    const messages = [
      assistantMessage('m1', [
        { type: 'text', text: 'here you go:' },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_abc',
          content: { renderId: 'p' },
        },
      ]),
    ];
    const rows = buildRows(messages, [moment]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'text', text: 'here you go:' });
    expect(rows[1]).toMatchObject({ kind: 'ui-moment', moment });
  });

  it('drops tool_result blocks without a paired UiMoment (non-ggui tool results)', () => {
    const messages = [
      assistantMessage('m1', [
        { type: 'text', text: 'search result:' },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_search',
          content: { text: 'matched 3 hits' },
        },
        { type: 'text', text: 'is that helpful?' },
      ]),
    ];
    const rows = buildRows(messages, []);
    expect(rows.map((r) => (r.kind === 'text' ? r.text : 'MOMENT'))).toEqual([
      'search result:',
      'is that helpful?',
    ]);
  });

  it('drops tool_use blocks entirely (internal, not user-facing)', () => {
    const messages = [
      assistantMessage('m1', [
        { type: 'text', text: 'calling tool...' },
        {
          type: 'tool_use',
          id: 'toolu_push',
          name: 'ggui_render',
          input: {},
        },
        { type: 'text', text: 'done.' },
      ]),
    ];
    const rows = buildRows(messages, []);
    expect(rows.map((r) => (r.kind === 'text' ? r.text : 'MOMENT'))).toEqual([
      'calling tool...',
      'done.',
    ]);
  });

  it('interleaves text + ui-moment + text in content-block order', () => {
    const moment = renderMoment('toolu_push', 'https://x.test/api/renders/p/resource', 'p');
    const messages = [
      assistantMessage('m1', [
        { type: 'text', text: 'pre' },
        { type: 'tool_use', id: 'toolu_push', name: 'ggui_render', input: {} },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_push',
          content: { renderId: 'p' },
        },
        { type: 'text', text: 'post' },
      ]),
    ];
    const rows = buildRows(messages, [moment]);
    expect(rows.map((r) => r.kind)).toEqual(['text', 'ui-moment', 'text']);
    expect(rows[0]).toMatchObject({ text: 'pre' });
    expect(rows[2]).toMatchObject({ text: 'post' });
  });

  it('preserves message order across a full user/assistant/user/assistant exchange', () => {
    const moment = renderMoment('toolu_1', 'https://x.test/api/renders/p1/resource', 'p1');
    const messages = [
      userMessage('u1', 'show me tasks'),
      assistantMessage('a1', [
        { type: 'text', text: 'here they are:' },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: { renderId: 'p1' },
        },
      ]),
      userMessage('u2', 'thanks'),
      assistantMessage('a2', [{ type: 'text', text: 'you are welcome' }]),
    ];
    const rows = buildRows(messages, [moment]);
    expect(rows.map((r) => r.key)).toEqual([
      'u1:user',
      'a1:0',
      'a1:1:toolu_1',
      'u2:user',
      'a2:0',
    ]);
  });

  it('collapses multi-block user messages into one bubble (edge case)', () => {
    const messages: ConversationMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
        isStreaming: false,
      },
    ];
    const rows = buildRows(messages, []);
    expect(rows).toEqual<ChatRow[]>([
      { kind: 'text', key: 'u1:user', sender: 'user', text: 'part one part two', streaming: false },
    ]);
  });

  it('handles user message with no text content (all-empty send) by emitting no row', () => {
    const messages: ConversationMessage[] = [
      { id: 'u1', role: 'user', content: [], isStreaming: false },
    ];
    expect(buildRows(messages, [])).toEqual([]);
  });
});
