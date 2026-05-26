/**
 * Iframe runtime accepts content-addressable codeUrl on the bootstrap
 * envelope (the sole static-component delivery channel post-T3-1
 * 2026-05-13) and stays compatible with system cards + the existing
 * Path B (`_meta` postMessage) extraction.
 *
 * These cover the parser narrowing only — the actual fetch + mount
 * path is exercised end-to-end against a real iframe in higher-tier
 * specs.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  metaToMcpAppMeta,
  type McpAppAiGguiMeta,
  type McpAppAiGguiSessionMeta,
  type McpAppAiGguiStackItemMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  extractMetaFromToolResult,
  readSelfContainedMeta,
  type SelfContainedMcpAppAiGguiMeta,
} from '../runtime.js';

const SAMPLE_CODE_URL = 'https://app.example.com/code/abc123.js';
// Slice 14 (2026-05-08) — `runtimeUrl` is required across all modes,
// so every fixture in this suite needs to carry it (without changing
// the per-test focus).
const SAMPLE_RUNTIME_URL = '/_ggui/iframe-runtime.js';

const SESSION_FIELDS = new Set<string>([
  'sessionId', 'appId', 'runtimeUrl', 'wsUrl', 'token', 'expiresAt',
  'pollingUrl', 'themeId', 'themeMode', 'canvasMode', 'gadgets',
  'publicEnv', 'streamWebSocketLocalTools', 'appCallableTools',
  'permissionsPolicy',
]);

function flatToMeta(flat: unknown): McpAppAiGguiMeta {
  if (flat === null || typeof flat !== 'object' || Array.isArray(flat)) {
    return { session: flat as unknown as McpAppAiGguiSessionMeta };
  }
  const sessionRaw: Record<string, unknown> = {};
  const stackItemRaw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat as Record<string, unknown>)) {
    if (SESSION_FIELDS.has(k)) sessionRaw[k] = v;
    else stackItemRaw[k] = v;
  }
  return {
    session: sessionRaw as unknown as McpAppAiGguiSessionMeta,
    ...(Object.keys(stackItemRaw).length > 0
      ? { stackItem: stackItemRaw as unknown as McpAppAiGguiStackItemMeta }
      : {}),
  };
}

function buildToolResultParams(bootstrap: unknown): unknown {
  return { _meta: metaToMcpAppMeta(flatToMeta(bootstrap)) };
}

/**
 * Set the post-#109 global shape — a slice envelope keyed by
 * `ai.ggui/session` + `ai.ggui/stack-item`. Identical wire shape to
 * `_meta` so the runtime's `parseMetaFromGlobal` can reuse the
 * shared combiner.
 */
function setGlobalFromFlat(flat: unknown): void {
  (globalThis as unknown as { __GGUI_META__?: unknown })
    .__GGUI_META__ = metaToMcpAppMeta(flatToMeta(flat));
}

describe('extractMetaFromToolResult — Slice 3 codeUrl', () => {
  it('accepts a bootstrap with codeUrl alone (Slice 3 preferred path)', () => {
    const result = extractMetaFromToolResult(
      buildToolResultParams({
        sessionId: 's1',
        appId: 'a1',
        runtimeUrl: SAMPLE_RUNTIME_URL,
        codeUrl: SAMPLE_CODE_URL,
      }),
    );
    expect(result).not.toBeNull();
    if (result === null || result.stackItem?.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect(result.stackItem?.codeUrl).toBe(SAMPLE_CODE_URL);
  });

  // The inline `componentCode` channel was retired 2026-05-13 (T3-1).
  // Static-component bootstraps are now `codeUrl`-only; the parser
  // ignores any stray `componentCode` field and never surfaces it.

  it('returns null when codeUrl is not present', () => {
    expect(
      extractMetaFromToolResult(
        buildToolResultParams({ sessionId: 's1', appId: 'a1' }),
      ),
    ).toBeNull();
  });

  it('returns null when codeUrl is empty string', () => {
    expect(
      extractMetaFromToolResult(
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
      extractMetaFromToolResult(
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
      extractMetaFromToolResult(
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
    const result = extractMetaFromToolResult(
      buildToolResultParams({
        sessionId: 's1',
        appId: 'a1',
        runtimeUrl: SAMPLE_RUNTIME_URL,
        kind: 'connect-claude',
      }),
    );
    expect(result).not.toBeNull();
    if (result === null || result.stackItem?.kind === undefined) {
      throw new Error('expected system variant');
    }
    expect(result.stackItem.kind).toBe('connect-claude');
  });
});

describe('readSelfContainedMeta — Slice 3 codeUrl on window global', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { __GGUI_META__?: unknown })
      .__GGUI_META__;
  });

  afterEach(() => {
    delete (globalThis as unknown as { __GGUI_META__?: unknown })
      .__GGUI_META__;
  });

  it('reads codeUrl from window.__GGUI_META__', () => {
    setGlobalFromFlat({
      sessionId: 's1',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
    });
    const bs = readSelfContainedMeta();
    expect(bs).not.toBeNull();
    if (bs === null || bs.stackItem?.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect(bs.stackItem?.codeUrl).toBe(SAMPLE_CODE_URL);
  });

  it('returns null when codeUrl is absent', () => {
    setGlobalFromFlat({
      sessionId: 's1',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
    });
    expect(readSelfContainedMeta()).toBeNull();
  });

  it('passes themeMode through when set to "dark"', () => {
    setGlobalFromFlat({
      sessionId: 's1',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      themeId: 'claudic',
      themeMode: 'dark',
    });
    const bs = readSelfContainedMeta();
    expect(bs).not.toBeNull();
    if (bs === null || bs.stackItem?.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect(bs.session.themeId).toBe('claudic');
    expect(bs.session.themeMode).toBe('dark');
  });

  it('passes themeMode through for system-card variant', () => {
    setGlobalFromFlat({
      sessionId: 's1',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      kind: 'no-credentials',
      themeId: 'claudic',
      themeMode: 'dark',
    });
    const bs = readSelfContainedMeta();
    expect(bs).not.toBeNull();
    if (bs === null || bs.stackItem?.kind === undefined) {
      throw new Error('expected system variant');
    }
    expect(bs.session.themeMode).toBe('dark');
  });

  it('drops malformed themeMode silently (falls back to undefined)', () => {
    setGlobalFromFlat({
      sessionId: 's1',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      themeMode: 'twilight', // not in the closed 'light' | 'dark' set
    });
    const bs = readSelfContainedMeta();
    expect(bs).not.toBeNull();
    if (bs === null || bs.stackItem?.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect(bs.session.themeMode).toBeUndefined();
  });

  it('omits themeMode when absent from bootstrap', () => {
    setGlobalFromFlat({
      sessionId: 's1',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
    });
    const bs = readSelfContainedMeta();
    expect(bs).not.toBeNull();
    if (bs === null || bs.stackItem?.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect(bs.session.themeMode).toBeUndefined();
  });
});

// Type-level lock: `codeUrl` is the sole static-component discriminator
// (T3-1 2026-05-13 retired the inline `componentCode` channel).
describe('SelfContainedMcpAppAiGguiMeta typing', () => {
  it('allows constructing a component variant with codeUrl', () => {
    const bs: SelfContainedMcpAppAiGguiMeta = {
      session: {
        sessionId: 's1',
        appId: 'a1',
        runtimeUrl: SAMPLE_RUNTIME_URL,
      },
      stackItem: {
        codeUrl: SAMPLE_CODE_URL,
      },
    };
    expect(bs.stackItem?.codeUrl).toBe(SAMPLE_CODE_URL);
  });
});
