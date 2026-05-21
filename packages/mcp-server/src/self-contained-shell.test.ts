/**
 * Slice 14 (2026-05-08) — `buildSelfContainedShell` injects the full
 * bootstrap envelope, not just `{sessionId, appId, componentCode|kind}`.
 *
 * Pre-Slice-14 the inline `__GGUI_BOOTSTRAP__` global only carried the
 * minimum to mount a compiled component on the postMessage shell path.
 * The self-contained `/r/<shortCode>` direct-preview path uses the
 * SAME global as its sole boot source — so anything the runtime needs
 * (`runtimeUrl` for the bundle URL, `contextSlots` for Provider seeds,
 * `appCallableTools` / `actionNextSteps` for dispatch routing) had to
 * be inlined too. Without these, contextSpec UIs blank-page'd at the
 * direct-preview URL because the runtime's bootstrap validator rejected
 * the envelope as MALFORMED.
 *
 * This suite locks the inline-bootstrap shape against the runtime's
 * validator: the HTML the shell emits MUST contain a JSON literal
 * that round-trips cleanly through the iframe-runtime's
 * {@link parseBootstrapFromGlobal} extractor.
 */
import { describe, expect, it } from 'vitest';
import { buildSelfContainedShell } from './mcp-apps-outbound.js';

/**
 * Pull the JSON literal out of the shell HTML's
 * `<script>window.__GGUI_BOOTSTRAP__ = {...};</script>` line.
 *
 * Mirrors what the browser would do: parse the JSON the server
 * stamped, modulo the HTML-escape de-mangling for `<` / `>` / `&` and
 * the JS line-terminator escapes (U+2028 / U+2029) the builder
 * applies. Replacement targets are simple printables so this file
 * itself stays free of irregular whitespace.
 */
function extractInlineBootstrap(html: string): Record<string, unknown> {
  const match = html.match(/window\.__GGUI_BOOTSTRAP__ = (.+?);<\/script>/);
  if (!match) {
    throw new Error('inline bootstrap not found in shell HTML');
  }
  const raw = match[1]
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u0026/g, '&')
    .replace(/\\u2028/g, '\\n')
    .replace(/\\u2029/g, '\\n');
  return JSON.parse(raw) as Record<string, unknown>;
}

const SAMPLE_RUNTIME_URL = '/_ggui/iframe-runtime.js';
const SAMPLE_CODE_URL =
  'https://example.com/code/sha256-abc123.js';
const SAMPLE_CODE_HASH = 'sha256-abc123';

