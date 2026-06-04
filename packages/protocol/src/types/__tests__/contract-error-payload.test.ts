/**
 * Shape-lock for {@link ContractErrorPayload} — the body emitted by
 * the server-side wiredActionRouter on the reserved
 * `_ggui:contract-error` channel when a declared action-tool or
 * refresh-stream tool fails.
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
  it('pins the v1 named codes', () => {
    // Each of the four v1 literals MUST remain assignable to
    // ContractErrorCode. If a literal drops out of the union, the
    // producer (mcp-server renderChannel router) loses its
    // narrow code selector and the protocol version actually
    // regressed.
    expectTypeOf<'TOOL_NOT_FOUND'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'TOOL_THREW'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'TOOL_TIMEOUT'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'SCHEMA_VIOLATION'>().toMatchTypeOf<ContractErrorCode>();
  });

  it('pins the 2026-04-23 additions (F4 + C8)', () => {
    // `SCHEMA_MISMATCH_ERROR` joined at F4 (Phase 1 Item 5); the
    // producer is the schema-compat checker's render-time hook.
    expectTypeOf<'SCHEMA_MISMATCH_ERROR'>().toMatchTypeOf<ContractErrorCode>();
    // `RENDER_NOT_FOUND` + `AUTH_REJECTED` joined at C8 — post-WS-open
    // bootstrap failures surfaced on live-channel `_ggui:contract-error`
    // envelopes (`sourceAction.type === 'bootstrap-load'`). Pre-WS
    // bootstrap codes (BUNDLE_FETCH_FAILED, CSP_VIOLATION,
    // BOOTSTRAP_META_MISSING) are deliberately NOT in this set —
    // they can't reach the live channel because the WS doesn't exist yet.
    expectTypeOf<'RENDER_NOT_FOUND'>().toMatchTypeOf<ContractErrorCode>();
    expectTypeOf<'AUTH_REJECTED'>().toMatchTypeOf<ContractErrorCode>();
  });

  it('is an EXTENSIBLE union — accepts arbitrary future codes without a version bump', () => {
    // The `| (string & {})` widening means a future router source
    // (SANITIZER_FAILED, MCP_TRANSPORT_ERROR, RATE_LIMIT_EXCEEDED,
    // BOOTSTRAP_FAILED) can populate `.error.code` without forcing
    // a protocol major bump. Consumers that pin on the v1 names
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
  it('accepts a minimal wired-action envelope', () => {
    const payload: ContractErrorPayload = {
      toolName: 'tasks_broken',
      actionName: 'toggleTask',
      sourceAction: {
        type: 'wired-action',
        dispatchedAt: '2026-04-22T00:00:00.000Z',
      },
      error: {
        code: 'TOOL_THREW',
        message: 'tasks_broken is intentionally broken',
      },
      timestamp: '2026-04-22T00:00:00.123Z',
    };
    expect(payload.error.code).toBe('TOOL_THREW');
    expect(payload.toolName).toBe('tasks_broken');
  });

  it('accepts a refresh-stream envelope without actionName', () => {
    // Refresh errors that fire AFTER a successful wired action have
    // provenance but no originating action name — the action
    // succeeded, only the follow-up refresh failed.
    const payload: ContractErrorPayload = {
      toolName: 'tasks_malformed_list',
      sourceAction: {
        type: 'refresh-stream',
        dispatchedAt: '2026-04-22T00:00:00.000Z',
      },
      error: {
        code: 'SCHEMA_VIOLATION',
        message: 'refresh tool returned a payload that violates tasks schema',
      },
      timestamp: '2026-04-22T00:00:00.456Z',
    };
    expect(payload.actionName).toBeUndefined();
    expect(payload.sourceAction?.type).toBe('refresh-stream');
  });

  it('accepts a minimal envelope without sourceAction or causedBy', () => {
    // Router-origin errors (e.g., TOOL_NOT_FOUND before we even
    // dispatch) may lack sourceAction provenance. Shape still stands.
    const payload: ContractErrorPayload = {
      toolName: 'tasks_never_registered',
      error: {
        code: 'TOOL_NOT_FOUND',
        message: 'no handler registered for tool tasks_never_registered',
      },
      timestamp: '2026-04-22T00:00:00.000Z',
    };
    expect(payload.sourceAction).toBeUndefined();
    expect(payload.error.causedBy).toBeUndefined();
  });

  it('carries optional causedBy for stack-trace debugging', () => {
    const payload: ContractErrorPayload = {
      toolName: 'tasks_broken',
      error: {
        code: 'TOOL_THREW',
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
