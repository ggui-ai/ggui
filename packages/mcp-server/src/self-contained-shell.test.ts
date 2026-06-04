/**
 * Slice 14 (2026-05-08) — `buildSelfContainedShell` injects the full
 * bootstrap envelope, not just `{renderId, appId, componentCode|kind}`.
 *
 * Pre-Slice-14 the inline `__GGUI_META__` global only carried the
 * minimum to mount a compiled component on the postMessage shell path.
 * The self-contained per-render resource (`ui://ggui/render/<id>`)
 * direct-preview path uses the SAME global as its sole boot source —
 * so anything the runtime needs (`runtimeUrl` for the bundle URL,
 * `contextSlots` for Provider seeds, `appCallableTools` /
 * `actionNextSteps` for dispatch routing) had to be inlined too.
 * Without these, contextSpec UIs blank-page'd because the runtime's
 * bootstrap validator rejected the envelope as MALFORMED.
 *
 * Post-Phase-B (flatten-render-identity, 2026-05-27): the wire
 * collapsed the prior `ai.ggui/session` + `ai.ggui/stack-item` slice
 * pair to a single flat `ai.ggui/render` slice. Every field the
 * pre-Phase-B tests asserted on `session?.X` or `stackItem?.X` now
 * lives directly on `renderSlice?.X`.
 *
 * This suite locks the inline-bootstrap shape against the runtime's
 * validator: the HTML the shell emits MUST contain a JSON literal
 * that round-trips cleanly through the iframe-runtime's
 * {@link parseMetaFromGlobal} extractor.
 */
import { describe, expect, it } from 'vitest';
import { buildSelfContainedShell } from './mcp-apps-outbound.js';
import {
  MCP_APP_AI_GGUI_RENDER_META_KEY,
} from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * Pull the slice envelope out of the shell HTML's
 * `<script>window.__GGUI_META__ = {...};</script>` line, then return
 * the single `ai.ggui/render` slice. Post-Phase-B the inline global
 * carries ONE flat slice (was: two — `ai.ggui/session` +
 * `ai.ggui/stack-item`).
 *
 * Mirrors what the browser would do: parse the JSON the server
 * stamped, modulo the HTML-escape de-mangling for `<` / `>` / `&` and
 * the JS line-terminator escapes (U+2028 / U+2029) the builder
 * applies. Replacement targets are simple printables so this file
 * itself stays free of irregular whitespace.
 */
function extractInlineRenderSlice(
  html: string,
): Record<string, unknown> | undefined {
  const envelope = extractInlineSliceEnvelope(html);
  return envelope[MCP_APP_AI_GGUI_RENDER_META_KEY] as
    | Record<string, unknown>
    | undefined;
}

