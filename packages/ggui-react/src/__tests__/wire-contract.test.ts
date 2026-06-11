/**
 * Pure-helper tests for client contract validators. Mirrors the
 * protocol-validator invariants pinned by the
 * `channelEnforcementContract` suite from
 * `@ggui-ai/mcp-server-core/contract-tests`, but from the CLIENT
 * boundary-point perspective:
 *
 *   - server inbound action (`assertActionContract`) ⇔ client
 *     outbound action (`validateOutboundActionPayload`)
 *   - server outbound fan-out (`assertStreamContract`) ⇔ client
 *     inbound stream (`validateInboundStreamPayload`)
 *   - (new) client inbound props — no server contract-suite case
 *     today, but the validator's semantics match the server's
 *     `assertPropsContract` used in `ggui_update`.
 *
 * There is no event-allowlist gate on either side — inbound actions
 * are gated by the action contract alone (the pre-Phase-B
 * `subscription.events` allowlist was deleted with the session-stack
 * collapse). If a future slice reinstates per-render event policy, a
 * client-side check can be added without changing these three
 * helpers.
 */
import { describe, expect, it } from 'vitest';
import type { ActionSpec, PropsSpec, StreamSpec } from '@ggui-ai/protocol';
import {
  ClientContractViolationError,
  validateInboundPropsPayload,
  validateInboundStreamPayload,
  validateOutboundActionPayload,
} from '@ggui-ai/wire';

