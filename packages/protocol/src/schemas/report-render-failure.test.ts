/**
 * ggui#1609 — `ggui_runtime_report_render_failure`: a card whose render
 * failed tells the server which session, when, and the thrown value's class
 * name, never its message or stack. The shape is the protocol's, so the
 * runtime that sends it and the server that reads it share one definition.
 */
import { describe, expect, it } from 'vitest';
import { VIEW_PROOF_V1_BOUND_ARGS, isViewProofTool } from '../integrations/view-proof';
import {
  RENDER_FAILURE_ERROR_NAME_PATTERN,
  RENDER_FAILURE_MAX_CATCHES,
  RENDER_FAILURE_PHASES,
  renderFailureErrorName,
  reportRenderFailureInputSchema,
  reportRenderFailureOutputSchema,
} from './mcp';

const VALID = { sessionId: 'render_1', appId: 'app-1', phase: 'mount', errorName: 'TypeError', catches: 2 } as const;

describe('ggui_runtime_report_render_failure — the wire (ggui#1609)', () => {
  it('names the two phases a render can fail in', () => {
    expect([...RENDER_FAILURE_PHASES]).toEqual(['mount', 'update']);
  });

  it('accepts an errorName only when it is a code identifier', () => {
    for (const ok of ['Error', 'TypeError', 'Foo.Bar', 'My$Err_2', 'a'.repeat(64)]) {
      expect(RENDER_FAILURE_ERROR_NAME_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of ['', '1Error', 'has space', 'user@example.com', 'a'.repeat(65), 'x\ny', 'Error: boom']) {
      expect(RENDER_FAILURE_ERROR_NAME_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('renderFailureErrorName sends a thrown Error\'s class name, and "Error" for anything else', () => {
    expect(renderFailureErrorName(new TypeError('boom'))).toBe('TypeError');
    class MyError extends Error {
      override name = 'MyError';
    }
    expect(renderFailureErrorName(new MyError('x'))).toBe('MyError');
    const smuggled = new Error('x');
    smuggled.name = 'user@example.com';
    expect(renderFailureErrorName(smuggled)).toBe('Error');
    expect(renderFailureErrorName('a thrown string')).toBe('Error');
    expect(renderFailureErrorName({ name: 'NotAnError' })).toBe('Error');
    expect(renderFailureErrorName(undefined)).toBe('Error');
  });

  it('its input carries the five members and nothing that could hold a message', () => {
    expect(Object.keys(reportRenderFailureInputSchema.shape).sort()).toEqual(['appId', 'catches', 'errorName', 'phase', 'sessionId']);
    expect(reportRenderFailureInputSchema.safeParse(VALID).success).toBe(true);
  });

  it('refuses a name that is not a code identifier, an unknown phase, and an out-of-range count', () => {
    const refused = [
      { ...VALID, errorName: 'Error: the user typed secret' },
      { ...VALID, phase: 'paint' },
      { ...VALID, catches: -1 },
      { ...VALID, catches: 1.5 },
      { ...VALID, catches: RENDER_FAILURE_MAX_CATCHES + 1 },
      { ...VALID, sessionId: '' },
    ];
    for (const input of refused) expect(reportRenderFailureInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it('strips a member it does not name rather than refusing the report (N−1: a later runtime may send more)', () => {
    const parsed = reportRenderFailureInputSchema.safeParse({ ...VALID, message: 'boom', stack: 'at x' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(VALID);
  });

  it('answers ok, or ok:false with the one code a report can earn', () => {
    expect(reportRenderFailureOutputSchema.safeParse({ ok: true }).success).toBe(true);
    expect(reportRenderFailureOutputSchema.safeParse({ ok: false, code: 'SESSION_NOT_FOUND' }).success).toBe(true);
    expect(reportRenderFailureOutputSchema.safeParse({ ok: false, code: 'SOMETHING_ELSE' }).success).toBe(false);
  });
});

describe('the view proof binds the report (ggui#1609)', () => {
  it('the v1 table gains a row for the tool, binding every member', () => {
    expect(isViewProofTool('ggui_runtime_report_render_failure')).toBe(true);
    expect([...VIEW_PROOF_V1_BOUND_ARGS.ggui_runtime_report_render_failure].sort()).toEqual(
      Object.keys(reportRenderFailureInputSchema.shape).sort(),
    );
  });

  it("the existing tools' rows are unchanged: adding a tool is not a new label", () => {
    expect(VIEW_PROOF_V1_BOUND_ARGS.ggui_runtime_submit_action).toEqual(['kind', 'payload', 'sessionId', 'appId', 'actionId', 'firedAt']);
    expect(VIEW_PROOF_V1_BOUND_ARGS.ggui_runtime_sync_context).toEqual(['sessionId', 'appId', 'snapshot']);
    expect(VIEW_PROOF_V1_BOUND_ARGS.ggui_runtime_pull).toEqual(['sessionId', 'sinceSequence', 'limit']);
  });
});