describe('buildSelfContainedShell — Slice 14 inline-bootstrap shape', () => {
  it('inlines runtimeUrl into the bootstrap (closes the blank-page bug)', () => {
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
    });
    const bootstrap = extractInlineBootstrap(html);
    expect(bootstrap['runtimeUrl']).toBe(SAMPLE_RUNTIME_URL);
  });

  it('inlines contextSlots when supplied', () => {
    const slots = [
      {
        name: 'currentStep',
        contextName: 'CurrentStepContext',
        schema: { type: 'number' as const },
        default: 0,
      },
      {
        name: 'draftText',
        contextName: 'DraftTextContext',
        schema: { type: 'string' as const },
        default: '',
        debounceMs: 500,
      },
    ];
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      contextSlots: slots,
    });
    const bootstrap = extractInlineBootstrap(html);
    expect(bootstrap['contextSlots']).toEqual(slots);
  });

  it('inlines appCallableTools when supplied non-empty', () => {
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      appCallableTools: ['ggui_runtime_submit_action', 'gmail_archive'],
    });
    const bootstrap = extractInlineBootstrap(html);
    expect(bootstrap['appCallableTools']).toEqual([
      'ggui_runtime_submit_action',
      'gmail_archive',
    ]);
  });

  it('inlines actionNextSteps when supplied non-empty', () => {
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      actionNextSteps: { archive: 'gmail_archive' },
    });
    const bootstrap = extractInlineBootstrap(html);
    expect(bootstrap['actionNextSteps']).toEqual({ archive: 'gmail_archive' });
  });

  it('omits the new fields when supplied empty (legacy bootstrap byte-identical)', () => {
    // Empty arrays / records spread to "absent" so consumers see no
    // change vs the pre-Slice-14 envelope.
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      appCallableTools: [],
      actionNextSteps: {},
      contextSlots: [],
      gadgets: [],
      publicEnv: {},
    });
    const bootstrap = extractInlineBootstrap(html);
    expect('appCallableTools' in bootstrap).toBe(false);
    expect('actionNextSteps' in bootstrap).toBe(false);
    expect('contextSlots' in bootstrap).toBe(false);
    expect('gadgets' in bootstrap).toBe(false);
    expect('publicEnv' in bootstrap).toBe(false);
  });

  // Slice 1.3.3/2.2 audit fix — the self-contained shell MUST
  // forward `gadgets` (wrapper catalog) + `publicEnv` (env
  // values). Without these, /r/<shortCode> and resources/read paths
  // render as STDLIB-only iframes, regressing wrapper-using
  // contracts (Leaflet, Mapbox).
  it('inlines gadgets when supplied (GG.8.2 — per-package channel)', () => {
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      gadgets: [{ package: '@ggui-samples/gadget-leaflet' }],
    });
    const bootstrap = extractInlineBootstrap(html);
    expect(bootstrap['gadgets']).toEqual([
      { package: '@ggui-samples/gadget-leaflet' },
    ]);
  });

  it('inlines publicEnv when supplied (Slice 2.2 forward)', () => {
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      publicEnv: { GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...' },
    });
    const bootstrap = extractInlineBootstrap(html);
    expect(bootstrap['publicEnv']).toEqual({
      GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
    });
  });

  it('emits a bootstrap that the iframe-runtime validator accepts (component mode)', async () => {
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      contextSlots: [
        {
          name: 'currentStep',
          contextName: 'CurrentStepContext',
          schema: { type: 'number' },
          default: 0,
        },
      ],
    });
    const bootstrap = extractInlineBootstrap(html);
    // Round-trip through the runtime's validator. We import lazily to
    // avoid loading the iframe-runtime bundle at the top of every test
    // file in this package.
    const { validateBootstrapMeta } = await import(
      '@ggui-ai/iframe-runtime'
    );
    const result = validateBootstrapMeta(bootstrap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bootstrap.runtimeUrl).toBe(SAMPLE_RUNTIME_URL);
      expect(result.bootstrap.codeUrl).toBe(SAMPLE_CODE_URL);
      expect(result.bootstrap.contextSlots).toHaveLength(1);
    }
  });

  it('emits a bootstrap that the iframe-runtime validator accepts (system-card mode)', async () => {
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      systemKind: 'no-credentials',
    });
    const bootstrap = extractInlineBootstrap(html);
    const { validateBootstrapMeta } = await import(
      '@ggui-ai/iframe-runtime'
    );
    const result = validateBootstrapMeta(bootstrap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bootstrap.kind).toBe('no-credentials');
    }
  });

  describe('Integration 2 — canvas-mode bootstrap', () => {
    it('stamps canvasMode + omits stackItemId/codeUrl/systemKind', () => {
      const html = buildSelfContainedShell({
        sessionId: 'sess_canvas',
        appId: 'app_canvas',
        runtimeUrl: SAMPLE_RUNTIME_URL,
        canvasMode: true,
        wsUrl: 'wss://example.com/ws',
        token: 'tok-1',
        expiresAt: '2099-01-01T00:00:00Z',
      });
      const bootstrap = extractInlineBootstrap(html);
      expect(bootstrap.canvasMode).toBe(true);
      expect(bootstrap.stackItemId).toBeUndefined();
      expect(bootstrap.codeUrl).toBeUndefined();
      expect(bootstrap.kind).toBeUndefined();
      expect(bootstrap.wsUrl).toBe('wss://example.com/ws');
      expect(bootstrap.token).toBe('tok-1');
      expect(bootstrap.sessionId).toBe('sess_canvas');
    });

    it('throws when canvasMode is combined with stackItemId', () => {
      expect(() =>
        buildSelfContainedShell({
          sessionId: 'sess',
          appId: 'app',
          runtimeUrl: SAMPLE_RUNTIME_URL,
          canvasMode: true,
          stackItemId: 'stk-1',
          wsUrl: 'wss://example.com/ws',
          token: 'tok',
          expiresAt: '2099-01-01T00:00:00Z',
        }),
      ).toThrow(/canvasMode is mutually exclusive/);
    });

    it('throws when canvasMode is combined with codeUrl', () => {
      expect(() =>
        buildSelfContainedShell({
          sessionId: 'sess',
          appId: 'app',
          runtimeUrl: SAMPLE_RUNTIME_URL,
          canvasMode: true,
          codeUrl: SAMPLE_CODE_URL,
          codeHash: SAMPLE_CODE_HASH,
          wsUrl: 'wss://example.com/ws',
          token: 'tok',
          expiresAt: '2099-01-01T00:00:00Z',
        }),
      ).toThrow(/canvasMode is mutually exclusive/);
    });

    it('throws when canvasMode is set without live-mode trio', () => {
      expect(() =>
        buildSelfContainedShell({
          sessionId: 'sess',
          appId: 'app',
          runtimeUrl: SAMPLE_RUNTIME_URL,
          canvasMode: true,
        }),
      ).toThrow(/canvasMode requires the live-mode trio/);
    });
  });
});
