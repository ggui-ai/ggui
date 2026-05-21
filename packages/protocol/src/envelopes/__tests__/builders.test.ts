/**
 * Unit tests for the three central envelope builders.
 *
 * Covers the semantic paths locked in the builder docstring:
 *   - default-stamps-current-version
 *   - explicit-override-respected
 *   - explicit-undefined-omits-stamp (test-only pattern)
 *   - byte-equivalence with the pre-refactor inline stamp shapes
 *
 * The fourth bullet is load-bearing — these builders centralize
 * production stamp sites whose exact emitted shape is observed by
 * server-side validation and by subscribers. Any drift between the
 * pre-refactor manual construction and the builder output is real
 * breakage.
 */
import { describe, expect, it } from 'vitest';
import {
  makeActionEnvelope,
  makeContractErrorPayload,
  makeStreamEnvelope,
} from '../builders.js';
import type {
  ActionEnvelope,
  ContractErrorPayload,
  StreamEnvelope,
} from '../../index.js';
import { PROTOCOL_SCHEMA_VERSION } from '../../version.js';

describe('makeActionEnvelope', () => {
  it('default-stamps-current-version', () => {
    const env = makeActionEnvelope({
      sessionId: 'sess-1',
      type: 'data:submit',
    });
    expect(env.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
  });

  it('explicit-override-respected', () => {
    const env = makeActionEnvelope({
      sessionId: 'sess-1',
      type: 'data:submit',
      schemaVersion: '99.99-future',
    });
    expect(env.schemaVersion).toBe('99.99-future');
  });

  it('explicit-undefined-omits-stamp (test-only pattern)', () => {
    const env = makeActionEnvelope({
      sessionId: 'sess-1',
      type: 'data:submit',
      schemaVersion: undefined,
    });
    expect('schemaVersion' in env).toBe(false);
    expect(env.schemaVersion).toBeUndefined();
  });

  it('filters undefined optional fields (byte-equivalence)', () => {
    const env = makeActionEnvelope({
      sessionId: 'sess-1',
      type: 'data:submit',
      // payload, stackIndex, stackItemId, clientSeq all omitted
    });
    // Key absence — not `{key: undefined}` — matches the pre-refactor
    // `if (x !== undefined) envelope.x = x` shape.
    expect('payload' in env).toBe(false);
    expect('stackIndex' in env).toBe(false);
    expect('stackItemId' in env).toBe(false);
    expect('clientSeq' in env).toBe(false);
  });

  it('preserves all supplied fields verbatim', () => {
    const env = makeActionEnvelope({
      sessionId: 'sess-1',
      type: 'data:submit',
      payload: { action: 'submit', data: { text: 'hi' } },
      stackIndex: 2,
      stackItemId: 'page-xyz',
      clientSeq: 42,
    });
    expect(env).toEqual({
      sessionId: 'sess-1',
      type: 'data:submit',
      payload: { action: 'submit', data: { text: 'hi' } },
      stackIndex: 2,
      stackItemId: 'page-xyz',
      clientSeq: 42,
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
    });
  });

  it('produced envelope is assignable to ActionEnvelope<T>', () => {
    const env: ActionEnvelope<{ action: string }> = makeActionEnvelope<{
      action: string;
    }>({
      sessionId: 'sess-1',
      type: 'data:submit',
      payload: { action: 'submit' },
    });
    expect(env.payload?.action).toBe('submit');
  });
});

describe('makeStreamEnvelope', () => {
  it('default-stamps-current-version', () => {
    const env = makeStreamEnvelope({
      sessionId: 'sess-1',
      channel: 'tasks',
      mode: 'replace',
      payload: [{ id: 1 }],
    });
    expect(env.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
  });

  it('explicit-override-respected', () => {
    const env = makeStreamEnvelope({
      sessionId: 'sess-1',
      channel: 'tasks',
      mode: 'replace',
      payload: null,
      schemaVersion: '99.99-future',
    });
    expect(env.schemaVersion).toBe('99.99-future');
  });

  it('explicit-undefined-omits-stamp (test-only pattern)', () => {
    const env = makeStreamEnvelope({
      sessionId: 'sess-1',
      channel: 'tasks',
      mode: 'replace',
      payload: null,
      schemaVersion: undefined,
    });
    expect('schemaVersion' in env).toBe(false);
    expect(env.schemaVersion).toBeUndefined();
  });

  it('filters undefined optional fields (byte-equivalence)', () => {
    const env = makeStreamEnvelope({
      sessionId: 'sess-1',
      channel: 'tasks',
      mode: 'replace',
      payload: null,
      // complete, seq omitted
    });
    expect('complete' in env).toBe(false);
    expect('seq' in env).toBe(false);
  });

  it('preserves all supplied fields verbatim', () => {
    const env = makeStreamEnvelope({
      sessionId: 'sess-1',
      channel: 'tasks',
      mode: 'append',
      payload: { todo: 'x' },
      complete: true,
      seq: 7,
    });
    expect(env).toEqual({
      sessionId: 'sess-1',
      channel: 'tasks',
      mode: 'append',
      payload: { todo: 'x' },
      complete: true,
      seq: 7,
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
    });
  });

  it('produced envelope is assignable to StreamEnvelope', () => {
    const env: StreamEnvelope = makeStreamEnvelope({
      sessionId: 'sess-1',
      channel: 'tasks',
      mode: 'replace',
      payload: null,
    });
    expect(env.sessionId).toBe('sess-1');
  });
});

describe('makeContractErrorPayload', () => {
  const ISO = '2026-04-23T00:00:00.000Z';

  it('default-stamps-current-version', () => {
    const p = makeContractErrorPayload({
      toolName: 'tool_a',
      timestamp: ISO,
      error: { code: 'TOOL_THREW', message: 'boom' },
    });
    expect(p.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
  });

  it('explicit-override-respected', () => {
    const p = makeContractErrorPayload({
      toolName: 'tool_a',
      timestamp: ISO,
      error: { code: 'TOOL_THREW', message: 'boom' },
      schemaVersion: '99.99-future',
    });
    expect(p.schemaVersion).toBe('99.99-future');
  });

  it('explicit-undefined-omits-stamp (test-only pattern)', () => {
    const p = makeContractErrorPayload({
      toolName: 'tool_a',
      timestamp: ISO,
      error: { code: 'TOOL_THREW', message: 'boom' },
      schemaVersion: undefined,
    });
    expect('schemaVersion' in p).toBe(false);
    expect(p.schemaVersion).toBeUndefined();
  });

  it('filters undefined optional fields (byte-equivalence)', () => {
    const p = makeContractErrorPayload({
      toolName: 'tool_a',
      timestamp: ISO,
      error: { code: 'TOOL_THREW', message: 'boom' },
      // actionName, sourceAction omitted
    });
    expect('actionName' in p).toBe(false);
    expect('sourceAction' in p).toBe(false);
  });

  it('preserves all supplied fields verbatim', () => {
    const p = makeContractErrorPayload({
      toolName: 'tool_a',
      actionName: 'submit',
      sourceAction: { type: 'wired-action', dispatchedAt: ISO },
      error: {
        code: 'TOOL_THREW',
        message: 'boom',
        causedBy: 'Error: stack\n  at x',
      },
      timestamp: ISO,
    });
    expect(p).toEqual({
      toolName: 'tool_a',
      actionName: 'submit',
      sourceAction: { type: 'wired-action', dispatchedAt: ISO },
      error: {
        code: 'TOOL_THREW',
        message: 'boom',
        causedBy: 'Error: stack\n  at x',
      },
      timestamp: ISO,
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
    });
  });

  it('accepts extensibly-closed sourceAction.type strings', () => {
    // Post-Item-2 extensibility: any string is a valid type.
    const p = makeContractErrorPayload({
      toolName: 'tool_a',
      sourceAction: {
        type: 'bootstrap-refresh' as const,
        dispatchedAt: ISO,
      },
      error: { code: 'TOOL_THREW', message: 'boom' },
      timestamp: ISO,
    });
    expect(p.sourceAction?.type).toBe('bootstrap-refresh');
  });

  it('produced payload is assignable to ContractErrorPayload', () => {
    const p: ContractErrorPayload = makeContractErrorPayload({
      toolName: 'tool_a',
      timestamp: ISO,
      error: { code: 'TOOL_THREW', message: 'boom' },
    });
    expect(p.toolName).toBe('tool_a');
  });
});
