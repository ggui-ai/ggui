/**
 * Slice 14 (2026-05-08) — envelope-equivalence + per-mode validation
 * for the unified bootstrap parser.
 *
 * The runtime now extracts a single {@link McpAppAiGguiMountView} from
 * three envelope shapes via three thin wrappers
 * ({@link parseBootstrapFromUiInitialize},
 * {@link parseBootstrapFromGlobal},
 * {@link parseBootstrapFromToolResult}) that all delegate to the
 * shared {@link validateBootstrapMeta} core. This suite exercises:
 *
 *   1. **Envelope equivalence** — given the same raw bootstrap object,
 *      ALL three wrappers MUST produce the same parsed output. The
 *      DRY split is meaningless if the wrappers diverge.
 *   2. **Per-mode validation** — live / static-component / system-card
 *      each accept their canonical shape and reject every deformation
 *      enumerated in the validator's contract (no discriminator,
 *      half-live, missing runtimeUrl).
 *   3. **Optional-field preservation** — `contextSlots`,
 *      `appCallableTools`, `actionNextSteps` round-trip identically
 *      through every wrapper.
 *
 * @see packages/iframe-runtime/src/bootstrap.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mountViewToMcpAppMeta,
  type McpAppAiGguiMountView,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  parseBootstrap,
  parseBootstrapFromGlobal,
  parseBootstrapFromToolResult,
  parseBootstrapFromUiInitialize,
  validateBootstrapMeta,
} from '../bootstrap.js';

const FUTURE_ISO = '2099-01-01T00:00:00.000Z';
const RUNTIME_URL = '/_ggui/iframe-runtime.js';

const componentBootstrap = {
  sessionId: 'sess_001',
  appId: 'app_001',
  runtimeUrl: RUNTIME_URL,
  codeUrl: 'https://example.com/code/sha256-abc.js',
  codeHash: 'sha256-abc',
  themeId: 'indigo',
  themeMode: 'light' as const,
  propsJson: '{"name":"Ada"}',
  appCallableTools: ['ggui_runtime_submit_action', 'foo_tool'],
  actionNextSteps: { archive: 'gmail_archive' },
  contextSlots: [
    {
      name: 'currentStep',
      contextName: 'CurrentStepContext',
      schema: { type: 'number' },
      default: 0,
    },
  ],
};

const liveBootstrap = {
  sessionId: 'sess_001',
  appId: 'app_001',
  runtimeUrl: RUNTIME_URL,
  wsUrl: 'wss://server.example/ws',
  token: 'tok_abc',
  expiresAt: FUTURE_ISO,
};

const systemBootstrap = {
  sessionId: 'sess_001',
  appId: 'app_001',
  runtimeUrl: RUNTIME_URL,
  kind: 'no-credentials',
  themeId: 'indigo',
};

function wrapUiInitialize(bootstrap: unknown): unknown {
  return {
    toolOutput: {
      _meta: mountViewToMcpAppMeta(bootstrap as McpAppAiGguiMountView),
      structuredContent: { sessionId: 'sess_001' },
    },
  };
}

function wrapToolResult(bootstrap: unknown): unknown {
  return { _meta: mountViewToMcpAppMeta(bootstrap as McpAppAiGguiMountView) };
}

function setGlobal(bootstrap: unknown): void {
  (globalThis as unknown as { __GGUI_BOOTSTRAP__?: unknown })
    .__GGUI_BOOTSTRAP__ = bootstrap;
}

describe('Slice 14 — envelope equivalence', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { __GGUI_BOOTSTRAP__?: unknown })
      .__GGUI_BOOTSTRAP__;
  });

  afterEach(() => {
    delete (globalThis as unknown as { __GGUI_BOOTSTRAP__?: unknown })
      .__GGUI_BOOTSTRAP__;
  });

  it('static-component bootstrap parses identically through every extractor', () => {
    setGlobal(componentBootstrap);
    const fromGlobal = parseBootstrapFromGlobal();
    const fromHost = parseBootstrapFromUiInitialize(
      wrapUiInitialize(componentBootstrap),
    );
    const fromTool = parseBootstrapFromToolResult(
      wrapToolResult(componentBootstrap),
    );
    expect(fromGlobal).toEqual(fromHost);
    expect(fromGlobal).toEqual(fromTool);
    expect(fromGlobal.ok).toBe(true);
    if (fromGlobal.ok) {
      expect(fromGlobal.bootstrap.codeUrl).toBe(
        componentBootstrap.codeUrl,
      );
      expect(fromGlobal.bootstrap.runtimeUrl).toBe(RUNTIME_URL);
      expect(fromGlobal.bootstrap.contextSlots).toHaveLength(1);
    }
  });

  it('live-mode bootstrap parses identically through every extractor', () => {
    setGlobal(liveBootstrap);
    const fromGlobal = parseBootstrapFromGlobal();
    const fromHost = parseBootstrapFromUiInitialize(
      wrapUiInitialize(liveBootstrap),
    );
    const fromTool = parseBootstrapFromToolResult(wrapToolResult(liveBootstrap));
    expect(fromGlobal).toEqual(fromHost);
    expect(fromGlobal).toEqual(fromTool);
  });

  it('system-card bootstrap parses identically through every extractor', () => {
    setGlobal(systemBootstrap);
    const fromGlobal = parseBootstrapFromGlobal();
    const fromHost = parseBootstrapFromUiInitialize(
      wrapUiInitialize(systemBootstrap),
    );
    const fromTool = parseBootstrapFromToolResult(
      wrapToolResult(systemBootstrap),
    );
    expect(fromGlobal).toEqual(fromHost);
    expect(fromGlobal).toEqual(fromTool);
    expect(fromGlobal.ok).toBe(true);
    if (fromGlobal.ok) {
      expect(fromGlobal.bootstrap.kind).toBe('no-credentials');
    }
  });

  it('parseBootstrap (back-compat alias) === parseBootstrapFromUiInitialize', () => {
    expect(parseBootstrap).toBe(parseBootstrapFromUiInitialize);
  });
});

describe('Slice 14 — per-mode validation', () => {
  it('accepts live mode (wsUrl + token + runtimeUrl)', () => {
    const result = validateBootstrapMeta(liveBootstrap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bootstrap.wsUrl).toBe('wss://server.example/ws');
      expect(result.bootstrap.token).toBe('tok_abc');
    }
  });

  it('accepts static-component mode (codeUrl + runtimeUrl, no WS)', () => {
    const result = validateBootstrapMeta(componentBootstrap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bootstrap.wsUrl).toBeUndefined();
      expect(result.bootstrap.token).toBeUndefined();
      expect(result.bootstrap.codeUrl).toBe(
        componentBootstrap.codeUrl,
      );
    }
  });

  it('accepts system-card mode (kind + runtimeUrl, no WS, no code)', () => {
    const result = validateBootstrapMeta(systemBootstrap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bootstrap.wsUrl).toBeUndefined();
      expect(result.bootstrap.codeUrl).toBeUndefined();
      expect(result.bootstrap.kind).toBe('no-credentials');
    }
  });

  it('rejects no-discriminator (only sessionId/appId/runtimeUrl)', () => {
    expect(
      validateBootstrapMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        runtimeUrl: RUNTIME_URL,
      }),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects half-live (wsUrl without token)', () => {
    expect(
      validateBootstrapMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        runtimeUrl: RUNTIME_URL,
        wsUrl: 'wss://server.example/ws',
        // token deliberately omitted
      }),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects half-live (token without wsUrl)', () => {
    expect(
      validateBootstrapMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        runtimeUrl: RUNTIME_URL,
        token: 'tok_abc',
      }),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects missing runtimeUrl on live mode', () => {
    expect(
      validateBootstrapMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        wsUrl: 'wss://server.example/ws',
        token: 'tok_abc',
      }),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects missing runtimeUrl on static-component mode', () => {
    expect(
      validateBootstrapMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        codeUrl: 'https://example.com/code/abc.js',
      }),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects missing runtimeUrl on system-card mode', () => {
    expect(
      validateBootstrapMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        kind: 'no-credentials',
      }),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects empty-string discriminator (wsUrl: "" + token: "")', () => {
    expect(
      validateBootstrapMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        runtimeUrl: RUNTIME_URL,
        wsUrl: '',
        token: '',
      }),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects expired live-mode bootstrap', () => {
    expect(
      validateBootstrapMeta({
        ...liveBootstrap,
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
    ).toEqual({ ok: false, reason: 'EXPIRED_BOOTSTRAP' });
  });
});

describe('Slice 14 — optional-field round-trip', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { __GGUI_BOOTSTRAP__?: unknown })
      .__GGUI_BOOTSTRAP__;
  });

  afterEach(() => {
    delete (globalThis as unknown as { __GGUI_BOOTSTRAP__?: unknown })
      .__GGUI_BOOTSTRAP__;
  });

  it('preserves contextSlots through the global extractor', () => {
    setGlobal(componentBootstrap);
    const result = parseBootstrapFromGlobal();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bootstrap.contextSlots).toEqual(
        componentBootstrap.contextSlots,
      );
    }
  });

  it('preserves appCallableTools through every extractor', () => {
    setGlobal(componentBootstrap);
    const fromGlobal = parseBootstrapFromGlobal();
    const fromHost = parseBootstrapFromUiInitialize(
      wrapUiInitialize(componentBootstrap),
    );
    const fromTool = parseBootstrapFromToolResult(
      wrapToolResult(componentBootstrap),
    );
    expect(fromGlobal.ok && fromGlobal.bootstrap.appCallableTools).toEqual([
      'ggui_runtime_submit_action',
      'foo_tool',
    ]);
    expect(fromHost.ok && fromHost.bootstrap.appCallableTools).toEqual([
      'ggui_runtime_submit_action',
      'foo_tool',
    ]);
    expect(fromTool.ok && fromTool.bootstrap.appCallableTools).toEqual([
      'ggui_runtime_submit_action',
      'foo_tool',
    ]);
  });

  it('preserves actionNextSteps through every extractor', () => {
    setGlobal(componentBootstrap);
    const fromGlobal = parseBootstrapFromGlobal();
    const fromHost = parseBootstrapFromUiInitialize(
      wrapUiInitialize(componentBootstrap),
    );
    const fromTool = parseBootstrapFromToolResult(
      wrapToolResult(componentBootstrap),
    );
    expect(fromGlobal.ok && fromGlobal.bootstrap.actionNextSteps).toEqual({
      archive: 'gmail_archive',
    });
    expect(fromHost.ok && fromHost.bootstrap.actionNextSteps).toEqual({
      archive: 'gmail_archive',
    });
    expect(fromTool.ok && fromTool.bootstrap.actionNextSteps).toEqual({
      archive: 'gmail_archive',
    });
  });

  it('preserves canvasMode through every extractor', () => {
    const canvasBootstrap = { ...liveBootstrap, canvasMode: true };
    setGlobal(canvasBootstrap);
    const fromGlobal = parseBootstrapFromGlobal();
    const fromHost = parseBootstrapFromUiInitialize(
      wrapUiInitialize(canvasBootstrap),
    );
    const fromTool = parseBootstrapFromToolResult(
      wrapToolResult(canvasBootstrap),
    );
    expect(fromGlobal.ok && fromGlobal.bootstrap.canvasMode).toBe(true);
    expect(fromHost.ok && fromHost.bootstrap.canvasMode).toBe(true);
    expect(fromTool.ok && fromTool.bootstrap.canvasMode).toBe(true);
  });

  it('drops non-boolean canvasMode values (defensive parse)', () => {
    for (const bogus of ['true', 1, {}, [], null]) {
      const result = validateBootstrapMeta({
        ...liveBootstrap,
        canvasMode: bogus,
      });
      expect(result.ok && result.bootstrap.canvasMode).toBeUndefined();
    }
  });

  it('omits canvasMode when absent', () => {
    const result = validateBootstrapMeta(liveBootstrap);
    expect(result.ok && result.bootstrap.canvasMode).toBeUndefined();
  });
});
