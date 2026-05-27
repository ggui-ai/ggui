/**
 * Iframe runtime accepts content-addressable codeUrl on the bootstrap
 * envelope (the sole static-component delivery channel post-T3-1
 * 2026-05-13) and stays compatible with system cards + the existing
 * Path B (`_meta` postMessage) extraction.
 *
 * Post-Phase-B (2026-05-27): the wire merged the two-slice envelope
 * into a single `ai.ggui/render` slice. Fixtures construct
 * `McpAppAiGguiRenderMeta` directly and the parser surfaces it on
 * `result` (flat — no `session` / `stackItem` nesting).
 *
 * These cover the parser narrowing only — the actual fetch + mount
 * path is exercised end-to-end against a real iframe in higher-tier
 * specs.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  toMcpAppEnvelope,
  type McpAppAiGguiRenderMeta,
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

function buildToolResultParams(meta: McpAppAiGguiRenderMeta): unknown {
  return { _meta: toMcpAppEnvelope(meta) };
}

/**
 * Set the global to a slice envelope keyed by `ai.ggui/render`. The
 * runtime's `parseMetaFromGlobal` reuses the shared combiner so this
 * matches the wire `_meta` shape verbatim.
 */
function setGlobal(meta: McpAppAiGguiRenderMeta): void {
  (globalThis as unknown as { __GGUI_META__?: unknown })
    .__GGUI_META__ = toMcpAppEnvelope(meta);
}

describe('extractMetaFromToolResult — Slice 3 codeUrl', () => {
  it('accepts a bootstrap with codeUrl alone (Slice 3 preferred path)', () => {
    const result = extractMetaFromToolResult(
      buildToolResultParams({
        renderId: 'render_001',
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
    // Missing mode discriminator (no codeUrl, no kind, no wsUrl+token)
    // → MALFORMED_BOOTSTRAP from validateMeta; extractor returns null.
    expect(
      extractMetaFromToolResult(
        buildToolResultParams({
          renderId: 'render_001',
          appId: 'a1',
          runtimeUrl: SAMPLE_RUNTIME_URL,
        }),
      ),
    ).toBeNull();
  });

  it('returns null when codeUrl is empty string', () => {
    expect(
      extractMetaFromToolResult(
        buildToolResultParams({
          renderId: 'render_001',
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
          renderId: 'render_001',
          appId: 'a1',
          runtimeUrl: SAMPLE_RUNTIME_URL,
          // TS-allowed in the fixture; runtime parser rejects per
          // structural validation.
          codeUrl: 42 as unknown as string,
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
          renderId: 'render_001',
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
        renderId: 'render_001',
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
    setGlobal({
      renderId: 'render_001',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
    });
    const bs = readSelfContainedMeta();
    expect(bs).not.toBeNull();
    if (bs === null || bs.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect(bs.codeUrl).toBe(SAMPLE_CODE_URL);
  });

  it('returns null when codeUrl is absent (no mode discriminator)', () => {
    setGlobal({
      renderId: 'render_001',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
    });
    expect(readSelfContainedMeta()).toBeNull();
  });

  it('passes themeMode through when set to "dark"', () => {
    setGlobal({
      renderId: 'render_001',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      themeId: 'claudic',
      themeMode: 'dark',
    });
    const bs = readSelfContainedMeta();
    expect(bs).not.toBeNull();
    if (bs === null || bs.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect(bs.themeId).toBe('claudic');
    expect(bs.themeMode).toBe('dark');
  });

  it('passes themeMode through for system-card variant', () => {
    setGlobal({
      renderId: 'render_001',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      kind: 'no-credentials',
      themeId: 'claudic',
      themeMode: 'dark',
    });
    const bs = readSelfContainedMeta();
    expect(bs).not.toBeNull();
    if (bs === null || bs.kind === undefined) {
      throw new Error('expected system variant');
    }
    expect(bs.themeMode).toBe('dark');
  });

  it('drops malformed themeMode silently (falls back to undefined)', () => {
    setGlobal({
      renderId: 'render_001',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      // not in the closed 'light' | 'dark' set
      themeMode: 'twilight' as unknown as 'light' | 'dark',
    });
    const bs = readSelfContainedMeta();
    expect(bs).not.toBeNull();
    if (bs === null || bs.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect(bs.themeMode).toBeUndefined();
  });

  it('omits themeMode when absent from bootstrap', () => {
    setGlobal({
      renderId: 'render_001',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
    });
    const bs = readSelfContainedMeta();
    expect(bs).not.toBeNull();
    if (bs === null || bs.kind !== undefined) {
      throw new Error('expected component variant');
    }
    expect(bs.themeMode).toBeUndefined();
  });
});

// Type-level lock: `codeUrl` is the sole static-component discriminator
// (T3-1 2026-05-13 retired the inline `componentCode` channel).
describe('SelfContainedMcpAppAiGguiMeta typing', () => {
  it('allows constructing a component variant with codeUrl', () => {
    const bs: SelfContainedMcpAppAiGguiMeta = {
      renderId: 'render_001',
      appId: 'a1',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
    };
    expect(bs.codeUrl).toBe(SAMPLE_CODE_URL);
  });
});
