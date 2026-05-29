/**
 * Unit coverage for `synthesizeUserActionPrompt`. Locks the wire
 * shape (imperative-first phrasing + XML tags around structured
 * fields) that every LLM backend depends on for deterministic
 * dispatch after a rehydrated iframe gesture.
 *
 * If a future tweak softens the imperative phrasing (e.g. drops
 * "NOW" or removes "Do not respond conversationally"), Gemini Step
 * 4 regresses to summarizing instead of dispatching the prepared
 * tool call. The matchers below guard the load-bearing tokens.
 */
import { describe, expect, it } from 'vitest';
import type { GguiUserActionMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { synthesizeUserActionPrompt } from './user-action-prompt.js';

const QUEUED_SAMPLE: GguiUserActionMeta = {
  kind: 'queued',
  description: 'user clicked submit',
  renderId: 'r_abc123',
  actionId: 'deadbeef',
  submittedAt: '2026-05-29T10:00:00Z',
  intent: 'submit',
  nextStep: {
    tool: 'ggui_consume',
    args: { renderId: 'r_abc123' },
  },
};

const INLINE_SAMPLE_WITH_NEXTSTEP: GguiUserActionMeta = {
  kind: 'inline',
  description: 'user toggled item 2',
  renderId: 'r_xyz789',
  actionId: 'cafef00d',
  submittedAt: '2026-05-29T10:05:00Z',
  intent: 'toggle',
  payload: {
    actionData: { itemId: 2 },
    uiContext: { count: 3 },
  },
  nextStep: 'todo_toggle',
};

const INLINE_SAMPLE_WITHOUT_NEXTSTEP: GguiUserActionMeta = {
  kind: 'inline',
  description: 'user clicked a free intent',
  renderId: 'r_free',
  actionId: 'baddcafe',
  submittedAt: '2026-05-29T10:10:00Z',
  intent: 'free-choice',
  payload: {
    actionData: null,
    uiContext: {},
  },
};

describe('synthesizeUserActionPrompt', () => {
  describe('queued kind', () => {
    const out = synthesizeUserActionPrompt({
      originalPrompt: 'hello there',
      userAction: QUEUED_SAMPLE,
    });

    it('opens with an imperative dispatch directive (no preamble)', () => {
      expect(out.split('\n')[0]).toContain(
        'Call ggui_consume with arguments',
      );
      expect(out.split('\n')[0]).toContain('NOW');
    });

    it('says "Do not respond conversationally" verbatim', () => {
      expect(out).toContain('Do not respond conversationally');
    });

    it('embeds renderId as a structured XML tag', () => {
      expect(out).toContain('<render_id>r_abc123</render_id>');
    });

    it('embeds the next-tool args as JSON inside a structured tag', () => {
      expect(out).toContain(
        '<next_args>{"renderId":"r_abc123"}</next_args>',
      );
    });

    it('wraps the original prompt in an <original_user_message> tag', () => {
      expect(out).toContain('<original_user_message>');
      expect(out).toContain('hello there');
      expect(out).toContain('</original_user_message>');
    });
  });

  describe('inline kind with nextStep', () => {
    const out = synthesizeUserActionPrompt({
      originalPrompt: 'do the thing',
      userAction: INLINE_SAMPLE_WITH_NEXTSTEP,
    });

    it('opens with an imperative dispatch directive naming the next tool', () => {
      expect(out.split('\n')[0]).toContain('Call todo_toggle NOW');
    });

    it('forbids ggui_consume in the inline case', () => {
      expect(out).toContain('Do NOT call ggui_consume');
    });

    it('inlines actionData + uiContext as JSON in XML tags', () => {
      expect(out).toContain('<action_data>{"itemId":2}</action_data>');
      expect(out).toContain('<ui_context>{"count":3}</ui_context>');
    });

    it('embeds renderId in a structured XML tag', () => {
      expect(out).toContain('<render_id>r_xyz789</render_id>');
    });
  });

  describe('inline kind without nextStep', () => {
    const out = synthesizeUserActionPrompt({
      originalPrompt: 'pick something',
      userAction: INLINE_SAMPLE_WITHOUT_NEXTSTEP,
    });

    it('asks the LLM to choose a domain tool (no specific name)', () => {
      expect(out.split('\n')[0]).toContain(
        'Choose the appropriate domain tool',
      );
      expect(out.split('\n')[0]).toContain('NOW');
    });

    it('still forbids ggui_consume', () => {
      expect(out).toContain('Do NOT call ggui_consume');
    });

    it('omits the <next_tool> tag when none was declared', () => {
      expect(out).not.toContain('<next_tool>');
    });
  });
});