/**
 * Pull the raw slice envelope (slice key intact:
 * `{"ai.ggui/render": {...}}`) out of the shell HTML's
 * `window.__GGUI_META__` global. The slice-keyed shape is what
 * `parseMcpAppAiGguiRenderMeta` (and any wire `_meta` consumer)
 * expects; the destructured helper `extractInlineRenderSlice` derives
 * from this and offers ergonomic field access for the other tests.
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
  it('inlines runtimeUrl on the render slice (closes the blank-page bug)', () => {
    const html = buildSelfContainedShell({
      renderId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
    });
    const slice = extractInlineRenderSlice(html);
    expect(slice?.['runtimeUrl']).toBe(SAMPLE_RUNTIME_URL);
  });

  it('inlines contextSlots on the render slice when supplied', () => {
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
      renderId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      contextSlots: slots,
    });
    const slice = extractInlineRenderSlice(html);
    expect(slice?.['contextSlots']).toEqual(slots);
  });

  it('inlines appCallableTools on the render slice when supplied non-empty', () => {
    const html = buildSelfContainedShell({
      renderId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      appCallableTools: ['ggui_runtime_submit_action', 'gmail_archive'],
    });
    const slice = extractInlineRenderSlice(html);
    expect(slice?.['appCallableTools']).toEqual([
      'ggui_runtime_submit_action',
      'gmail_archive',
    ]);
  });

  it('inlines actionNextSteps on the render slice when supplied non-empty', () => {
    const html = buildSelfContainedShell({
      renderId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      actionNextSteps: { archive: 'gmail_archive' },
    });
    const slice = extractInlineRenderSlice(html);
    expect(slice?.['actionNextSteps']).toEqual({ archive: 'gmail_archive' });
  });

  it('omits optional fields when supplied empty', () => {
    // Empty arrays / records spread to "absent" so consumers see no
    // change vs an envelope built without these fields.
    const html = buildSelfContainedShell({
      renderId: 'sess_001',
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
    const slice = extractInlineRenderSlice(html);
    expect(slice && 'appCallableTools' in slice).toBe(false);
    expect(slice && 'gadgets' in slice).toBe(false);
    expect(slice && 'publicEnv' in slice).toBe(false);
    expect(slice && 'actionNextSteps' in slice).toBe(false);
    expect(slice && 'contextSlots' in slice).toBe(false);
  });

  // Slice 1.3.3/2.2 audit fix — the self-contained shell MUST
  // forward `gadgets` (wrapper catalog) + `publicEnv` (env
  // values). Without these, the resources/read path renders as
  // STDLIB-only iframes, regressing wrapper-using contracts
  // (Leaflet, Mapbox).
  it('inlines gadgets on the render slice when supplied (GG.8.2 — per-package channel)', () => {
    const html = buildSelfContainedShell({
      renderId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      gadgets: [{ package: '@ggui-samples/gadget-leaflet' }],
    });
    const slice = extractInlineRenderSlice(html);
    expect(slice?.['gadgets']).toEqual([
      { package: '@ggui-samples/gadget-leaflet' },
    ]);
  });

  it('inlines publicEnv when supplied (Slice 2.2 forward)', () => {
    const html = buildSelfContainedShell({
      renderId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      codeUrl: SAMPLE_CODE_URL,
      codeHash: SAMPLE_CODE_HASH,
      publicEnv: { GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...' },
    });
    const slice = extractInlineRenderSlice(html);
    expect(slice?.['publicEnv']).toEqual({
      GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
    });
  });

  it('emits a slice envelope that the iframe-runtime validator accepts (component mode)', async () => {
    const html = buildSelfContainedShell({
      renderId: 'sess_001',
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
    const { parseMcpAppAiGguiRenderMeta } = await import(
      '@ggui-ai/protocol/integrations/mcp-apps'
    );
    const { validateMeta } = await import('@ggui-ai/iframe-runtime');
    const parsed = parseMcpAppAiGguiRenderMeta(envelope);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.meta) return;
    const result = validateMeta(parsed.meta);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.runtimeUrl).toBe(SAMPLE_RUNTIME_URL);
      expect(result.meta.codeUrl).toBe(SAMPLE_CODE_URL);
      expect(result.meta.contextSlots).toHaveLength(1);
    }
  });

  it('emits a slice envelope that the iframe-runtime validator accepts (system-card mode)', async () => {
    const html = buildSelfContainedShell({
      renderId: 'sess_001',
      appId: 'app_001',
      runtimeUrl: SAMPLE_RUNTIME_URL,
      systemKind: 'no-credentials',
    });
    const envelope = extractInlineSliceEnvelope(html);
    const { parseMcpAppAiGguiRenderMeta } = await import(
      '@ggui-ai/protocol/integrations/mcp-apps'
    );
    const { validateMeta } = await import('@ggui-ai/iframe-runtime');
    const parsed = parseMcpAppAiGguiRenderMeta(envelope);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.meta) return;
    const result = validateMeta(parsed.meta);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.kind).toBe('no-credentials');
    }
  });

  // Fullscreen-mode bootstrap branch retired in the displayMode-unification
  // slice. The shell builder no longer has a `canvasMode` discriminator;
  // every render routes through the same code path regardless of how the
  // host presents the iframe. `_meta.ui.displayMode` (spec-native MCP-Apps
  // SEP-1865) is the only per-render hint and is stamped from
  // `App.defaultDisplayMode` by the render handler's `resultMeta`, not by this builder.
});
