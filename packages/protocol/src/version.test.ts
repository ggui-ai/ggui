/**
 * Pins the canonical {@link PROTOCOL_VERSION} string. The constant is
 * the cache-invalidation + capability-discovery anchor; an unintended
 * edit silently invalidates caches and shifts the version handshake, so
 * the value is locked here. Bumps are deliberate: update this assertion
 * in the same change that moves the constant.
 */
import { describe, it, expect } from 'vitest';
import {
  GGUI_WAVE_VERSION,
  PROTOCOL_VERSION,
  PROTOCOL_SCHEMA_VERSION,
  CLIENT_SUPPORTED_VERSIONS,
} from './version.js';

describe('PROTOCOL_VERSION', () => {
  it('is the current draft', () => {
    expect(PROTOCOL_VERSION).toBe('draft-2026-08-19');
  });

  it('schema version aliases the protocol version', () => {
    expect(PROTOCOL_SCHEMA_VERSION).toBe(PROTOCOL_VERSION);
  });

  it('client accepts the current schema version', () => {
    expect(CLIENT_SUPPORTED_VERSIONS).toContain(PROTOCOL_SCHEMA_VERSION);
  });
});

describe('GGUI_WAVE_VERSION — the shipped @ggui-ai/* wave (ggui#623)', () => {
  it('matches this package\'s version — every @ggui-ai/* package carries ONE wave version', async () => {
    // The wave constant is what runtime surfaces (MCP serverInfo,
    // MCP Apps appInfo) report to connected agents. Pinned against
    // `packages/protocol/package.json#version` — the lockstep cohort
    // anchor — so a release bump without moving the constant fails CI
    // instead of lying to every agent about what it is talking to
    // (the ggui#622 class). Same pattern as stdlib-parity.test.ts and
    // mcp-client.test.ts; the /release:cut straggler list names it.
    const pkg = (await import('../package.json', { with: { type: 'json' } })) as {
      default: { version: string };
    };
    expect(GGUI_WAVE_VERSION).toBe(pkg.default.version);
  });

  it('is bare semver (no v prefix — what package.json and npm install speak)', () => {
    expect(GGUI_WAVE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
