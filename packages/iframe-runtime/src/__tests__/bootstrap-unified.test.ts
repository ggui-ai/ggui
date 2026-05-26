/**
 * Slice 14 (2026-05-08) — envelope-equivalence + per-mode validation
 * for the unified slice-meta parser.
 *
 * The runtime now extracts a single {@link McpAppAiGguiMeta} from
 * three envelope shapes via three thin wrappers
 * ({@link parseMetaFromUiInitialize},
 * {@link parseMetaFromGlobal},
 * {@link parseMetaFromToolResult}) that all delegate to the
 * shared {@link validateMeta} core. This suite exercises:
 *
 *   1. **Envelope equivalence** — given the same raw slice-meta object,
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
 * @see packages/iframe-runtime/src/meta-parse.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  metaToMcpAppMeta,
  type McpAppAiGguiMeta,
  type McpAppAiGguiSessionMeta,
  type McpAppAiGguiStackItemMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  parseBootstrap,
  parseMetaFromGlobal,
  parseMetaFromToolResult,
  parseMetaFromUiInitialize,
  validateMeta,
} from '../meta-parse.js';

const FUTURE_ISO = '2099-01-01T00:00:00.000Z';
const RUNTIME_URL = '/_ggui/iframe-runtime.js';

/** See {@link meta-parse.test.ts#SESSION_FIELDS} for the field-list rationale. */
const SESSION_FIELDS = new Set<string>([
  'sessionId', 'appId', 'runtimeUrl', 'wsUrl', 'wsToken', 'expiresAt',
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
  wsToken: 'tok_abc',
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
      _meta: metaToMcpAppMeta(flatToMeta(bootstrap)),
      structuredContent: { sessionId: 'sess_001' },
    },
  };
}

function wrapToolResult(bootstrap: unknown): unknown {
  return { _meta: metaToMcpAppMeta(flatToMeta(bootstrap)) };
}

/**
 * Set `__GGUI_META__` to the slice envelope shape (post-#109 —
 * matches the wire `_meta` keys).
 */
function setGlobal(bootstrap: unknown): void {
  (globalThis as unknown as { __GGUI_META__?: unknown })
    .__GGUI_META__ = metaToMcpAppMeta(flatToMeta(bootstrap));
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
    const fromHost = parseMetaFromUiInitialize(
      wrapUiInitialize(componentBootstrap),
    );
    const fromTool = parseMetaFromToolResult(
      wrapToolResult(componentBootstrap),
    );
    expect(fromGlobal).toEqual(fromHost);
    expect(fromGlobal).toEqual(fromTool);
    expect(fromGlobal.ok).toBe(true);
    if (fromGlobal.ok) {
      expect(fromGlobal.meta.stackItem?.codeUrl).toBe(
        componentBootstrap.codeUrl,
      );
      expect(fromGlobal.meta.session.runtimeUrl).toBe(RUNTIME_URL);
      expect(fromGlobal.meta.stackItem?.contextSlots).toHaveLength(1);
    }
  });

  it('live-mode bootstrap parses identically through every extractor', () => {
    setGlobal(liveBootstrap);
    const fromGlobal = parseMetaFromGlobal();
    const fromHost = parseMetaFromUiInitialize(
      wrapUiInitialize(liveBootstrap),
    );
    const fromTool = parseMetaFromToolResult(wrapToolResult(liveBootstrap));
    expect(fromGlobal).toEqual(fromHost);
    expect(fromGlobal).toEqual(fromTool);
  });

  it('system-card bootstrap parses identically through every extractor', () => {
    setGlobal(systemBootstrap);
    const fromGlobal = parseMetaFromGlobal();
    const fromHost = parseMetaFromUiInitialize(
      wrapUiInitialize(systemBootstrap),
    );
    const fromTool = parseMetaFromToolResult(
      wrapToolResult(systemBootstrap),
    );
    expect(fromGlobal).toEqual(fromHost);
    expect(fromGlobal).toEqual(fromTool);
    expect(fromGlobal.ok).toBe(true);
    if (fromGlobal.ok) {
      expect(fromGlobal.meta.stackItem?.kind).toBe('no-credentials');
    }
  });

  it('parseBootstrap (back-compat alias) === parseMetaFromUiInitialize', () => {
    expect(parseBootstrap).toBe(parseMetaFromUiInitialize);
  });
});

