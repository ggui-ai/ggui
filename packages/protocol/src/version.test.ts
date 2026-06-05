/**
 * Pins the canonical {@link PROTOCOL_VERSION} string. The constant is
 * the cache-invalidation + capability-discovery anchor; an unintended
 * edit silently invalidates caches and shifts the version handshake, so
 * the value is locked here. Bumps are deliberate: update this assertion
 * in the same change that moves the constant.
 */
import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  PROTOCOL_SCHEMA_VERSION,
  CLIENT_SUPPORTED_VERSIONS,
} from './version.js';

describe('PROTOCOL_VERSION', () => {
  it('is the current draft', () => {
    expect(PROTOCOL_VERSION).toBe('draft-2026-06-05');
  });

  it('schema version aliases the protocol version', () => {
    expect(PROTOCOL_SCHEMA_VERSION).toBe(PROTOCOL_VERSION);
  });

  it('client accepts the current schema version', () => {
    expect(CLIENT_SUPPORTED_VERSIONS).toContain(PROTOCOL_SCHEMA_VERSION);
  });
});