const ACTIONS: ActionSpec = {
  submit: {
    label: 'Submit',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  archive: { label: 'Archive' }, // void-payload
};

const STREAM: StreamSpec = {
  tick: {
    schema: {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    },
  },
};

const PROPS: PropsSpec = {
  properties: {
    city: { required: true, schema: { type: 'string' } },
    temp: { schema: { type: 'number' } },
  },
};

describe('validateOutboundActionPayload', () => {
  it('permissive when actionSpec is undefined (no contract = nothing to enforce)', () => {
    const r = validateOutboundActionPayload(undefined, 'anything', { x: 1 });
    expect(r.valid).toBe(true);
  });

  it('passes for declared action with matching payload', () => {
    const r = validateOutboundActionPayload(ACTIONS, 'submit', { text: 'hi' });
    expect(r.valid).toBe(true);
  });

  it('passes for declared void-payload action (no schema)', () => {
    const r = validateOutboundActionPayload(ACTIONS, 'archive', undefined);
    expect(r.valid).toBe(true);
  });

  it('tolerates forward-compat metadata on a void-payload action', () => {
    const r = validateOutboundActionPayload(ACTIONS, 'archive', { meta: 'x' });
    expect(r.valid).toBe(true);
  });

  it('rejects undeclared action id', () => {
    const r = validateOutboundActionPayload(ACTIONS, 'deleteAccount', {});
    expect(r.valid).toBe(false);
    expect(r.violations[0].field).toBe('action');
  });

  it('rejects malformed data for a declared action', () => {
    const r = validateOutboundActionPayload(ACTIONS, 'submit', 'not-an-object');
    expect(r.valid).toBe(false);
  });
});

describe('validateInboundStreamPayload', () => {
  it('permissive when streamSpec is undefined', () => {
    const r = validateInboundStreamPayload(undefined, 'anything', {});
    expect(r.valid).toBe(true);
  });

  it('passes for declared channel with matching payload', () => {
    const r = validateInboundStreamPayload(STREAM, 'tick', { count: 3 });
    expect(r.valid).toBe(true);
  });

  it('rejects undeclared channel with declared-channels list in message', () => {
    const r = validateInboundStreamPayload(STREAM, 'mystery', {});
    expect(r.valid).toBe(false);
    expect(r.violations[0].message).toContain('tick');
  });

  // ── Item 4 reserved-channel injection ────────────────────────────
  describe('reserved-channel injection (Item 4)', () => {
    it('runs BUILTIN validator on _ggui:lifecycle without an injected extras map', () => {
      // A malformed lifecycle payload fails even with no
      // streamSpec AND no extras — the protocol ships the BUILTIN.
      const r = validateInboundStreamPayload(
        undefined,
        '_ggui:lifecycle',
        { kind: 'render_started' /* missing sessionId + intent */ },
      );
      expect(r.valid).toBe(false);
      expect(r.violations.map((v) => v.field)).toEqual(
        expect.arrayContaining(['sessionId', 'intent']),
      );
    });

    it('accepts a canonical lifecycle payload via BUILTIN', () => {
      const r = validateInboundStreamPayload(
        undefined,
        '_ggui:lifecycle',
        {
          kind: 'render_started',
          sessionId: 'render-1',
          intent: 'show weather',
        },
      );
      expect(r.valid).toBe(true);
    });

    it('falls through to valid on _ggui:preview when no injection provided', () => {
      // No protocol-shipped validator for PREVIEW_CHANNEL — consumers
      // that want A2UI enforcement compose the validator via
      // `GguiRender.extraReservedValidators` (default) or pass
      // their own map here.
      const r = validateInboundStreamPayload(
        STREAM,
        '_ggui:preview',
        { anything: 'goes' },
      );
      expect(r.valid).toBe(true);
    });

    it('fires an injected _ggui:preview validator', () => {
      const reject: (p: unknown) => {
        valid: boolean;
        violations: Array<{ field: string; message: string }>;
      } = () => ({
        valid: false,
        violations: [
          { field: 'payload', message: 'malformed' },
        ],
      });
      const r = validateInboundStreamPayload(
        STREAM,
        '_ggui:preview',
        { not: 'a2ui' },
        new Map([['_ggui:preview', reject]]),
      );
      expect(r.valid).toBe(false);
      expect(r.violations[0].field).toBe('payload');
    });

    it('rejects reserved-prefix typos via the F10 closed-set rule', () => {
      // `_ggui:preveiw` is NOT in KNOWN_RESERVED_CHANNELS; the
      // typo falls through to the declared-channel check even with
      // a validator keyed on the correct name.
      const pass: (p: unknown) => { valid: boolean; violations: never[] } = () => ({
        valid: true,
        violations: [],
      });
      const r = validateInboundStreamPayload(
        STREAM,
        '_ggui:preveiw',
        { not: 'recognized' },
        new Map([['_ggui:preview', pass]]),
      );
      expect(r.valid).toBe(false);
      expect(r.violations[0].field).toBe('channel');
    });
  });
});

describe('validateInboundPropsPayload', () => {
  it('permissive when propsSpec is undefined', () => {
    const r = validateInboundPropsPayload(undefined, { city: 'Seoul' });
    expect(r.valid).toBe(true);
  });

  it('passes when required props present', () => {
    const r = validateInboundPropsPayload(PROPS, { city: 'Seoul', temp: 15 });
    expect(r.valid).toBe(true);
  });

  it('rejects when required prop missing', () => {
    const r = validateInboundPropsPayload(PROPS, { temp: 15 });
    expect(r.valid).toBe(false);
    expect(r.violations[0].field).toBe('city');
  });
});

describe('ClientContractViolationError', () => {
  it('carries direction + violations + is throwable as Error', () => {
    const err = new ClientContractViolationError('outbound-action', [
      { field: 'action', message: 'bad' },
    ]);
    expect(err).toBeInstanceOf(Error);
    expect(err.direction).toBe('outbound-action');
    expect(err.violations).toHaveLength(1);
    expect(err.name).toBe('ClientContractViolationError');
  });

  it('accepts all three direction codes', () => {
    const a = new ClientContractViolationError('outbound-action', []);
    const b = new ClientContractViolationError('inbound-stream', []);
    const c = new ClientContractViolationError('inbound-props', []);
    expect(a.direction).toBe('outbound-action');
    expect(b.direction).toBe('inbound-stream');
    expect(c.direction).toBe('inbound-props');
  });
});
