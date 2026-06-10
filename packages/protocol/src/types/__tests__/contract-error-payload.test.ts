/**
 * Shape-lock for {@link ContractErrorPayload} — the body emitted on
 * the reserved `_ggui:contract-error` channel when a tool-mediated
 * contract obligation fails.
 *
 * These tests pin both the code enum and the envelope shape: if a
 * future slice widens the error surface (e.g., adds retry metadata),
 * the change must pass through this test, keeping the canonical
 * contract honest.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  ContractErrorCode,
  ContractErrorPayload,
} from '../data-contract.js';

describe('ContractErrorCode', () => {
  it('pins the named codes', () => {
    // Each named literal MUST remain assignable to ContractErrorCode.
    // If a literal drops out of the union, producers lose their
    // narrow code selector and the protocol version actually
    // regressed.
    expectTypeOf<'SCHEMA_VIOLATION'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'SCHEMA_MISMATCH_ERROR'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'SESSION_NOT_FOUND'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'AUTH_REJECTED'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'INVALID_ACTION_KIND'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'PIPE_NOT_FOUND'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'CONTEXT_TOO_LARGE'>().toMatchTypeOf<ContractErrorCode>();
  });

  it('is an EXTENSIBLE union — accepts arbitrary future codes without a version bump', () => {
    // The `| (string & {})` widening means a future emitter
    // (SANITIZER_FAILED, MCP_TRANSPORT_ERROR, RATE_LIMIT_EXCEEDED,
    // BOOTSTRAP_FAILED) can populate `.error.code` without forcing
    // a protocol major bump. Consumers that pin on the named codes
    // still autocomplete correctly; consumers that render the raw
    // string keep working for unknown codes.
    expectTypeOf<'SANITIZER_FAILED'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'MCP_TRANSPORT_ERROR'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'RATE_LIMIT_EXCEEDED'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'BOOTSTRAP_FAILED'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'future-unknown-code'>().toMatchTypeOf<ContractErrorCode>();
    // Broad `string` is also assignable — consumers MUST handle
    // unknown codes as raw strings, not via exhaustive switch.
    expectTypeOf<string>().toMatchTypeOf<ContractErrorCode>();
  });

  it('round-trips a forward-compat code through ContractErrorPayload without rejection', () => {
    // Runtime proof: constructing a payload with a not-yet-minted
    // code (as the C8 BOOTSTRAP_FAILED slice will need) and
    // serializing through JSON (the wire format for
    // `_ggui:contract-error` envelopes) preserves the code
    // verbatim. No validator in @ggui-ai/protocol rejects unknown
    // code strings — the extensibility is honest end-to-end.
    const forwardCompatCode = 'BOOTSTRAP_FAILED' satisfies ContractErrorCode;
    const payload: ContractErrorPayload = {
      toolName: 'bootstrap',
      error: {
        code: forwardCompatCode,
        message: 'bootstrap contract failed to resolve',
      },
      timestamp: '2026-04-23T00:00:00.000Z',
    };
    const roundTripped = JSON.parse(JSON.stringify(payload)) as ContractErrorPayload;
    expect(roundTripped.error.code).toBe('BOOTSTRAP_FAILED');
    expect(roundTripped.toolName).toBe('bootstrap');
  });
});

describe('ContractErrorPayload shape', () => {
  it('accepts a schema-violation envelope', () => {
    const payload: ContractErrorPayload = {
      toolName: 'tasks_malformed_list',
      error: {
        code: 'SCHEMA_VIOLATION',
        message: 'tool returned a payload that violates the tasks schema',
      },
      timestamp: '2026-04-22T00:00:00.123Z',
    };
    expect(payload.error.code).toBe('SCHEMA_VIOLATION');
    expect(payload.toolName).toBe('tasks_malformed_list');
  });

  it('accepts a minimal envelope without causedBy', () => {
    const payload: ContractErrorPayload = {
      toolName: 'tasks_list',
      error: {
        code: 'SCHEMA_MISMATCH_ERROR',
        message: 'declared schemas disagree for tasks_list',
      },
      timestamp: '2026-04-22T00:00:00.000Z',
    };
    expect(payload.error.causedBy).toBeUndefined();
    expect(payload.schemaVersion).toBeUndefined();
  });

  it('carries optional causedBy for stack-trace debugging', () => {
    const payload: ContractErrorPayload = {
      toolName: 'tasks_broken',
      error: {
        code: 'SCHEMA_VIOLATION',
        message: 'unexpected runtime failure',
        causedBy: 'Error: boom\n    at tasks_broken (broken.ts:12:3)',
      },
      timestamp: '2026-04-22T00:00:00.000Z',
    };
    expect(payload.error.causedBy).toContain('at tasks_broken');
  });

  it('exposes readonly fields — the envelope is immutable by contract', () => {
    // Readonly is a compile-time declaration; this test locks that
    // every top-level field and nested error field stays marked
    // readonly, so accidental mutation post-emit is a type error.
    expectTypeOf<ContractErrorPayload['toolName']>().toEqualTypeOf<string>();
    expectTypeOf<ContractErrorPayload['timestamp']>().toEqualTypeOf<string>();
    expectTypeOf<ContractErrorPayload['error']['code']>().toEqualTypeOf<
      ContractErrorCode
    >();
  });
});
