/**
 * Matcher unit tests — synthetic frame arrays exercising the
 * `observability-event` arm Slice L grounded.
 *
 * Pure unit-level: no transport, no server. The arms under test are
 * `wired-tool-invoked` (asserts on `_ggui:wired-tool-invoked` stream
 * frame) + `contract-error-emitted` (asserts on the canonical SPEC
 * §4.4 `_ggui:contract-error` envelope shape). Other event kinds
 * remain `unmatchable-on-ws`; this file pins that contract too.
 */
import { describe, expect, it } from 'vitest';

import { matchBehavior } from './match-behavior.js';
import type { ObservabilityBehavior } from './types.js';
import type { ObservedFrame } from './ws-transport.js';

function frame(parsed: Record<string, unknown>): ObservedFrame {
  return { kind: 'frame', raw: JSON.stringify(parsed), parsed };
}

const ACK_FRAME: ObservedFrame = frame({ type: 'ack' });

describe('matchBehavior — observability-event::wired-tool-invoked', () => {
  const behavior: ObservabilityBehavior = {
    kind: 'observability-event',
    event: {
      kind: 'wired-tool-invoked',
      toolName: 'tasks_complete',
      actionName: 'toggleTask',
    },
  };

  it('passes when a `_ggui:wired-tool-invoked` stream frame matches toolName + actionName', () => {
    const frames: readonly ObservedFrame[] = [
      ACK_FRAME,
      frame({
        type: 'stream',
        payload: {
          channel: '_ggui:wired-tool-invoked',
          value: { toolName: 'tasks_complete', actionName: 'toggleTask' },
        },
      }),
    ];
    const result = matchBehavior(behavior, frames);
    expect(result.kind).toBe('pass');
  });

  it('passes when actionName is omitted on the event (toolName-only assertion)', () => {
    const toolOnlyBehavior: ObservabilityBehavior = {
      kind: 'observability-event',
      event: { kind: 'wired-tool-invoked', toolName: 'tasks_complete' },
    };
    const frames: readonly ObservedFrame[] = [
      ACK_FRAME,
      frame({
        type: 'stream',
        payload: {
          channel: '_ggui:wired-tool-invoked',
          value: { toolName: 'tasks_complete', actionName: 'somethingElse' },
        },
      }),
    ];
    const result = matchBehavior(toolOnlyBehavior, frames);
    expect(result.kind).toBe('pass');
  });

  it('fails when no `_ggui:wired-tool-invoked` stream frame is observed', () => {
    const frames: readonly ObservedFrame[] = [ACK_FRAME];
    const result = matchBehavior(behavior, frames);
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.message).toContain('_ggui:wired-tool-invoked');
    expect(result.message).toContain('protocol bar mandates');
  });

  it('fails when the channel matches but toolName mismatches', () => {
    const frames: readonly ObservedFrame[] = [
      ACK_FRAME,
      frame({
        type: 'stream',
        payload: {
          channel: '_ggui:wired-tool-invoked',
          value: { toolName: 'wrong_tool', actionName: 'toggleTask' },
        },
      }),
    ];
    const result = matchBehavior(behavior, frames);
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.message).toContain('did not match the expected toolName');
  });

  it('fails when actionName is required and mismatches', () => {
    const frames: readonly ObservedFrame[] = [
      ACK_FRAME,
      frame({
        type: 'stream',
        payload: {
          channel: '_ggui:wired-tool-invoked',
          value: { toolName: 'tasks_complete', actionName: 'wrongAction' },
        },
      }),
    ];
    const result = matchBehavior(behavior, frames);
    expect(result.kind).toBe('fail');
  });

  it('fails (under-specified fixture) when toolName is omitted from the event', () => {
    const underSpecified: ObservabilityBehavior = {
      kind: 'observability-event',
      event: { kind: 'wired-tool-invoked' },
    };
    const frames: readonly ObservedFrame[] = [ACK_FRAME];
    const result = matchBehavior(underSpecified, frames);
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.message).toContain('MUST declare `toolName`');
  });
});

describe('matchBehavior — observability-event::contract-error-emitted', () => {
  const behavior: ObservabilityBehavior = {
    kind: 'observability-event',
    event: {
      kind: 'contract-error-emitted',
      code: 'TOOL_THREW',
      toolName: 'broken_tool',
      actionName: 'triggerBroken',
    },
  };

  function contractErrorFrame(value: Record<string, unknown>): ObservedFrame {
    return frame({
      type: 'stream',
      payload: { channel: '_ggui:contract-error', value },
    });
  }

  it('passes when a canonical SPEC §4.4 contract-error envelope matches code + toolName + actionName', () => {
    const frames: readonly ObservedFrame[] = [
      ACK_FRAME,
      contractErrorFrame({
        toolName: 'broken_tool',
        actionName: 'triggerBroken',
        sourceAction: { type: 'wired-action', dispatchedAt: '2026-04-26T00:00:00.000Z' },
        error: {
          code: 'TOOL_THREW',
          message: 'tool_threw_for_fixture',
        },
        timestamp: '2026-04-26T00:00:00.000Z',
      }),
    ];
    const result = matchBehavior(behavior, frames);
    expect(result.kind).toBe('pass');
  });

  it('fails when no `_ggui:contract-error` frame is observed', () => {
    const frames: readonly ObservedFrame[] = [ACK_FRAME];
    const result = matchBehavior(behavior, frames);
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.message).toContain('_ggui:contract-error');
    expect(result.message).toContain('protocol bar mandates');
  });

  it('fails when contract-error frame is observed but `error.code` mismatches', () => {
    const frames: readonly ObservedFrame[] = [
      ACK_FRAME,
      contractErrorFrame({
        toolName: 'broken_tool',
        actionName: 'triggerBroken',
        sourceAction: { type: 'wired-action', dispatchedAt: '2026-04-26T00:00:00.000Z' },
        error: { code: 'TOOL_NOT_FOUND', message: '...' },
        timestamp: '2026-04-26T00:00:00.000Z',
      }),
    ];
    const result = matchBehavior(behavior, frames);
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.message).toContain('did not match');
  });

  it('fails (under-specified fixture) when code OR toolName is omitted', () => {
    const noCode: ObservabilityBehavior = {
      kind: 'observability-event',
      event: { kind: 'contract-error-emitted', toolName: 'broken_tool' },
    };
    const result = matchBehavior(noCode, [ACK_FRAME]);
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.message).toContain('MUST declare both `code` and `toolName`');
  });
});

describe('matchBehavior — observability-event::other arms', () => {
  it('returns unmatchable-on-ws for `schema-version-mismatch` (not grounded in WS evidence)', () => {
    const behavior: ObservabilityBehavior = {
      kind: 'observability-event',
      event: { kind: 'schema-version-mismatch' },
    };
    const result = matchBehavior(behavior, []);
    expect(result.kind).toBe('unmatchable-on-ws');
    if (result.kind !== 'unmatchable-on-ws') return;
    expect(result.reason).toContain('schema-version-mismatch');
    expect(result.reason).toContain('browser-host harness');
  });

  it('returns unmatchable-on-ws for an unknown extensibly-closed event kind', () => {
    const behavior: ObservabilityBehavior = {
      kind: 'observability-event',
      event: { kind: 'made-up-future-event' },
    };
    const result = matchBehavior(behavior, []);
    expect(result.kind).toBe('unmatchable-on-ws');
    if (result.kind !== 'unmatchable-on-ws') return;
    expect(result.reason).toContain('made-up-future-event');
  });
});
