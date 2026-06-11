import { describe, it, expect } from 'vitest';
import {
  BUILTIN_RESERVED_VALIDATORS,
  CONTRACT_ERROR_CHANNEL,
  KNOWN_RESERVED_CHANNELS,
  LIFECYCLE_CHANNEL,
  PREVIEW_CHANNEL,
  RESERVED_CHANNEL_PREFIX,
  isKnownReservedChannel,
  isReservedChannelName,
  validateGguiLifecyclePayload,
  validateContractErrorPayload,
  type ReservedChannelValidator,
} from './reserved-channels.js';
import {
  validateContractStructure,
  validateStreamData,
} from './contract-validator.js';
import type { ContractErrorPayload, DataContract, StreamSpec } from '../types/data-contract.js';

describe('reserved-channels constants', () => {
  it('pins PREVIEW_CHANNEL to _ggui:preview', () => {
    expect(PREVIEW_CHANNEL).toBe('_ggui:preview');
  });

  it('pins CONTRACT_ERROR_CHANNEL to _ggui:contract-error', () => {
    expect(CONTRACT_ERROR_CHANNEL).toBe('_ggui:contract-error');
  });

  it('pins RESERVED_CHANNEL_PREFIX to _ggui:', () => {
    expect(RESERVED_CHANNEL_PREFIX).toBe('_ggui:');
  });

  it('PREVIEW_CHANNEL falls inside the reserved namespace', () => {
    expect(isReservedChannelName(PREVIEW_CHANNEL)).toBe(true);
  });

  it('CONTRACT_ERROR_CHANNEL falls inside the reserved namespace', () => {
    expect(isReservedChannelName(CONTRACT_ERROR_CHANNEL)).toBe(true);
  });

  it('CONTRACT_ERROR_CHANNEL is distinct from PREVIEW_CHANNEL', () => {
    // Locks that the two reserved names don't collapse onto each
    // other — they address different server-owned surfaces.
    expect(CONTRACT_ERROR_CHANNEL).not.toBe(PREVIEW_CHANNEL);
  });
});

describe('isReservedChannelName', () => {
  it('returns true for names starting with the reserved prefix', () => {
    expect(isReservedChannelName('_ggui:preview')).toBe(true);
    expect(isReservedChannelName('_ggui:progress')).toBe(true);
    expect(isReservedChannelName('_ggui:anything-else')).toBe(true);
  });

  it('returns false for normal agent-authored channel names', () => {
    expect(isReservedChannelName('updates')).toBe(false);
    expect(isReservedChannelName('logs')).toBe(false);
    expect(isReservedChannelName('my-channel')).toBe(false);
    expect(isReservedChannelName('ggui')).toBe(false); // no prefix colon
  });

  it('returns false for confusingly-similar but non-matching names', () => {
    expect(isReservedChannelName('_ggui')).toBe(false); // missing colon
    expect(isReservedChannelName('ggui:preview')).toBe(false); // missing underscore
    expect(isReservedChannelName('prefix_ggui:foo')).toBe(false); // starts elsewhere
  });

  it('rejects empty string', () => {
    expect(isReservedChannelName('')).toBe(false);
  });
});

describe('isKnownReservedChannel — closed set', () => {
  it('returns true for every name in KNOWN_RESERVED_CHANNELS', () => {
    expect(isKnownReservedChannel(PREVIEW_CHANNEL)).toBe(true);
    expect(isKnownReservedChannel(CONTRACT_ERROR_CHANNEL)).toBe(true);
    for (const name of KNOWN_RESERVED_CHANNELS) {
      expect(isKnownReservedChannel(name)).toBe(true);
    }
  });

  it('returns false for typos inside the reserved namespace', () => {
    // The load-bearing F10 guarantee — a typo'd reserved name does NOT
    // bypass validation the way `isReservedChannelName` would.
    expect(isKnownReservedChannel('_ggui:preveiw')).toBe(false);
    expect(isKnownReservedChannel('_ggui:contract_error')).toBe(false);
    expect(isKnownReservedChannel('_ggui:preview-')).toBe(false);
    expect(isKnownReservedChannel('_ggui:contract-err')).toBe(false);
  });

  it('returns false for hypothetical future reserved names until added', () => {
    // Guards the audit rule: adding a reserved channel requires
    // adding it to KNOWN_RESERVED_CHANNELS. Until then, the runtime
    // refuses to recognize it.
    expect(isKnownReservedChannel('_ggui:wired-tool-invoked')).toBe(false);
    expect(isKnownReservedChannel('_ggui:session-restore')).toBe(false);
  });

  it('returns false for normal agent-authored channels', () => {
    expect(isKnownReservedChannel('updates')).toBe(false);
    expect(isKnownReservedChannel('logs')).toBe(false);
    expect(isKnownReservedChannel('')).toBe(false);
  });

  it('returns false for every name broader isReservedChannelName accepts but the closed set does not', () => {
    // Every input that passes `isReservedChannelName` but is NOT in
    // `KNOWN_RESERVED_CHANNELS` must fail here — that asymmetry is
    // the whole point of the two-predicate split.
    const prefixedButUnknown = '_ggui:not-yet-recognized';
    expect(isReservedChannelName(prefixedButUnknown)).toBe(true);
    expect(isKnownReservedChannel(prefixedButUnknown)).toBe(false);
  });
});

