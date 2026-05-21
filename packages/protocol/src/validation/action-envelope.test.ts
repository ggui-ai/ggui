/**
 * ActionEnvelope validator tests + shape locks.
 *
 * Covers the payload-contract validator and the symmetry with the
 * legacy `validateActionData` (both delegate to the same underlying
 * schema walk — same inputs → same outputs).
 */
import { describe, expect, it, expectTypeOf } from 'vitest';
import {
  validateActionData,
  validateActionEnvelope,
} from './contract-validator.js';
import type { WebSocketMessage } from '../transport/websocket.js';
import type {
  ActionEnvelope,
  ActionSpec,
} from '../index.js';

const ACTION_SPEC: ActionSpec = {
  submit: {
    label: 'Submit',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  voidAction: {
    label: 'Void',
  },
};

describe('validateActionEnvelope', () => {
  it('is permissive when actionSpec is undefined', () => {
    const envelope: ActionEnvelope = {
      sessionId: 'sess-1',
      type: 'data:submit',
      payload: { action: 'submit', data: { text: 'hello' } },
    };
    const result = validateActionEnvelope(envelope, undefined);
    expect(result).toEqual({ valid: true, violations: [] });
  });

  it("skips payload check for non-data:submit types — 'lifecycle:session_end' passes without actionSpec lookup", () => {
    const envelope: ActionEnvelope = {
      sessionId: 'sess-1',
      type: 'lifecycle:session_end',
    };
    // Even with an actionSpec that requires everything, lifecycle events
    // don't carry action payloads.
    const result = validateActionEnvelope(envelope, ACTION_SPEC);
    expect(result).toEqual({ valid: true, violations: [] });
  });

  it('skips payload check for interaction:click', () => {
    const envelope: ActionEnvelope = {
      sessionId: 'sess-1',
      type: 'interaction:click',
      payload: { anything: 'goes' },
    };
    const result = validateActionEnvelope(envelope, ACTION_SPEC);
    expect(result.valid).toBe(true);
  });

  it('accepts data:submit with a declared action + matching payload', () => {
    const envelope: ActionEnvelope = {
      sessionId: 'sess-1',
      type: 'data:submit',
      payload: { action: 'submit', data: { text: 'hello' } },
    };
    const result = validateActionEnvelope(envelope, ACTION_SPEC);
    expect(result).toEqual({ valid: true, violations: [] });
  });

  it('accepts data:submit for a void-payload action (no schema on actionSpec entry)', () => {
    const envelope: ActionEnvelope = {
      sessionId: 'sess-1',
      type: 'data:submit',
      payload: { action: 'voidAction' },
    };
    const result = validateActionEnvelope(envelope, ACTION_SPEC);
    expect(result).toEqual({ valid: true, violations: [] });
  });

  it('rejects data:submit when action id is not declared', () => {
    const envelope: ActionEnvelope = {
      sessionId: 'sess-1',
      type: 'data:submit',
      payload: { action: 'deleteAccount', data: {} },
    };
    const result = validateActionEnvelope(envelope, ACTION_SPEC);
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('rejects data:submit when a required field is missing', () => {
    const envelope: ActionEnvelope = {
      sessionId: 'sess-1',
      type: 'data:submit',
      // `text` is required by the actionSpec; the object lacks it.
      payload: { action: 'submit', data: {} },
    };
    const result = validateActionEnvelope(envelope, ACTION_SPEC);
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('rejects data:submit when action payload.data is the wrong shape (primitive vs declared object)', () => {
    const envelope: ActionEnvelope = {
      sessionId: 'sess-1',
      type: 'data:submit',
      // `data` is declared as an object; a string hits the
      // object-vs-primitive mismatch path.
      payload: { action: 'submit', data: 'not-an-object' },
    };
    const result = validateActionEnvelope(envelope, ACTION_SPEC);
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('rejects data:submit when payload is not an object (missing ActionEventValue shape)', () => {
    const envelope: ActionEnvelope = {
      sessionId: 'sess-1',
      type: 'data:submit',
      payload: null,
    };
    const result = validateActionEnvelope(envelope, ACTION_SPEC);
    expect(result.valid).toBe(false);
  });
});

describe('validateActionEnvelope ↔ validateActionData — symmetry', () => {
  it('produces the same ValidationResult as validateActionData when type is data:submit', () => {
    // Identical enforcement outcomes for the two callable surfaces.
    // Same ActionSpec, same payload → same {valid, violations}.
    const goodPayload = { action: 'submit', data: { text: 'ok' } };
    const badPayload = { action: 'submit', data: { text: 42 } };
    const undeclared = { action: 'whoami', data: {} };

    const envelopeGood: ActionEnvelope = {
      sessionId: 's',
      type: 'data:submit',
      payload: goodPayload,
    };
    const envelopeBad: ActionEnvelope = {
      sessionId: 's',
      type: 'data:submit',
      payload: badPayload,
    };
    const envelopeUndeclared: ActionEnvelope = {
      sessionId: 's',
      type: 'data:submit',
      payload: undeclared,
    };

    expect(validateActionEnvelope(envelopeGood, ACTION_SPEC)).toEqual(
      validateActionData(goodPayload, ACTION_SPEC),
    );
    expect(validateActionEnvelope(envelopeBad, ACTION_SPEC)).toEqual(
      validateActionData(badPayload, ACTION_SPEC),
    );
    expect(validateActionEnvelope(envelopeUndeclared, ACTION_SPEC)).toEqual(
      validateActionData(undeclared, ACTION_SPEC),
    );
  });
});

describe('ActionEnvelope — type shape', () => {
  it('is assignable into WebSocketMessage of type action', () => {
    // Structural lock: the ActionEnvelope lands on the 'action' variant
    // of WebSocketMessage.
    const envelope: ActionEnvelope = {
      sessionId: 'sess-1',
      type: 'data:submit',
      payload: { action: 'submit', data: { text: 'ok' } },
    };
    const message: WebSocketMessage = { type: 'action', payload: envelope };
    if (message.type === 'action') {
      expectTypeOf(message.payload).toEqualTypeOf<ActionEnvelope>();
    }
  });

  it('sessionId + type are required; other fields optional', () => {
    // Forces sessionId and type; allows absent optionals.
    const minimal: ActionEnvelope = {
      sessionId: 's',
      type: 'lifecycle:session_end',
    };
    expect(minimal.payload).toBeUndefined();
    expect(minimal.stackIndex).toBeUndefined();
    expect(minimal.stackItemId).toBeUndefined();
    expect(minimal.clientSeq).toBeUndefined();
  });

  it('payload is generic-typed', () => {
    interface SubmitPayload {
      action: 'submit';
      data: { text: string };
    }
    const envelope: ActionEnvelope<SubmitPayload> = {
      sessionId: 's',
      type: 'data:submit',
      payload: { action: 'submit', data: { text: 'hi' } },
    };
    expectTypeOf(envelope.payload).toEqualTypeOf<SubmitPayload | undefined>();
  });

  it('structural lock: envelope does NOT carry diagnostic bag fields', () => {
    // If these became required keys of ActionEnvelope, the cast below
    // would fail — catching drift where diagnostic context creeps back
    // onto the per-delivery envelope.
    type EnvelopeKeys = keyof ActionEnvelope;
    expectTypeOf<'deviceInfo'>().not.toEqualTypeOf<EnvelopeKeys>();
    expectTypeOf<'interfaceContext'>().not.toEqualTypeOf<EnvelopeKeys>();
    expectTypeOf<'user'>().not.toEqualTypeOf<EnvelopeKeys>();
    expectTypeOf<'userId'>().not.toEqualTypeOf<EnvelopeKeys>();
    expectTypeOf<'appId'>().not.toEqualTypeOf<EnvelopeKeys>();
    expectTypeOf<'componentId'>().not.toEqualTypeOf<EnvelopeKeys>();
    expectTypeOf<'timestamp'>().not.toEqualTypeOf<EnvelopeKeys>();
    expectTypeOf<'correlationId'>().not.toEqualTypeOf<EnvelopeKeys>();
  });
});
