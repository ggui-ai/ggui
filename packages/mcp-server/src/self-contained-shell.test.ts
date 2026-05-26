/**
 * Slice 14 (2026-05-08) — `buildSelfContainedShell` injects the full
 * bootstrap envelope, not just `{sessionId, appId, componentCode|kind}`.
 *
 * Pre-Slice-14 the inline `__GGUI_META__` global only carried the
 * minimum to mount a compiled component on the postMessage shell path.
 * The self-contained per-session resource (`ui://ggui/session/<id>`)
 * direct-preview path uses the SAME global as its sole boot source —
 * so anything the runtime needs (`runtimeUrl` for the bundle URL,
 * `contextSlots` for Provider seeds, `appCallableTools` /
 * `actionNextSteps` for dispatch routing) had to be inlined too.
 * Without these, contextSpec UIs blank-page'd because the runtime's
 * bootstrap validator rejected the envelope as MALFORMED.
 *
 * This suite locks the inline-bootstrap shape against the runtime's
 * validator: the HTML the shell emits MUST contain a JSON literal
 * that round-trips cleanly through the iframe-runtime's
 * {@link parseBootstrapFromGlobal} extractor.
 */
import { describe, expect, it } from 'vitest';
import { buildSelfContainedShell } from './mcp-apps-outbound.js';
import {
  MCP_APP_AI_GGUI_SESSION_META_KEY,
  MCP_APP_AI_GGUI_STACK_ITEM_META_KEY,
} from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * Pull the slice envelope out of the shell HTML's
 * `<script>window.__GGUI_META__ = {...};</script>` line.
 *
 * Mirrors what the browser would do: parse the JSON the server
 * stamped, modulo the HTML-escape de-mangling for `<` / `>` / `&` and
 * the JS line-terminator escapes (U+2028 / U+2029) the builder
 * applies. Replacement targets are simple printables so this file
 * itself stays free of irregular whitespace.
 *
 * Returns `{session, stackItem?}` — post-R3 the inline global carries
 * the SAME shape as the wire `_meta` envelope (two keys
 * `ai.ggui/session` + `ai.ggui/stack-item`), unpacked here for ergonomic
 * field access. Either slice may be undefined depending on shell inputs
 * (canvas mode omits stack-item).
 */
function extractInlineBootstrap(html: string): {
  session?: Record<string, unknown>;
  stackItem?: Record<string, unknown>;
} {
  const envelope = extractInlineSliceEnvelope(html);
  return {
    session: envelope[MCP_APP_AI_GGUI_SESSION_META_KEY] as
      | Record<string, unknown>
      | undefined,
    stackItem: envelope[MCP_APP_AI_GGUI_STACK_ITEM_META_KEY] as
      | Record<string, unknown>
      | undefined,
  };
}

/**
 * Pull the raw slice envelope (slice keys intact:
 * `{"ai.ggui/session": {...}, "ai.ggui/stack-item": {...}}`) out of the
 * shell HTML's `window.__GGUI_META__` global. The slice-keyed
 * shape is what `parseMcpAppAiGguiMeta` (and any wire `_meta` consumer)
 * expects; the destructured-helper `extractInlineBootstrap` derives from
 * this and offers ergonomic field access for the other tests.
 */
