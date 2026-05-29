/**
 * Unit coverage for `synthesizeUserActionPrompt`. Locks the wire
 * shape (imperative-first phrasing + XML tags around the structured
 * render pointer) that every LLM backend depends on for deterministic
 * dispatch after an iframe doorbell.
 *
 * If a future tweak softens the imperative phrasing (e.g. drops
 * "NOW" or removes "Do not respond conversationally"), Gemini Step
 * 4 regresses to summarizing instead of dispatching the prepared
 * `ggui_consume` call. The matchers below guard the load-bearing
 * tokens.
 *
 * The slice is a PURE DOORBELL: a single `user-action` kind that
 * points at the render whose pipe holds the gesture. The directive
 * MUST NOT embed action data — the agent retrieves it EXCLUSIVELY via
 * `ggui_consume`.
 */
import { describe, expect, it } from 'vitest';
import type { GguiUserActionMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { synthesizeUserActionPrompt } from './user-action-prompt.js';

const DOORBELL_SAMPLE: GguiUserActionMeta = {
  kind: 'user-action',
  description:
    'User interacted with render r_abc123; call ggui_consume to retrieve and process it.',
  renderId: 'r_abc123',
  actionId: 'deadbeef',
  submittedAt: '2026-05-29T10:00:00Z',
  intent: 'submit',
  nextStep: {
    tool: 'ggui_consume',
    args: { renderId: 'r_abc123' },
  },
};

describe('synthesizeUserActionPrompt', () => {
  const out = synthesizeUserActionPrompt({
    originalPrompt: 'hello there',
    userAction: DOORBELL_SAMPLE,
  });

  it('opens with an imperative ggui_consume dispatch directive (no preamble)', () => {
    const firstLine = out.split('\n')[0];
    expect(firstLine).toContain('REQUIRED FIRST TOOL CALL');
    expect(firstLine).toContain('ggui_consume');
    expect(firstLine).toContain('NOW');
  });

  it('says "Do not respond conversationally" verbatim', () => {
    expect(out).toContain('Do not respond conversationally');
  });

  it('tags the slice with the single user-action kind', () => {
    expect(out).toContain('<kind>user-action</kind>');
    // Retired discriminators must not leak into the directive.
    expect(out).not.toContain('<kind>queued</kind>');
    expect(out).not.toContain('<kind>inline</kind>');
  });

  it('embeds renderId as a structured XML tag', () => {
    expect(out).toContain('<render_id>r_abc123</render_id>');
  });

  it('embeds the next-tool args as JSON inside a structured tag', () => {
    expect(out).toContain('<next_args>{"renderId":"r_abc123"}</next_args>');
  });

  it('never embeds action data (pure doorbell — agent consumes for it)', () => {
    // No payload tags: the gesture is retrieved EXCLUSIVELY via the pipe.
    expect(out).not.toContain('<action_data>');
    expect(out).not.toContain('<ui_context>');
  });

  it('wraps the original prompt in an <original_user_message> tag', () => {
    expect(out).toContain('<original_user_message>');
    expect(out).toContain('hello there');
    expect(out).toContain('</original_user_message>');
  });
});
