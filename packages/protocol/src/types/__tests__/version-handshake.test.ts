/**
 * Shape-lock for the protocol-version handshake — `SubscribePayload
 * .supportedVersions` + `AckPayload.serverVersion` + the canonical
 * `UPGRADE_REQUIRED` code on `ErrorPayload.code`.
 *
 * Phase 1 Item 6 ships the handshake infrastructure; Phase 3 flips
 * server default policy to `reject`. These tests pin the wire-shape
 * contract so the Phase 3 flip is a policy toggle, not a schema
 * change.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  AckPayload,
  ErrorPayload,
  SubscribePayload,
} from '../live-channel.js';
import {
  CLIENT_SUPPORTED_VERSIONS,
  PROTOCOL_SCHEMA_VERSION,
  UPGRADE_REQUIRED,
} from '../../version.js';
import { makeErrorPayload } from '../../envelopes/builders.js';

describe('SubscribePayload.supportedVersions', () => {
  it('is optional on the wire — absent payload round-trips unchanged', () => {
    // Legacy-pass-through: clients that don't opt into the handshake
    // MUST continue to subscribe exactly as before. No field added on
    // serialization.
    const legacy: SubscribePayload = {
      sessionId: 'sess_a',
      appId: 'app_x',
    };
    const wire = JSON.stringify(legacy);
    const parsed = JSON.parse(wire) as SubscribePayload;
    expect(parsed).toEqual({ sessionId: 'sess_a', appId: 'app_x' });
    expect('supportedVersions' in parsed).toBe(false);
  });

  it('round-trips a populated supportedVersions array', () => {
    const envelope: SubscribePayload = {
      sessionId: 'sess_a',
      appId: 'app_x',
      supportedVersions: [PROTOCOL_SCHEMA_VERSION],
    };
    const parsed = JSON.parse(JSON.stringify(envelope)) as SubscribePayload;
    expect(parsed.supportedVersions).toEqual([PROTOCOL_SCHEMA_VERSION]);
  });

  it('types supportedVersions as an array of strings', () => {
    expectTypeOf<NonNullable<SubscribePayload['supportedVersions']>>()
      .toEqualTypeOf<string[]>();
  });
});

describe('AckPayload.serverVersion', () => {
  it('is optional on the wire — absent payload round-trips unchanged', () => {
    const legacy: AckPayload = {
      sequence: 0,
      timestamp: 1,
    };
    const parsed = JSON.parse(JSON.stringify(legacy)) as AckPayload;
    expect(parsed).toEqual({ sequence: 0, timestamp: 1 });
    expect('serverVersion' in parsed).toBe(false);
  });

  it('round-trips a populated serverVersion string', () => {
    const envelope: AckPayload = {
      sequence: 0,
      timestamp: 1,
      serverVersion: PROTOCOL_SCHEMA_VERSION,
    };
    const parsed = JSON.parse(JSON.stringify(envelope)) as AckPayload;
    expect(parsed.serverVersion).toBe(PROTOCOL_SCHEMA_VERSION);
  });

  it('types serverVersion as string', () => {
    expectTypeOf<NonNullable<AckPayload['serverVersion']>>()
      .toEqualTypeOf<string>();
  });
});

describe('UPGRADE_REQUIRED constant', () => {
  it('exposes the canonical literal value', () => {
    expect(UPGRADE_REQUIRED).toBe('UPGRADE_REQUIRED');
  });

  it('is assignable to ErrorPayload.code (open-string union)', () => {
    const err: ErrorPayload = {
      code: UPGRADE_REQUIRED,
      message: 'Server speaks a version this client does not support.',
    };
    expect(err.code).toBe('UPGRADE_REQUIRED');
  });

  it('routes through makeErrorPayload without stamping schemaVersion', () => {
    // ErrorPayload does NOT opt into the forward-compat
    // `schemaVersion` stamp — see the builder's docstring. The
    // returned payload is byte-equivalent to the pre-builder
    // inline `{code, message}` pattern.
    const payload = makeErrorPayload({
      code: UPGRADE_REQUIRED,
      message: 'mismatch',
    });
    expect(payload).toEqual({
      code: 'UPGRADE_REQUIRED',
      message: 'mismatch',
    });
    expect('schemaVersion' in payload).toBe(false);
  });

  it('makeErrorPayload preserves details when present, omits when absent', () => {
    const withDetails = makeErrorPayload({
      code: UPGRADE_REQUIRED,
      message: 'mismatch',
      details: { server: 'v2', client: ['v1'] },
    });
    expect(withDetails).toEqual({
      code: 'UPGRADE_REQUIRED',
      message: 'mismatch',
      details: { server: 'v2', client: ['v1'] },
    });

    const withoutDetails = makeErrorPayload({
      code: 'X',
      message: 'y',
    });
    expect('details' in withoutDetails).toBe(false);
  });
});

describe('CLIENT_SUPPORTED_VERSIONS', () => {
  it('includes the current PROTOCOL_SCHEMA_VERSION', () => {
    expect(CLIENT_SUPPORTED_VERSIONS).toContain(PROTOCOL_SCHEMA_VERSION);
  });

  it('is frozen so runtime consumers cannot mutate the list', () => {
    expect(Object.isFrozen(CLIENT_SUPPORTED_VERSIONS)).toBe(true);
  });

  it('is typed readonly string[]', () => {
    expectTypeOf<typeof CLIENT_SUPPORTED_VERSIONS>()
      .toEqualTypeOf<readonly string[]>();
  });
});