function extractInlineSliceEnvelope(html: string): Record<string, unknown> {
  const match = html.match(/window\.__GGUI_META__ = (.+?);<\/script>/);
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
  it('inlines runtimeUrl on the session slice (closes the blank-page bug)', () => {
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
    });
    const { session } = extractInlineBootstrap(html);
    expect(session?.['runtimeUrl']).toBe(SAMPLE_RUNTIME_URL);
  });

  it('inlines contextSlots on the stack-item slice when supplied', () => {
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
    const { stackItem } = extractInlineBootstrap(html);
    expect(stackItem?.['contextSlots']).toEqual(slots);
  });

  it('inlines appCallableTools on the session slice when supplied non-empty', () => {
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      appCallableTools: ['ggui_runtime_submit_action', 'gmail_archive'],
    });
    const { session } = extractInlineBootstrap(html);
    expect(session?.['appCallableTools']).toEqual([
      'ggui_runtime_submit_action',
      'gmail_archive',
    ]);
  });

  it('inlines actionNextSteps on the stack-item slice when supplied non-empty', () => {
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      actionNextSteps: { archive: 'gmail_archive' },
    });
    const { stackItem } = extractInlineBootstrap(html);
    expect(stackItem?.['actionNextSteps']).toEqual({ archive: 'gmail_archive' });
  });

  it('omits optional fields when supplied empty', () => {
    // Empty arrays / records spread to "absent" so consumers see no
    // change vs an envelope built without these fields.
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
    const { session, stackItem } = extractInlineBootstrap(html);
    expect(session && 'appCallableTools' in session).toBe(false);
    expect(session && 'gadgets' in session).toBe(false);
    expect(session && 'publicEnv' in session).toBe(false);
    expect(stackItem && 'actionNextSteps' in stackItem).toBe(false);
    expect(stackItem && 'contextSlots' in stackItem).toBe(false);
  });

  // Slice 1.3.3/2.2 audit fix — the self-contained shell MUST
  // forward `gadgets` (wrapper catalog) + `publicEnv` (env
  // values). Without these, the resources/read path renders as
  // STDLIB-only iframes, regressing wrapper-using contracts
  // (Leaflet, Mapbox).
  it('inlines gadgets on the session slice when supplied (GG.8.2 — per-package channel)', () => {
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      gadgets: [{ package: '@ggui-samples/gadget-leaflet' }],
    });
    const { session } = extractInlineBootstrap(html);
    expect(session?.['gadgets']).toEqual([
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
    const { session } = extractInlineBootstrap(html);
    expect(session?.['publicEnv']).toEqual({
      GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
    });
  });

  it('emits a slice envelope that the iframe-runtime validator accepts (component mode)', async () => {
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
    // Post-R3 (#109) the inline global carries the SAME slice envelope
    // shape as the wire `_meta` — combine, then validate. Lazy imports
    // keep the iframe-runtime bundle off the package's other tests.
    const envelope = extractInlineSliceEnvelope(html);
    const { parseMcpAppAiGguiMeta } = await import(
      '@ggui-ai/protocol/integrations/mcp-apps'
    );
    const { validateMeta } = await import('@ggui-ai/iframe-runtime');
    const parsed = parseMcpAppAiGguiMeta(envelope);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = validateMeta(parsed.meta);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.runtimeUrl).toBe(SAMPLE_RUNTIME_URL);
      expect(result.meta.stackItem?.codeUrl).toBe(SAMPLE_CODE_URL);
      expect(result.meta.stackItem?.contextSlots).toHaveLength(1);
    }
  });

  it('emits a slice envelope that the iframe-runtime validator accepts (system-card mode)', async () => {
    const html = buildSelfContainedShell({
      sessionId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      systemKind: 'no-credentials',
    });
    const envelope = extractInlineSliceEnvelope(html);
    const { parseMcpAppAiGguiMeta } = await import(
      '@ggui-ai/protocol/integrations/mcp-apps'
    );
    const { validateMeta } = await import('@ggui-ai/iframe-runtime');
    const parsed = parseMcpAppAiGguiMeta(envelope);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = validateMeta(parsed.meta);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.stackItem?.kind).toBe('no-credentials');
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
      const { session, stackItem } = extractInlineBootstrap(html);
      expect(session?.canvasMode).toBe(true);
      // Canvas mode emits no stack-item slice — the canvas iframe
      // receives stack items via the live channel.
      expect(stackItem).toBeUndefined();
      expect(session?.wsUrl).toBe('wss://example.com/ws');
      expect(session?.wsToken).toBe('tok-1');
      expect(session?.sessionId).toBe('sess_canvas');
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
