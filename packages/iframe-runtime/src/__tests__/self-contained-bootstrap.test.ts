/**
 * Iframe runtime accepts content-addressable codeUrl on the bootstrap
 * envelope (the sole static-component delivery channel post-T3-1
 * 2026-05-13) and stays compatible with system cards + the existing
 * Path B (`_meta.ggui.bootstrap` postMessage) extraction.
 *
 * These cover the parser narrowing only — the actual fetch + mount
 * path is exercised end-to-end against a real iframe in higher-tier
 * specs.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  bootstrapToMcpAppMeta,
  type GguiBootstrapMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  extractBootstrapFromToolResult,
  readSelfContainedBootstrap,
  type SelfContainedBootstrap,
} from '../runtime.js';

const SAMPLE_CODE_URL = 'https://app.example.com/code/abc123.js';
// Slice 14 (2026-05-08) — `runtimeUrl` is required across all modes,
// so every fixture in this suite needs to carry it (without changing
// the per-test focus).
const SAMPLE_RUNTIME_URL = '/_ggui/iframe-runtime.js';

function buildToolResultParams(bootstrap: unknown): unknown {
  return { _meta: bootstrapToMcpAppMeta(bootstrap as GguiBootstrapMeta) };
}

describe('extractBootstrapFromToolResult — Slice 3 codeUrl', () => {
  it('accepts a bootstrap with codeUrl alone (Slice 3 preferred path)', () => {
    const result = extractBootstrapFromToolResult(
      buildToolResultParams({
        sessionId: 's1',
        appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
        codeUrl: SAMPLE_CODE_URL,
      }),
    );
    expect(result).not.toBeNull();
    if (result === null || result.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect(result.codeUrl).toBe(SAMPLE_CODE_URL);
  });

  // The inline `componentCode` channel was retired 2026-05-13 (T3-1).
  // Static-component bootstraps are now `codeUrl`-only; the parser
  // ignores any stray `componentCode` field and never surfaces it.

  it('returns null when codeUrl is not present', () => {
    expect(
      extractBootstrapFromToolResult(
        buildToolResultParams({ sessionId: 's1', appId: 'a1' }),
      ),
    ).toBeNull();
  });

  it('returns null when codeUrl is empty string', () => {
    expect(
      extractBootstrapFromToolResult(
        buildToolResultParams({
          sessionId: 's1',
          appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
          codeUrl: '',
        }),
      ),
    ).toBeNull();
  });

  it('returns null when codeUrl is non-string', () => {
    expect(
      extractBootstrapFromToolResult(
        buildToolResultParams({
          sessionId: 's1',
          appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
          codeUrl: 42,
        }),
      ),
    ).toBeNull();
  });

  it('rejects a malformed system+code mix (codeUrl on a kind variant)', () => {
    // System variant MUST NOT carry component-bytes fields. The mixed
    // shape signals a malformed wire envelope; reject rather than
    // guess which branch the producer intended.
    expect(
      extractBootstrapFromToolResult(
        buildToolResultParams({
          sessionId: 's1',
          appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
          kind: 'connect-claude',
          codeUrl: SAMPLE_CODE_URL,
        }),
      ),
    ).toBeNull();
  });

  it('still accepts a clean system-card bootstrap (kind only, no code)', () => {
    const result = extractBootstrapFromToolResult(
      buildToolResultParams({
        sessionId: 's1',
        appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
        kind: 'connect-claude',
      }),
    );
    expect(result).not.toBeNull();
    if (result === null || result.kind === undefined) {
      throw new Error('expected system variant');
    }
    expect(result.kind).toBe('connect-claude');
  });
});

describe('readSelfContainedBootstrap — Slice 3 codeUrl on window global', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { __GGUI_BOOTSTRAP__?: unknown })
      .__GGUI_BOOTSTRAP__;
  });

  afterEach(() => {
    delete (globalThis as unknown as { __GGUI_BOOTSTRAP__?: unknown })
      .__GGUI_BOOTSTRAP__;
  });

  it('reads codeUrl from window.__GGUI_BOOTSTRAP__', () => {
    (globalThis as unknown as { __GGUI_BOOTSTRAP__: unknown }).__GGUI_BOOTSTRAP__ = {
      sessionId: 's1',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
    };
    const bs = readSelfContainedBootstrap();
    expect(bs).not.toBeNull();
    if (bs === null || bs.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect(bs.codeUrl).toBe(SAMPLE_CODE_URL);
  });

  it('returns null when codeUrl is absent', () => {
    (globalThis as unknown as { __GGUI_BOOTSTRAP__: unknown }).__GGUI_BOOTSTRAP__ = {
      sessionId: 's1',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
    };
    expect(readSelfContainedBootstrap()).toBeNull();
  });

  it('passes themeMode through when set to "dark"', () => {
    (globalThis as unknown as { __GGUI_BOOTSTRAP__: unknown }).__GGUI_BOOTSTRAP__ = {
      sessionId: 's1',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      themeId: 'claudic',
      themeMode: 'dark',
    };
    const bs = readSelfContainedBootstrap();
    expect(bs).not.toBeNull();
    if (bs === null || bs.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect(bs.themeId).toBe('claudic');
    expect(bs.themeMode).toBe('dark');
  });

  it('passes themeMode through for system-card variant', () => {
    (globalThis as unknown as { __GGUI_BOOTSTRAP__: unknown }).__GGUI_BOOTSTRAP__ = {
      sessionId: 's1',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      kind: 'no-credentials',
      themeId: 'claudic',
      themeMode: 'dark',
    };
    const bs = readSelfContainedBootstrap();
    expect(bs).not.toBeNull();
    if (bs === null || bs.kind === undefined) {
      throw new Error('expected system variant');
    }
    expect(bs.themeMode).toBe('dark');
  });

  it('drops malformed themeMode silently (falls back to undefined)', () => {
    (globalThis as unknown as { __GGUI_BOOTSTRAP__: unknown }).__GGUI_BOOTSTRAP__ = {
      sessionId: 's1',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      themeMode: 'twilight', // not in the closed 'light' | 'dark' set
    };
    const bs = readSelfContainedBootstrap();
    expect(bs).not.toBeNull();
    if (bs === null || bs.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect(bs.themeMode).toBeUndefined();
  });

  it('omits themeMode when absent from bootstrap', () => {
    (globalThis as unknown as { __GGUI_BOOTSTRAP__: unknown }).__GGUI_BOOTSTRAP__ = {
      sessionId: 's1',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
    };
    const bs = readSelfContainedBootstrap();
    expect(bs).not.toBeNull();
    if (bs === null || bs.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect('themeMode' in bs).toBe(false);
  });
});

// Type-level lock: `codeUrl` is the sole static-component discriminator
// (T3-1 2026-05-13 retired the inline `componentCode` channel).
describe('SelfContainedBootstrap typing', () => {
  it('allows constructing a component variant with codeUrl', () => {
    const bs: SelfContainedBootstrap = {
      sessionId: 's1',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
    };
    expect(bs.codeUrl).toBe(SAMPLE_CODE_URL);
  });
});