describe('Slice 14 — per-mode validation', () => {
  it('accepts live mode (wsUrl + token + runtimeUrl)', () => {
    const result = validateMeta(flatToMeta(liveBootstrap));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.wsUrl).toBe('wss://server.example/ws');
      expect(result.meta.session.wsToken).toBe('tok_abc');
    }
  });

  it('accepts static-component mode (codeUrl + runtimeUrl, no WS)', () => {
    const result = validateMeta(flatToMeta(componentBootstrap));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.wsUrl).toBeUndefined();
      expect(result.meta.session.wsToken).toBeUndefined();
      expect(result.meta.stackItem?.codeUrl).toBe(
        componentBootstrap.codeUrl,
      );
    }
  });

  it('accepts system-card mode (kind + runtimeUrl, no WS, no code)', () => {
    const result = validateMeta(flatToMeta(systemBootstrap));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.wsUrl).toBeUndefined();
      expect(result.meta.stackItem?.codeUrl).toBeUndefined();
      expect(result.meta.stackItem?.kind).toBe('no-credentials');
    }
  });

  it('rejects no-discriminator (only sessionId/appId/runtimeUrl)', () => {
    expect(
      validateMeta(flatToMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        runtimeUrl: RUNTIME_URL,
      })),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects half-live (wsUrl without token)', () => {
    expect(
      validateMeta(flatToMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        runtimeUrl: RUNTIME_URL,
        wsUrl: 'wss://server.example/ws',
        // token deliberately omitted
      })),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects half-live (token without wsUrl)', () => {
    expect(
      validateMeta(flatToMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        runtimeUrl: RUNTIME_URL,
        wsToken: 'tok_abc',
      })),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects missing runtimeUrl on live mode', () => {
    expect(
      validateMeta(flatToMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        wsUrl: 'wss://server.example/ws',
        wsToken: 'tok_abc',
      })),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects missing runtimeUrl on static-component mode', () => {
    expect(
      validateMeta(flatToMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        codeUrl: 'https://example.com/code/abc.js',
      })),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects missing runtimeUrl on system-card mode', () => {
    expect(
      validateMeta(flatToMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        kind: 'no-credentials',
      })),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects empty-string discriminator (wsUrl: "" + wsToken: "")', () => {
    expect(
      validateMeta(flatToMeta({
        sessionId: 'sess_001',
        appId: 'app_001',
        runtimeUrl: RUNTIME_URL,
        wsUrl: '',
        wsToken: '',
      })),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects expired live-mode bootstrap', () => {
    expect(
      validateMeta(flatToMeta({
        ...liveBootstrap,
        expiresAt: '2000-01-01T00:00:00.000Z',
      })),
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
      expect(result.meta.stackItem?.contextSlots).toEqual(
        componentBootstrap.contextSlots,
      );
    }
  });

  it('preserves appCallableTools through every extractor', () => {
    setGlobal(componentBootstrap);
    const fromGlobal = parseMetaFromGlobal();
    const fromHost = parseMetaFromUiInitialize(
      wrapUiInitialize(componentBootstrap),
    );
    const fromTool = parseMetaFromToolResult(
      wrapToolResult(componentBootstrap),
    );
    expect(fromGlobal.ok && fromGlobal.meta.session.appCallableTools).toEqual([
      'ggui_runtime_submit_action',
      'foo_tool',
    ]);
    expect(fromHost.ok && fromHost.meta.session.appCallableTools).toEqual([
      'ggui_runtime_submit_action',
      'foo_tool',
    ]);
    expect(fromTool.ok && fromTool.meta.session.appCallableTools).toEqual([
      'ggui_runtime_submit_action',
      'foo_tool',
    ]);
  });

  it('preserves actionNextSteps through every extractor', () => {
    setGlobal(componentBootstrap);
    const fromGlobal = parseMetaFromGlobal();
    const fromHost = parseMetaFromUiInitialize(
      wrapUiInitialize(componentBootstrap),
    );
    const fromTool = parseMetaFromToolResult(
      wrapToolResult(componentBootstrap),
    );
    expect(fromGlobal.ok && fromGlobal.meta.stackItem?.actionNextSteps).toEqual({
      archive: 'gmail_archive',
    });
    expect(fromHost.ok && fromHost.meta.stackItem?.actionNextSteps).toEqual({
      archive: 'gmail_archive',
    });
    expect(fromTool.ok && fromTool.meta.stackItem?.actionNextSteps).toEqual({
      archive: 'gmail_archive',
    });
  });

  it('preserves canvasMode through every extractor', () => {
    const canvasBootstrap = { ...liveBootstrap, canvasMode: true };
    setGlobal(canvasBootstrap);
    const fromGlobal = parseMetaFromGlobal();
    const fromHost = parseMetaFromUiInitialize(
      wrapUiInitialize(canvasBootstrap),
    );
    const fromTool = parseMetaFromToolResult(
      wrapToolResult(canvasBootstrap),
    );
    expect(fromGlobal.ok && fromGlobal.meta.session.canvasMode).toBe(true);
    expect(fromHost.ok && fromHost.meta.session.canvasMode).toBe(true);
    expect(fromTool.ok && fromTool.meta.session.canvasMode).toBe(true);
  });

  it('drops non-boolean canvasMode values (defensive parse)', () => {
    for (const bogus of ['true', 1, {}, [], null]) {
      const result = validateMeta(flatToMeta({
        ...liveBootstrap,
        canvasMode: bogus,
      }));
      expect(result.ok && result.meta.session.canvasMode).toBeUndefined();
    }
  });

  it('omits canvasMode when absent', () => {
    const result = validateMeta(flatToMeta(liveBootstrap));
    expect(result.ok && result.meta.session.canvasMode).toBeUndefined();
  });
});
