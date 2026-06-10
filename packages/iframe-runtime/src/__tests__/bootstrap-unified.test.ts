/**
 * Slice 14 (2026-05-08) — envelope-equivalence + per-mode validation
 * for the unified slice-meta parser.
 *
 * The runtime extracts a single {@link McpAppAiGguiRenderMeta} from
 * two envelope shapes via two thin wrappers
 * ({@link parseMetaFromGlobal},
 * {@link parseMetaFromToolResult}) that both delegate to the
 * shared {@link validateMeta} core. This suite exercises:
 *
 *   1. **Envelope equivalence** — given the same raw slice-meta object,
 *      BOTH wrappers MUST produce the same parsed output. The DRY
 *      split is meaningless if the wrappers diverge.
 *   2. **Per-mode validation** — live / static-component / system-card
 *      each accept their canonical shape and reject every deformation
 *      enumerated in the validator's contract (no discriminator,
 *      half-live, missing runtimeUrl).
 *   3. **Optional-field preservation** — `contextSlots` round-trips
 *      identically through every wrapper.
 *
 * Post-Phase-B (2026-05-27): the wire merged the previous two-slice
 * envelope (`ai.ggui/session` + `ai.ggui/stack-item`) into a single
 * `ai.ggui/render` slice. Every field flat on `McpAppAiGguiRenderMeta`.
 *
 * Post-Phase-1.19b.3 (2026-05-28): the `ui/initialize` Reading-B
 * extractor (`parseMetaFromUiInitialize`) was retired — App.connect
 * does not expose `result.toolOutput`, so every slice-meta delivery
 * flows through inline `__GGUI_META__` or the spec-canonical
 * `ui/notifications/tool-result` postMessage.
 *
 * @see packages/iframe-runtime/src/meta-parse.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  toMcpAppEnvelope,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  parseMetaFromGlobal,
  parseMetaFromToolResult,
  validateMeta,
} from '../meta-parse.js';

const FUTURE_ISO = '2099-01-01T00:00:00.000Z';
const RUNTIME_URL = '/_ggui/iframe-runtime.js';

const componentBootstrap: McpAppAiGguiRenderMeta = {
  sessionId: 'render_001',
  appId: 'app_001',
  runtimeUrl: RUNTIME_URL,
  codeUrl: 'https://example.com/code/sha256-abc.js',
  codeHash: 'sha256-abc',
  themeId: 'indigo',
  themeMode: 'light' as const,
  propsJson: '{"name":"Ada"}',
  contextSlots: [
    {
      name: 'currentStep',
      contextName: 'CurrentStepContext',
      schema: { type: 'number' },
      default: 0,
    },
  ],
};

const liveBootstrap: McpAppAiGguiRenderMeta = {
  sessionId: 'render_001',
  appId: 'app_001',
  runtimeUrl: RUNTIME_URL,
  wsUrl: 'wss://server.example/ws',
  wsToken: 'tok_abc',
  expiresAt: FUTURE_ISO,
};

const systemBootstrap: McpAppAiGguiRenderMeta = {
  sessionId: 'render_001',
  appId: 'app_001',
  runtimeUrl: RUNTIME_URL,
  kind: 'no-credentials',
  themeId: 'indigo',
};

function wrapToolResult(meta: McpAppAiGguiRenderMeta): unknown {
  return { _meta: toMcpAppEnvelope(meta) };
}

/**
 * Set `__GGUI_META__` to the slice envelope shape (matches the wire
 * `_meta` key).
 */
function setGlobal(meta: McpAppAiGguiRenderMeta): void {
  (globalThis as unknown as { __GGUI_META__?: unknown })
    .__GGUI_META__ = toMcpAppEnvelope(meta);
}