/** Minimal valid schema so unrelated structural checks don't fire. */
const VALID_PAYLOAD_SCHEMA = { type: 'object' as const, properties: {} };

function streamWith(channels: StreamSpec): DataContract {
  return {
    streamSpec: channels,
  };
}

describe('validateContractStructure — reserved-channel rejection', () => {
  it('rejects agent-declared _ggui:preview', () => {
    const result = validateContractStructure(
      streamWith({
        '_ggui:preview': { schema: VALID_PAYLOAD_SCHEMA },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    const [violation] = result.violations;
    expect(violation.field).toBe('streamSpec._ggui:preview');
    expect(violation.message).toContain(RESERVED_CHANNEL_PREFIX);
    expect(violation.message).toContain('reserved');
    expect(violation.received).toBe('_ggui:preview');
  });

  it('rejects any channel in the _ggui: namespace, not just preview', () => {
    const result = validateContractStructure(
      streamWith({
        '_ggui:hypothetical-future-channel': {
          schema: VALID_PAYLOAD_SCHEMA,
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe(
      'streamSpec._ggui:hypothetical-future-channel',
    );
  });

  it('reserved channels do NOT trigger structural follow-up violations', () => {
    // Even if the schema is missing, the reserved-namespace violation
    // is the authoritative one — we don't want two violations on the
    // same channel for the same agent mistake.
    const result = validateContractStructure(
      streamWith({
        // @ts-expect-error deliberately malformed shape to prove we
        // short-circuit before the missing-schema check fires.
        '_ggui:preview': {},
      }),
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].message).toContain('reserved');
  });

  it('accepts normal agent channels unchanged', () => {
    const result = validateContractStructure(
      streamWith({
        updates: { schema: VALID_PAYLOAD_SCHEMA },
        logs: { schema: VALID_PAYLOAD_SCHEMA },
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rejects the one reserved channel but passes the other valid channels', () => {
    const result = validateContractStructure(
      streamWith({
        updates: { schema: VALID_PAYLOAD_SCHEMA },
        '_ggui:preview': { schema: VALID_PAYLOAD_SCHEMA },
        logs: { schema: VALID_PAYLOAD_SCHEMA },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].field).toBe('streamSpec._ggui:preview');
  });

  it('rejects agent-declared _ggui:contract-error — it is server-owned', () => {
    const result = validateContractStructure(
      streamWith({
        [CONTRACT_ERROR_CHANNEL]: { schema: VALID_PAYLOAD_SCHEMA },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].field).toBe(
      `streamSpec.${CONTRACT_ERROR_CHANNEL}`,
    );
    expect(result.violations[0].message).toContain(RESERVED_CHANNEL_PREFIX);
    expect(result.violations[0].received).toBe(CONTRACT_ERROR_CHANNEL);
  });
});

// ───────────────────────────────────────────────────────────────────
// Item 4 — reserved-channel payload validation (injection pattern)
// ───────────────────────────────────────────────────────────────────

/** Canonical contract-error payload used across the block. */
const CANONICAL_CONTRACT_ERROR: ContractErrorPayload = {
  toolName: 'my-tool',
  error: {
    code: 'SCHEMA_VIOLATION',
    message: 'tool return violates the declared channel schema',
    causedBy: 'Error: boom',
  },
  timestamp: '2026-04-23T00:00:01.000Z',
  schemaVersion: '1.0.0',
};

describe('validateContractErrorPayload', () => {
  it('accepts the canonical payload with every field populated', () => {
    const result = validateContractErrorPayload(CANONICAL_CONTRACT_ERROR);
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('accepts the minimum-required-only shape', () => {
    const minimal: ContractErrorPayload = {
      toolName: 'my-tool',
      error: { code: 'SCHEMA_VIOLATION', message: 'boom' },
      timestamp: '2026-04-23T00:00:00.000Z',
    };
    const result = validateContractErrorPayload(minimal);
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rejects non-object payloads', () => {
    expect(validateContractErrorPayload(null).valid).toBe(false);
    expect(validateContractErrorPayload(undefined).valid).toBe(false);
    expect(validateContractErrorPayload('string').valid).toBe(false);
    expect(validateContractErrorPayload(42).valid).toBe(false);
    expect(validateContractErrorPayload([]).valid).toBe(false);
    const nullRes = validateContractErrorPayload(null);
    expect(nullRes.violations[0].field).toBe('payload');
    expect(nullRes.violations[0].received).toBe('null');
    const arrRes = validateContractErrorPayload([]);
    expect(arrRes.violations[0].received).toBe('array');
  });

  it('rejects missing toolName', () => {
    const { toolName: _omit, ...partial } = CANONICAL_CONTRACT_ERROR;
    void _omit;
    const result = validateContractErrorPayload(partial);
    expect(result.valid).toBe(false);
    const v = result.violations.find((x) => x.field === 'toolName');
    expect(v).toBeDefined();
    expect(v?.received).toBe('undefined');
  });

  it('rejects non-string toolName', () => {
    const result = validateContractErrorPayload({
      ...CANONICAL_CONTRACT_ERROR,
      toolName: 42 as unknown as string,
    });
    expect(result.valid).toBe(false);
    expect(
      result.violations.find((v) => v.field === 'toolName')?.received,
    ).toBe('number');
  });

  it('rejects missing error field', () => {
    const { error: _omit, ...partial } = CANONICAL_CONTRACT_ERROR;
    void _omit;
    const result = validateContractErrorPayload(partial);
    expect(result.valid).toBe(false);
    const v = result.violations.find((x) => x.field === 'error');
    expect(v).toBeDefined();
  });

  it('rejects missing error.code', () => {
    const result = validateContractErrorPayload({
      ...CANONICAL_CONTRACT_ERROR,
      error: { message: 'no code' },
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.field === 'error.code')).toBe(true);
  });

  it('rejects missing error.message', () => {
    const result = validateContractErrorPayload({
      ...CANONICAL_CONTRACT_ERROR,
      error: { code: 'SCHEMA_VIOLATION' },
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.field === 'error.message')).toBe(true);
  });

  it('rejects missing timestamp', () => {
    const { timestamp: _omit, ...partial } = CANONICAL_CONTRACT_ERROR;
    void _omit;
    const result = validateContractErrorPayload(partial);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.field === 'timestamp')).toBe(true);
  });

  it('accepts any error.code string (extensibly-closed per Item 2)', () => {
    for (const code of [
      'SCHEMA_VIOLATION',
      'SCHEMA_MISMATCH_ERROR',
      'SESSION_NOT_FOUND',
      'AUTH_REJECTED',
      'BOOTSTRAP_FAILED',
      'RATE_LIMIT_EXCEEDED',
      'MCP_TRANSPORT_ERROR',
      'FUTURE_CODE_NOBODY_HAS_INVENTED_YET',
    ]) {
      const result = validateContractErrorPayload({
        ...CANONICAL_CONTRACT_ERROR,
        error: { code, message: 'msg' },
      });
      expect(result.valid, `code=${code}`).toBe(true);
    }
  });

  it('rejects non-string optional fields when present', () => {
    const result = validateContractErrorPayload({
      ...CANONICAL_CONTRACT_ERROR,
      schemaVersion: true as unknown as string,
      error: {
        code: 'SCHEMA_VIOLATION',
        message: 'msg',
        causedBy: { not: 'a string' } as unknown as string,
      },
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.field === 'schemaVersion')).toBe(true);
    expect(result.violations.some((v) => v.field === 'error.causedBy')).toBe(true);
  });

  it('reports multiple violations on a deeply malformed payload', () => {
    const result = validateContractErrorPayload({
      // missing toolName, missing error.message, timestamp wrong type
      error: { code: 'SCHEMA_VIOLATION' },
      timestamp: 42,
    });
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
    expect(result.violations.map((v) => v.field)).toEqual(
      expect.arrayContaining(['toolName', 'error.message', 'timestamp']),
    );
  });
});

describe('BUILTIN_RESERVED_VALIDATORS', () => {
  it('contains exactly the protocol-owned reserved-channel validators', () => {
    // CONTRACT_ERROR_CHANNEL + LIFECYCLE_CHANNEL are protocol-owned.
    // PREVIEW_CHANNEL intentionally absent — A2UI-shaped, injected at
    // composition time per Protocol #6 vendor-neutrality.
    expect(BUILTIN_RESERVED_VALIDATORS.has(CONTRACT_ERROR_CHANNEL)).toBe(true);
    expect(BUILTIN_RESERVED_VALIDATORS.has(LIFECYCLE_CHANNEL)).toBe(true);
    expect(BUILTIN_RESERVED_VALIDATORS.has(PREVIEW_CHANNEL)).toBe(false);
    expect(Array.from(BUILTIN_RESERVED_VALIDATORS.keys()).sort()).toEqual(
      [CONTRACT_ERROR_CHANNEL, LIFECYCLE_CHANNEL].sort(),
    );
  });

  it('exposes the contract-error validator under the canonical channel name', () => {
    const validator = BUILTIN_RESERVED_VALIDATORS.get(CONTRACT_ERROR_CHANNEL);
    expect(validator).toBe(validateContractErrorPayload);
  });

  it('exposes the lifecycle validator under LIFECYCLE_CHANNEL', () => {
    const validator = BUILTIN_RESERVED_VALIDATORS.get(LIFECYCLE_CHANNEL);
    expect(validator).toBe(validateGguiLifecyclePayload);
  });

  it('is a read-only view — consumers cannot mutate the global registry', () => {
    // `Map` doesn't enforce readonly at runtime, but the type is
    // `ReadonlyMap`. A `.set` call through the declared interface
    // is a type error; confirm structural immutability by running
    // the validator after any attempt to overwrite fails at compile.
    const before = BUILTIN_RESERVED_VALIDATORS.get(CONTRACT_ERROR_CHANNEL);
    expect(before).toBeDefined();
  });
});

describe('validateStreamData — reserved-channel validator injection', () => {
  const SPEC_WITH_UNRELATED_CHANNEL: StreamSpec = {
    tick: {
      schema: { type: 'object', properties: { count: { type: 'number' } } },
    },
  };

  it('runs the BUILTIN validator on _ggui:contract-error (no injection)', () => {
    // A malformed contract-error payload hits the built-in validator
    // even without any caller-provided injection. Locks that the
    // protocol-owned payloads are validated by default.
    const malformed = { toolName: 'x' /* missing error + timestamp */ };
    const result = validateStreamData(
      CONTRACT_ERROR_CHANNEL,
      malformed,
      SPEC_WITH_UNRELATED_CHANNEL,
    );
    expect(result.valid).toBe(false);
    expect(
      result.violations.some((v) => v.field === 'error' || v.field === 'timestamp'),
    ).toBe(true);
  });

  it('accepts a well-formed contract-error payload via BUILTIN', () => {
    const result = validateStreamData(
      CONTRACT_ERROR_CHANNEL,
      CANONICAL_CONTRACT_ERROR,
      SPEC_WITH_UNRELATED_CHANNEL,
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('consults extraReservedValidators FIRST for a known reserved channel', () => {
    // Injection map wins over BUILTIN on contract-error — useful for a
    // hosting implementation that wants stricter validation than the
    // structural default (e.g., reject any code outside a known set).
    const strict: ReservedChannelValidator = (_payload) => ({
      valid: false,
      violations: [
        { field: 'injected', message: 'injected rejection', expected: 'ok', received: 'nope' },
      ],
    });
    const result = validateStreamData(
      CONTRACT_ERROR_CHANNEL,
      CANONICAL_CONTRACT_ERROR,
      SPEC_WITH_UNRELATED_CHANNEL,
      new Map([[CONTRACT_ERROR_CHANNEL, strict]]),
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('injected');
    expect(result.violations[0].message).toBe('injected rejection');
  });

  it('runs the injected _ggui:preview validator when provided', () => {
    const previewValidator: ReservedChannelValidator = (payload) =>
      typeof payload === 'object' && payload !== null && 'version' in payload
        ? { valid: true, violations: [] }
        : {
            valid: false,
            violations: [
              {
                field: 'payload',
                message: 'preview payload must carry a version field',
                expected: 'A2UI ServerMessage',
                received: 'unversioned',
              },
            ],
          };
    const good = validateStreamData(
      PREVIEW_CHANNEL,
      { version: 'v0.9', createSurface: {} },
      SPEC_WITH_UNRELATED_CHANNEL,
      new Map([[PREVIEW_CHANNEL, previewValidator]]),
    );
    expect(good.valid).toBe(true);
    const bad = validateStreamData(
      PREVIEW_CHANNEL,
      { not: 'a2ui' },
      SPEC_WITH_UNRELATED_CHANNEL,
      new Map([[PREVIEW_CHANNEL, previewValidator]]),
    );
    expect(bad.valid).toBe(false);
    expect(bad.violations[0].field).toBe('payload');
  });

  it('falls through to valid when no validator is registered for a known reserved channel', () => {
    // Preserves today's behavior for PREVIEW_CHANNEL when the server
    // didn't inject an A2UI validator. Locks the documented
    // degradation mode named in the plan.
    const result = validateStreamData(
      PREVIEW_CHANNEL,
      { anything: 'goes' },
      SPEC_WITH_UNRELATED_CHANNEL,
      // no extra map
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('does not apply reserved validators to unknown reserved-prefix names', () => {
    // Closed-set integrity: `_ggui:preveiw` typo falls through to the
    // normal unknown-channel rejection even when a validator is
    // provided for _ggui:preview.
    const previewValidator: ReservedChannelValidator = () => ({
      valid: true,
      violations: [],
    });
    const result = validateStreamData(
      '_ggui:preveiw',
      { not: 'recognized' },
      SPEC_WITH_UNRELATED_CHANNEL,
      new Map([[PREVIEW_CHANNEL, previewValidator]]),
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('channel');
    expect(result.violations[0].message).toContain('Unknown stream channel');
  });

  it('ignores the extras map on non-reserved channels', () => {
    // Extras only govern the reserved-channel lookup. A validator
    // keyed on an agent channel name does NOT fire there — the normal
    // streamSpec schema check runs instead.
    const overrider: ReservedChannelValidator = () => ({
      valid: false,
      violations: [
        { field: 'should-never-fire', message: 'x', expected: 'x', received: 'x' },
      ],
    });
    const result = validateStreamData(
      'tick',
      { count: 7 },
      SPEC_WITH_UNRELATED_CHANNEL,
      new Map([['tick', overrider]]),
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe('validateGguiLifecyclePayload', () => {
  it('accepts each known kind with required fields', () => {
    expect(
      validateGguiLifecyclePayload({
        kind: 'handshake_started',
        handshakeId: 'h-1',
        intent: 'show weather',
      }).valid,
    ).toBe(true);
    expect(
      validateGguiLifecyclePayload({
        kind: 'handshake_completed',
        handshakeId: 'h-1',
        outcome: 'accepted',
        genExpected: true,
      }).valid,
    ).toBe(true);
    expect(
      validateGguiLifecyclePayload({
        kind: 'render_started',
        sessionId: 'render-1',
        intent: 'show weather',
      }).valid,
    ).toBe(true);
    expect(
      validateGguiLifecyclePayload({
        kind: 'consume_polling',
        state: 'open',
        sessionId: 'render-1',
      }).valid,
    ).toBe(true);
  });

  it('rejects non-object / null / array payloads', () => {
    expect(validateGguiLifecyclePayload(null).valid).toBe(false);
    expect(validateGguiLifecyclePayload([]).valid).toBe(false);
    expect(validateGguiLifecyclePayload('string').valid).toBe(false);
    expect(validateGguiLifecyclePayload(42).valid).toBe(false);
  });

  it('rejects unknown kind values (closed union)', () => {
    const result = validateGguiLifecyclePayload({
      kind: 'future_kind',
      whatever: 'value',
    });
    expect(result.valid).toBe(false);
    expect(result.violations[0]?.field).toBe('kind');
  });

  it('rejects missing required fields per variant', () => {
    expect(
      validateGguiLifecyclePayload({ kind: 'handshake_started' }).valid,
    ).toBe(false);
    expect(
      validateGguiLifecyclePayload({ kind: 'render_started', sessionId: 'x' })
        .valid,
    ).toBe(false);
    expect(
      validateGguiLifecyclePayload({
        kind: 'consume_polling',
        sessionId: 'x',
        state: 'closed', // wrong literal
      }).valid,
    ).toBe(false);
    expect(
      validateGguiLifecyclePayload({
        kind: 'handshake_completed',
        handshakeId: 'h-1',
        outcome: 'bogus',
        genExpected: true,
      }).valid,
    ).toBe(false);
  });
});