describe('Slice 14 — envelope equivalence', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { __GGUI_META__?: unknown })
      .__GGUI_META__;
  });

  afterEach(() => {
    delete (globalThis as unknown as { __GGUI_META__?: unknown })
      .__GGUI_META__;
  });

  it('static-component bootstrap parses identically through every extractor', () => {
    setGlobal(componentBootstrap);
    const fromGlobal = parseMetaFromGlobal();
    const fromTool = parseMetaFromToolResult(
      wrapToolResult(componentBootstrap),
    );
    expect(fromGlobal).toEqual(fromTool);
    expect(fromGlobal.ok).toBe(true);
    if (fromGlobal.ok) {
      expect(fromGlobal.meta.codeUrl).toBe(componentBootstrap.codeUrl);
      expect(fromGlobal.meta.runtimeUrl).toBe(RUNTIME_URL);
      expect(fromGlobal.meta.contextSlots).toHaveLength(1);
    }
  });

  it('live-mode bootstrap parses identically through every extractor', () => {
    setGlobal(liveBootstrap);
    const fromGlobal = parseMetaFromGlobal();
    const fromTool = parseMetaFromToolResult(wrapToolResult(liveBootstrap));
    expect(fromGlobal).toEqual(fromTool);
  });

  it('system-card bootstrap parses identically through every extractor', () => {
    setGlobal(systemBootstrap);
    const fromGlobal = parseMetaFromGlobal();
    const fromTool = parseMetaFromToolResult(
      wrapToolResult(systemBootstrap),
    );
    expect(fromGlobal).toEqual(fromTool);
    expect(fromGlobal.ok).toBe(true);
    if (fromGlobal.ok) {
      expect(fromGlobal.meta.kind).toBe('no-credentials');
    }
  });
});

describe('Slice 14 — per-mode validation', () => {
  it('accepts live mode (wsUrl + token + runtimeUrl)', () => {
    const result = validateMeta(liveBootstrap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.wsUrl).toBe('wss://server.example/ws');
      expect(result.meta.wsToken).toBe('tok_abc');
    }
  });

  it('accepts static-component mode (codeUrl + runtimeUrl, no WS)', () => {
    const result = validateMeta(componentBootstrap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.wsUrl).toBeUndefined();
      expect(result.meta.wsToken).toBeUndefined();
      expect(result.meta.codeUrl).toBe(componentBootstrap.codeUrl);
    }
  });

  it('accepts system-card mode (kind + runtimeUrl, no WS, no code)', () => {
    const result = validateMeta(systemBootstrap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.wsUrl).toBeUndefined();
      expect(result.meta.codeUrl).toBeUndefined();
      expect(result.meta.kind).toBe('no-credentials');
    }
  });

  it('rejects no-discriminator (only sessionId/appId/runtimeUrl)', () => {
    expect(
      validateMeta({
        sessionId: 'render_001',
        appId: 'app_001',
        runtimeUrl: RUNTIME_URL,
      }),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects missing runtimeUrl on live mode', () => {
    expect(
      validateMeta({
        sessionId: 'render_001',
        appId: 'app_001',
        wsUrl: 'wss://server.example/ws',
        wsToken: 'tok_abc',
        runtimeUrl: '',
      }),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects empty-string discriminator (wsUrl: "" + wsToken: "")', () => {
    expect(
      validateMeta({
        sessionId: 'render_001',
        appId: 'app_001',
        runtimeUrl: RUNTIME_URL,
        wsUrl: '',
        wsToken: '',
      }),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects expired live-mode bootstrap', () => {
    expect(
      validateMeta({
        ...liveBootstrap,
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
    ).toEqual({ ok: false, reason: 'EXPIRED_BOOTSTRAP' });
  });
});

describe('Slice 14 — optional-field round-trip', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { __GGUI_META__?: unknown })
      .__GGUI_META__;
  });

  afterEach(() => {
    delete (globalThis as unknown as { __GGUI_META__?: unknown })
      .__GGUI_META__;
  });

  it('preserves contextSlots through the global extractor', () => {
    setGlobal(componentBootstrap);
    const result = parseMetaFromGlobal();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.contextSlots).toEqual(
        componentBootstrap.contextSlots,
      );
    }
  });

});
