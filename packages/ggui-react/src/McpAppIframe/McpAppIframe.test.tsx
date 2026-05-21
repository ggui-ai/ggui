/**
 * Tests for `<McpAppIframe>` on web — plan §C9 obligations + adapter-
 * boundary enforcement + web↔RN parity coverage.
 *
 * Covers:
 *   1. Mount source: srcdoc for inline text, data-URL for blob,
 *      src for http(s) uri; null mount source fires a bootstrap-
 *      failed error via onError.
 *   2. ui/initialize reply carries ONLY {theme, containerDimensions,
 *      locale}. Outer-app state keys ('stack', 'sessionId', 'appId',
 *      'actionSpec', 'streamSpec') are NEVER present.
 *   3. ping → {ok:true, pong:true}.
 *   4. ui/open-link with http(s) → `window.open` called; other schemes
 *      rejected with `unsupported-scheme`.
 *   5. tools/call forwards to onToolCall; absent onToolCall →
 *      `no-tool-handler`.
 *   6. Unknown method → `method_not_supported`.
 *   7. Renderer `ggui:bootstrap-failed` envelope → onError with
 *      classified ProtocolError.
 *   8. Renderer `ggui:observe` envelope → onObserve.
 *   9. Renderer `ggui:upgrade-required` envelope → onUpgradeRequired
 *      AND onError (`{kind:'version'}`).
 *  10. Unmount → `ui/resource-teardown` posted BEFORE DOM removal.
 *  11. Imperative ref `dispatchAction` posts the expected JSON-RPC
 *      notification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { act, render } from '@testing-library/react';
import type { ResourceContents } from '@modelcontextprotocol/sdk/types.js';
import type { GguiBootstrapMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  McpAppIframe,
} from './McpAppIframe';
import {
  buildDispatchActionNotification,
  buildResourceTeardownNotification,
  classifyRendererEnvelope,
  deriveResourceMountSource,
  dispatchHostBridgeRequest,
  type HostBridgeContext,
} from './dispatch';
import type { McpAppIframeRef } from './types';

const SAMPLE_BOOTSTRAP: GguiBootstrapMeta = {
  wsUrl: 'wss://test.example/ws',
  token: 'sample-bootstrap-token',
  expiresAt: '2099-12-31T23:59:59.999Z',
  sessionId: 'sess-test',
  appId: 'app-test',
  runtimeUrl: '/_ggui/iframe-runtime.js',
};

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function makeResource(overrides?: Partial<ResourceContents>): ResourceContents {
  return {
    uri: 'ui://test/app',
    mimeType: 'text/html;profile=mcp-app',
    text: '<!doctype html><html><body>hello</body></html>',
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<HostBridgeContext>): HostBridgeContext {
  return {
    theme: { '--color-primary': '#ff0000' },
    locale: 'en-US',
    containerDimensions: { width: 640, height: 480 },
    openLink: vi.fn(async () => undefined),
    ...overrides,
  };
}

/**
 * Capture postMessages the host sends TO the iframe. jsdom fires
 * `message` events on the contentWindow when `postMessage` is called
 * on it — we listen and record.
 */
function captureHostToIframe(): {
  calls: unknown[];
  cleanup: () => void;
} {
  const iframe = document.querySelector('iframe');
  if (!iframe) throw new Error('iframe not yet mounted');
  const win = iframe.contentWindow;
  if (!win) throw new Error('iframe has no contentWindow');
  const calls: unknown[] = [];
  const handler = (ev: MessageEvent): void => {
    calls.push(ev.data);
  };
  win.addEventListener('message', handler);
  return {
    calls,
    cleanup: () => win.removeEventListener('message', handler),
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function simulateFromIframe(data: unknown): Promise<void> {
  const iframe = document.querySelector('iframe');
  if (!iframe) throw new Error('iframe not yet mounted');
  const win = iframe.contentWindow;
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        source: win as Window,
        origin: 'http://localhost',
      }),
    );
  });
  await flush();
}

// =============================================================================
// Pure dispatcher tests — share coverage with the RN port
// =============================================================================

describe('dispatchHostBridgeRequest (shared switch)', () => {
  it('returns null for malformed requests', async () => {
    expect(await dispatchHostBridgeRequest(null as never, makeCtx())).toBeNull();
    expect(await dispatchHostBridgeRequest({} as never, makeCtx())).toBeNull();
    expect(
      await dispatchHostBridgeRequest(
        { jsonrpc: '1.0', method: 'ping' } as never,
        makeCtx(),
      ),
    ).toBeNull();
  });

  it('returns null for notifications (no id)', async () => {
    expect(
      await dispatchHostBridgeRequest(
        { jsonrpc: '2.0', method: 'ping' },
        makeCtx(),
      ),
    ).toBeNull();
  });

  it('ping responds with ok+pong', async () => {
    const res = await dispatchHostBridgeRequest(
      { jsonrpc: '2.0', id: 7, method: 'ping' },
      makeCtx(),
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { ok: true, pong: true },
    });
  });

  describe('ui/initialize — ADAPTER BOUNDARY (default posture)', () => {
    it('result carries ONLY theme / containerDimensions / locale when no bootstrap is provided', async () => {
      const res = await dispatchHostBridgeRequest(
        { jsonrpc: '2.0', id: 1, method: 'ui/initialize' },
        makeCtx(),
      );
      const keys = Object.keys(res?.result ?? {}).sort();
      expect(keys).toEqual(['containerDimensions', 'locale', 'theme']);
      // toolOutput / _meta MUST NOT leak when no bootstrap is opted in.
      expect(res?.result).not.toHaveProperty('toolOutput');
      expect(res?.result).not.toHaveProperty('_meta');
      for (const forbidden of [
        'stack',
        'sessionId',
        'appId',
        'currentStackIndex',
        'actionSpec',
        'streamSpec',
        'propsSpec',
      ]) {
        expect(res?.result).not.toHaveProperty(forbidden);
      }
    });

    it('forwards theme + locale + containerDimensions from context', async () => {
      const res = await dispatchHostBridgeRequest(
        { jsonrpc: '2.0', id: 1, method: 'ui/initialize' },
        makeCtx({
          theme: { '--color-primary': '#00ff00' },
          locale: 'fr-FR',
          containerDimensions: { width: 320, height: 200 },
        }),
      );
      expect(res?.result?.theme).toEqual({ '--color-primary': '#00ff00' });
      expect(res?.result?.locale).toBe('fr-FR');
      expect(res?.result?.containerDimensions).toEqual({ width: 320, height: 200 });
    });
  });

  describe('ui/initialize — READING-B BOOTSTRAP FORWARDING (opt-in)', () => {
    // Reading B per `docs/principles/renderer-as-portable-runtime.md`
    // §4.3 / §6.2. When `ctx.bootstrap` is set the host adds
    // `toolOutput._meta.ggui.bootstrap = ctx.bootstrap` alongside the
    // adapter-boundary fields — narrow exception scoped to the ggui
    // namespace, opt-in only.

    it('carries toolOutput._meta.ggui.bootstrap === ctx.bootstrap when bootstrap is provided', async () => {
      const res = await dispatchHostBridgeRequest(
        { jsonrpc: '2.0', id: 1, method: 'ui/initialize' },
        makeCtx({ bootstrap: SAMPLE_BOOTSTRAP }),
      );
      const result = res?.result as Record<string, unknown>;
      expect(result).toHaveProperty('toolOutput');
      const toolOutput = result['toolOutput'] as Record<string, unknown>;
      const meta = toolOutput['_meta'] as Record<string, unknown>;
      const ggui = meta['ggui'] as Record<string, unknown>;
      expect(ggui['bootstrap']).toBe(SAMPLE_BOOTSTRAP);
    });

    it('still carries theme / containerDimensions / locale alongside the forwarded bootstrap', async () => {
      const res = await dispatchHostBridgeRequest(
        { jsonrpc: '2.0', id: 1, method: 'ui/initialize' },
        makeCtx({
          bootstrap: SAMPLE_BOOTSTRAP,
          theme: { '--color-primary': '#abc123' },
          locale: 'es-ES',
          containerDimensions: { width: 800, height: 600 },
        }),
      );
      expect(res?.result?.theme).toEqual({ '--color-primary': '#abc123' });
      expect(res?.result?.locale).toBe('es-ES');
      expect(res?.result?.containerDimensions).toEqual({ width: 800, height: 600 });
    });

    it('does NOT leak any _meta keys other than ggui.bootstrap', async () => {
      // Narrow-exception invariant: the ONLY key under
      // `toolOutput._meta` is `ggui`, and the ONLY key under
      // `toolOutput._meta.ggui` is `bootstrap`. Other namespaces
      // (e.g. `_meta.ui.*` from MCP Apps' own tool-result side) do
      // NOT leak — the host owns this object construction and only
      // forwards what the brief explicitly authorizes.
      const res = await dispatchHostBridgeRequest(
        { jsonrpc: '2.0', id: 1, method: 'ui/initialize' },
        makeCtx({ bootstrap: SAMPLE_BOOTSTRAP }),
      );
      const result = res?.result as Record<string, unknown>;
      const toolOutput = result['toolOutput'] as Record<string, unknown>;
      // No other keys on toolOutput beyond `_meta`.
      expect(Object.keys(toolOutput).sort()).toEqual(['_meta']);
      const meta = toolOutput['_meta'] as Record<string, unknown>;
      // No other namespaces on _meta beyond `ggui`.
      expect(Object.keys(meta).sort()).toEqual(['ggui']);
      const ggui = meta['ggui'] as Record<string, unknown>;
      // No other keys on _meta.ggui beyond `bootstrap`.
      expect(Object.keys(ggui).sort()).toEqual(['bootstrap']);
    });

    it('parseBootstrap-shaped: the renderer reads result.toolOutput._meta.ggui.bootstrap exactly', async () => {
      // Cross-check against the renderer's parser contract. The shape
      // produced here MUST match what `parseBootstrap()` (in
      // `packages/iframe-runtime/src/bootstrap.ts`) reads. This test
      // structurally walks the same path the renderer does.
      const res = await dispatchHostBridgeRequest(
        { jsonrpc: '2.0', id: 7, method: 'ui/initialize' },
        makeCtx({ bootstrap: SAMPLE_BOOTSTRAP }),
      );
      const result = res?.result as Record<string, unknown>;
      // parseBootstrap walks: result.toolOutput._meta.ggui.bootstrap
      const toolOutput = result['toolOutput'] as Record<string, unknown>;
      const meta = toolOutput['_meta'] as Record<string, unknown>;
      const ggui = meta['ggui'] as Record<string, unknown>;
      const bootstrap = ggui['bootstrap'] as GguiBootstrapMeta;
      // Required fields present.
      expect(bootstrap.wsUrl).toBe(SAMPLE_BOOTSTRAP.wsUrl);
      expect(bootstrap.token).toBe(SAMPLE_BOOTSTRAP.token);
      expect(bootstrap.sessionId).toBe(SAMPLE_BOOTSTRAP.sessionId);
      expect(bootstrap.appId).toBe(SAMPLE_BOOTSTRAP.appId);
      expect(bootstrap.runtimeUrl).toBe(SAMPLE_BOOTSTRAP.runtimeUrl);
    });
  });

  describe('ui/open-link', () => {
    it('rejects non-http(s) schemes with unsupported-scheme', async () => {
      for (const url of [
        'javascript:alert(1)',
        'file:///etc/passwd',
        'data:text/html,<script>',
        'ftp://example.com',
        'chrome://settings',
        '',
      ]) {
        const res = await dispatchHostBridgeRequest(
          { jsonrpc: '2.0', id: 1, method: 'ui/open-link', params: { url } },
          makeCtx(),
        );
        expect(res?.error?.code).toBe(-32602);
        expect(res?.error?.message).toBe('unsupported-scheme');
      }
    });

    it('delegates http(s) URLs to openLink', async () => {
      const openLink = vi.fn(async (_url: string) => undefined);
      const res = await dispatchHostBridgeRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'ui/open-link',
          params: { url: 'https://example.com' },
        },
        makeCtx({ openLink }),
      );
      expect(openLink).toHaveBeenCalledWith('https://example.com');
      expect(res?.result).toEqual({ opened: true });
    });

    it('surfaces openLink failures as -32000', async () => {
      const openLink = vi.fn(async () => {
        throw new Error('no handler');
      });
      const res = await dispatchHostBridgeRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'ui/open-link',
          params: { url: 'https://example.com' },
        },
        makeCtx({ openLink }),
      );
      expect(res?.error?.code).toBe(-32000);
      expect(res?.error?.message).toContain('open_link_failed');
    });
  });

  describe('tools/call', () => {
    it('rejects with no-tool-handler when onToolCall is absent', async () => {
      const res = await dispatchHostBridgeRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'checkout' },
        },
        makeCtx({ onToolCall: undefined }),
      );
      expect(res?.error?.code).toBe(-32000);
      expect(res?.error?.message).toBe('no-tool-handler');
    });

    it('rejects missing tool name with -32602', async () => {
      const onToolCall = vi.fn(async () => ({}));
      const res = await dispatchHostBridgeRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} },
        makeCtx({ onToolCall }),
      );
      expect(onToolCall).not.toHaveBeenCalled();
      expect(res?.error?.code).toBe(-32602);
    });

    it('forwards name + arguments to onToolCall and returns its result', async () => {
      const onToolCall = vi.fn(async (tool: string, args: Record<string, unknown>) => ({
        tool,
        args,
      }));
      const res = await dispatchHostBridgeRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'checkout', arguments: { amount: 42 } },
        },
        makeCtx({ onToolCall }),
      );
      expect(onToolCall).toHaveBeenCalledWith('checkout', { amount: 42 });
      expect(res?.result).toEqual({ tool: 'checkout', args: { amount: 42 } });
    });

    it('wraps primitive onToolCall results in { value }', async () => {
      const onToolCall = vi.fn(async () => 42);
      const res = await dispatchHostBridgeRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 't' },
        },
        makeCtx({ onToolCall }),
      );
      expect(res?.result).toEqual({ value: 42 });
    });

    it('surfaces onToolCall rejections as -32000 tool_call_failed', async () => {
      const onToolCall = vi.fn(async () => {
        throw new Error('denied');
      });
      const res = await dispatchHostBridgeRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 't' },
        },
        makeCtx({ onToolCall }),
      );
      expect(res?.error?.code).toBe(-32000);
      expect(res?.error?.message).toContain('tool_call_failed');
      expect(res?.error?.message).toContain('denied');
    });
  });

  it('unknown method → method_not_supported (-32601)', async () => {
    const res = await dispatchHostBridgeRequest(
      { jsonrpc: '2.0', id: 5, method: 'ui/request-display-mode' },
      makeCtx(),
    );
    expect(res?.error).toEqual({ code: -32601, message: 'method_not_supported' });
  });
});

// =============================================================================
// Envelope classification
// =============================================================================

describe('classifyRendererEnvelope', () => {
  it('tags bootstrap-failed / protocol-error / observability / lifecycle / upgrade-required', () => {
    expect(classifyRendererEnvelope({ type: 'ggui:bootstrap-failed' })).toBe(
      'bootstrap-failed',
    );
    expect(classifyRendererEnvelope({ type: 'ggui:protocol-error' })).toBe(
      'protocol-error',
    );
    expect(classifyRendererEnvelope({ type: 'ggui:observe' })).toBe('observability');
    expect(classifyRendererEnvelope({ type: 'ggui:lifecycle' })).toBe(
      'lifecycle',
    );
    expect(classifyRendererEnvelope({ type: 'ggui:upgrade-required' })).toBe(
      'upgrade-required',
    );
  });

  it('falls through to jsonrpc for non-ggui JSON-RPC 2.0 messages', () => {
    expect(
      classifyRendererEnvelope({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    ).toBe('jsonrpc');
  });

  it('tags unknown for everything else', () => {
    expect(classifyRendererEnvelope(null)).toBe('unknown');
    expect(classifyRendererEnvelope('string')).toBe('unknown');
    expect(classifyRendererEnvelope({ type: 'unknown:envelope' })).toBe('unknown');
    expect(classifyRendererEnvelope({ jsonrpc: '1.0' })).toBe('unknown');
  });
});

// =============================================================================
// Resource → mount-source derivation
// =============================================================================

describe('deriveResourceMountSource', () => {
  it('text → srcdoc', () => {
    const src = deriveResourceMountSource({ uri: 'ui://x', text: '<p>hi</p>' });
    expect(src).toEqual({ kind: 'srcdoc', value: '<p>hi</p>' });
  });

  it('blob → data-URL with mimeType fallback to text/html', () => {
    const blobB64 = 'ZGF0YQ==';
    const src = deriveResourceMountSource({ uri: 'ui://x', blob: blobB64 });
    expect(src).toEqual({
      kind: 'data-url',
      value: `data:text/html;base64,${blobB64}`,
    });
  });

  it('blob + mimeType → data-URL with provided mimeType', () => {
    const src = deriveResourceMountSource({
      uri: 'ui://x',
      blob: 'ZGF0YQ==',
      mimeType: 'text/html;profile=mcp-app',
    });
    expect(src?.value.startsWith('data:text/html;profile=mcp-app;base64,')).toBe(true);
  });

  it('http(s) uri → src', () => {
    expect(deriveResourceMountSource({ uri: 'https://example.com/r' })).toEqual({
      kind: 'src',
      value: 'https://example.com/r',
    });
    expect(deriveResourceMountSource({ uri: 'http://example.com/r' })).toEqual({
      kind: 'src',
      value: 'http://example.com/r',
    });
  });

  it('non-http(s) uri with no inline content → null', () => {
    expect(deriveResourceMountSource({ uri: 'ui://test' })).toBeNull();
    expect(deriveResourceMountSource({ uri: 'mcp://foo' })).toBeNull();
    expect(deriveResourceMountSource({ uri: 'javascript:void(0)' })).toBeNull();
  });

  it('prefers text > blob > uri when multiple are set', () => {
    const src = deriveResourceMountSource({
      uri: 'https://fallback.com',
      text: '<p>inline</p>',
      blob: 'ZGF0YQ==',
    });
    expect(src?.kind).toBe('srcdoc');
  });
});

// =============================================================================
// Builder helpers
// =============================================================================

describe('buildDispatchActionNotification', () => {
  it('produces a JSON-RPC notification (no id)', () => {
    const n = buildDispatchActionNotification('test.action', { a: 1 });
    expect(n).toEqual({
      jsonrpc: '2.0',
      method: 'test.action',
      params: { data: { a: 1 } },
    });
    expect(n).not.toHaveProperty('id');
  });
});

describe('buildResourceTeardownNotification', () => {
  it('produces the canonical teardown shape', () => {
    expect(buildResourceTeardownNotification()).toEqual({
      jsonrpc: '2.0',
      method: 'ui/resource-teardown',
      params: { reason: 'host_unmount' },
    });
  });
});

// =============================================================================
// <McpAppIframe> integration — jsdom
// =============================================================================

describe('<McpAppIframe> — mount source derivation', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'language', {
      value: 'en-US',
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mounts iframe with srcDoc when resource.text is present', () => {
    const { unmount } = render(
      <McpAppIframe resource={makeResource({ text: '<p>inline</p>' })} />,
    );
    const iframe = document.querySelector('iframe');
    expect(iframe).not.toBeNull();
    // React maps the `srcDoc` prop to the `srcdoc` HTML attribute.
    expect(iframe?.getAttribute('srcdoc')).toBe('<p>inline</p>');
    expect(iframe?.getAttribute('src')).toBe(null);
    unmount();
  });

  it('mounts iframe with src data-URL when resource.blob is present', () => {
    const blob = 'aGVsbG8=';
    const { unmount } = render(
      <McpAppIframe
        resource={makeResource({ text: undefined, blob, mimeType: 'text/html' })}
      />,
    );
    const iframe = document.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe(`data:text/html;base64,${blob}`);
    unmount();
  });

  it('mounts iframe with src http URL when only uri is provided', () => {
    const { unmount } = render(
      <McpAppIframe
        resource={{ uri: 'https://example.com/app', mimeType: 'text/html' }}
      />,
    );
    const iframe = document.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe('https://example.com/app');
    unmount();
  });

  it('null mount source fires bootstrap-failed via onError', () => {
    const onError = vi.fn();
    const { unmount } = render(
      <McpAppIframe
        resource={{ uri: 'ui://unmountable', mimeType: 'text/html' }}
        onError={onError}
      />,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const arg = onError.mock.calls[0]?.[0];
    expect(arg?.kind).toBe('bootstrap');
    expect(arg?.reason).toBe('MALFORMED_BOOTSTRAP');
    expect(arg?.message).toContain('ui://unmountable');
    unmount();
  });

  it('adds allow attribute for granted permissions', () => {
    const { unmount } = render(
      <McpAppIframe
        resource={makeResource()}
        permissions={{ camera: true, microphone: true }}
      />,
    );
    const iframe = document.querySelector('iframe');
    const allow = iframe?.getAttribute('allow') ?? '';
    expect(allow).toContain("camera 'self'");
    expect(allow).toContain("microphone 'self'");
    unmount();
  });

  it('uses sandbox="allow-scripts allow-forms" (never allow-same-origin)', () => {
    const { unmount } = render(<McpAppIframe resource={makeResource()} />);
    const iframe = document.querySelector('iframe');
    const sandbox = iframe?.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).toContain('allow-forms');
    expect(sandbox).not.toContain('allow-same-origin');
    unmount();
  });
});

describe('<McpAppIframe> — postMessage bridge', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'language', {
      value: 'en-US',
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds to ui/initialize with theme + containerDimensions + locale (adapter boundary, no bootstrap prop)', async () => {
    const { unmount } = render(
      <McpAppIframe
        resource={makeResource()}
        theme={{ '--color-primary': '#00ff00' }}
        locale="fr-FR"
        containerDimensions={{ width: 320, height: 240 }}
      />,
    );
    const capture = captureHostToIframe();
    await simulateFromIframe({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' });
    const response = capture.calls[0] as { result?: Record<string, unknown> };
    expect(Object.keys(response.result ?? {}).sort()).toEqual([
      'containerDimensions',
      'locale',
      'theme',
    ]);
    expect(response.result?.theme).toEqual({ '--color-primary': '#00ff00' });
    expect(response.result?.locale).toBe('fr-FR');
    expect(response.result?.containerDimensions).toEqual({ width: 320, height: 240 });
    // Default-posture invariant: no toolOutput / no _meta.
    expect(response.result).not.toHaveProperty('toolOutput');
    expect(response.result).not.toHaveProperty('_meta');
    capture.cleanup();
    unmount();
  });

  it('forwards bootstrap via toolOutput._meta.ggui.bootstrap when the bootstrap prop is set (Reading B)', async () => {
    const { unmount } = render(
      <McpAppIframe
        resource={makeResource()}
        theme={{ '--color-primary': '#aabbcc' }}
        locale="en-GB"
        containerDimensions={{ width: 1024, height: 768 }}
        bootstrap={SAMPLE_BOOTSTRAP}
      />,
    );
    const capture = captureHostToIframe();
    await simulateFromIframe({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' });
    // Setting `bootstrap` on mount also fires a one-shot
    // `ui/notifications/tool-result` (the late-arrival path), so
    // `capture.calls` may contain that notification before the
    // ui/initialize response. Pick the response by id rather than by
    // index.
    const response = capture.calls.find(
      (c): c is { id: number; result?: Record<string, unknown> } =>
        typeof c === 'object' && c !== null && (c as { id?: unknown }).id === 1,
    );
    if (!response) throw new Error('ui/initialize response not captured');
    const result = response.result as Record<string, unknown>;
    // Adapter-boundary fields still present.
    expect(result['theme']).toEqual({ '--color-primary': '#aabbcc' });
    expect(result['locale']).toBe('en-GB');
    expect(result['containerDimensions']).toEqual({ width: 1024, height: 768 });
    // toolOutput threaded through carrying ggui.bootstrap.
    const toolOutput = result['toolOutput'] as Record<string, unknown>;
    const meta = toolOutput['_meta'] as Record<string, unknown>;
    const ggui = meta['ggui'] as Record<string, unknown>;
    expect(ggui['bootstrap']).toEqual(SAMPLE_BOOTSTRAP);
    capture.cleanup();
    unmount();
  });

  it('responds to ping with ok+pong', async () => {
    const { unmount } = render(<McpAppIframe resource={makeResource()} />);
    const capture = captureHostToIframe();
    await simulateFromIframe({ jsonrpc: '2.0', id: 9, method: 'ping' });
    expect(capture.calls[0]).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: { ok: true, pong: true },
    });
    capture.cleanup();
    unmount();
  });

  it('ui/open-link with https URL calls window.open', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { unmount } = render(<McpAppIframe resource={makeResource()} />);
    const capture = captureHostToIframe();
    await simulateFromIframe({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/open-link',
      params: { url: 'https://example.com/buy' },
    });
    expect(windowOpen).toHaveBeenCalledWith(
      'https://example.com/buy',
      '_blank',
      'noopener,noreferrer',
    );
    const response = capture.calls[0] as { result?: unknown };
    expect(response.result).toEqual({ opened: true });
    capture.cleanup();
    unmount();
  });

  it('ui/open-link with javascript: scheme is rejected', async () => {
    const { unmount } = render(<McpAppIframe resource={makeResource()} />);
    const capture = captureHostToIframe();
    await simulateFromIframe({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/open-link',
      params: { url: 'javascript:alert(1)' },
    });
    const response = capture.calls[0] as { error?: { code: number; message: string } };
    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toBe('unsupported-scheme');
    capture.cleanup();
    unmount();
  });

  it('tools/call forwards to onToolCall', async () => {
    const onToolCall = vi.fn(async (_tool: string, _args: Record<string, unknown>) => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    const { unmount } = render(
      <McpAppIframe resource={makeResource()} onToolCall={onToolCall} />,
    );
    const capture = captureHostToIframe();
    await simulateFromIframe({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'checkout', arguments: { amount: 4200 } },
    });
    expect(onToolCall).toHaveBeenCalledWith('checkout', { amount: 4200 });
    const response = capture.calls[0] as { result?: Record<string, unknown> };
    expect(response.result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    capture.cleanup();
    unmount();
  });

  it('tools/call without onToolCall → no-tool-handler', async () => {
    const { unmount } = render(<McpAppIframe resource={makeResource()} />);
    const capture = captureHostToIframe();
    await simulateFromIframe({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'checkout' },
    });
    const response = capture.calls[0] as { error?: { code: number; message: string } };
    expect(response.error?.code).toBe(-32000);
    expect(response.error?.message).toBe('no-tool-handler');
    capture.cleanup();
    unmount();
  });

  it('unknown method → method_not_supported', async () => {
    const { unmount } = render(<McpAppIframe resource={makeResource()} />);
    const capture = captureHostToIframe();
    await simulateFromIframe({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/does-not-exist',
    });
    const response = capture.calls[0] as { error?: { code: number; message: string } };
    expect(response.error?.code).toBe(-32601);
    expect(response.error?.message).toBe('method_not_supported');
    capture.cleanup();
    unmount();
  });
});

describe('<McpAppIframe> — renderer envelopes', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'language', {
      value: 'en-US',
      configurable: true,
    });
  });

  it('ggui:bootstrap-failed → onError with ProtocolError {kind:"bootstrap"}', async () => {
    const onError = vi.fn();
    const { unmount } = render(
      <McpAppIframe resource={makeResource()} onError={onError} />,
    );
    await simulateFromIframe({
      type: 'ggui:bootstrap-failed',
      reason: 'WS_HANDSHAKE_FAILED',
      message: 'boot-err-42',
    });
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[0];
    expect(err?.kind).toBe('bootstrap');
    expect(err?.reason).toBe('WS_HANDSHAKE_FAILED');
    expect(err?.message).toBe('boot-err-42');
    unmount();
  });

  it('ggui:observe → onObserve with event', async () => {
    const onObserve = vi.fn();
    const { unmount } = render(
      <McpAppIframe resource={makeResource()} onObserve={onObserve} />,
    );
    await simulateFromIframe({
      type: 'ggui:observe',
      event: {
        kind: 'wired-tool-invoked',
        toolName: 'submit',
        dispatchedAt: '2026-04-23T00:00:00Z',
      },
    });
    expect(onObserve).toHaveBeenCalledTimes(1);
    const event = onObserve.mock.calls[0]?.[0];
    expect(event?.kind).toBe('wired-tool-invoked');
    expect(event?.toolName).toBe('submit');
    unmount();
  });

  it('ggui:lifecycle → mirrors state to outer DOM AND fires onLifecycle', async () => {
    const onLifecycle = vi.fn();
    const { unmount } = render(
      <McpAppIframe resource={makeResource()} onLifecycle={onLifecycle} />,
    );

    // Before any envelope arrives, the outer iframe MUST NOT carry the
    // lifecycle mirror attribute — observers distinguish "no posting
    // yet" from any classified state.
    let iframe = document.querySelector('iframe');
    expect(iframe?.hasAttribute('data-ggui-mcp-app-iframe-lifecycle')).toBe(false);

    // Renderer posts `mounting` first.
    await simulateFromIframe({
      type: 'ggui:lifecycle',
      event: { state: 'mounting' },
    });
    iframe = document.querySelector('iframe');
    expect(iframe?.getAttribute('data-ggui-mcp-app-iframe-lifecycle')).toBe(
      'mounting',
    );
    expect(onLifecycle).toHaveBeenCalledTimes(1);
    expect(onLifecycle.mock.calls[0]?.[0]).toEqual({ state: 'mounting' });

    // Then `code-ready` — outer attribute updates, host stays mounted.
    await simulateFromIframe({
      type: 'ggui:lifecycle',
      event: { state: 'code-ready' },
    });
    iframe = document.querySelector('iframe');
    expect(iframe?.getAttribute('data-ggui-mcp-app-iframe-lifecycle')).toBe(
      'code-ready',
    );
    expect(onLifecycle).toHaveBeenCalledTimes(2);
    expect(onLifecycle.mock.calls[1]?.[0]).toEqual({ state: 'code-ready' });

    unmount();
  });

  it('ggui:lifecycle with malformed envelope is silently dropped (no mirror update, no callback)', async () => {
    const onLifecycle = vi.fn();
    const { unmount } = render(
      <McpAppIframe resource={makeResource()} onLifecycle={onLifecycle} />,
    );

    // Establish a known mirror state first.
    await simulateFromIframe({
      type: 'ggui:lifecycle',
      event: { state: 'mounting' },
    });
    expect(
      document
        .querySelector('iframe')
        ?.getAttribute('data-ggui-mcp-app-iframe-lifecycle'),
    ).toBe('mounting');

    // Malformed envelope (unknown state) → MUST be dropped silently
    // per the trust-boundary posture. Mirror stays at 'mounting',
    // onLifecycle does NOT fire a second time.
    await simulateFromIframe({
      type: 'ggui:lifecycle',
      event: { state: 'spinning' },
    });
    expect(
      document
        .querySelector('iframe')
        ?.getAttribute('data-ggui-mcp-app-iframe-lifecycle'),
    ).toBe('mounting');
    expect(onLifecycle).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('ggui:lifecycle forwards stackItemId + error fields on the callback', async () => {
    const onLifecycle = vi.fn();
    const { unmount } = render(
      <McpAppIframe resource={makeResource()} onLifecycle={onLifecycle} />,
    );

    await simulateFromIframe({
      type: 'ggui:lifecycle',
      event: {
        state: 'error',
        stackItemId: 'item_a',
        error: { code: 'WS_HANDSHAKE_FAILED', message: 'boom' },
      },
    });

    expect(onLifecycle).toHaveBeenCalledTimes(1);
    const event = onLifecycle.mock.calls[0]?.[0];
    expect(event?.state).toBe('error');
    expect(event?.stackItemId).toBe('item_a');
    expect(event?.error).toEqual({
      code: 'WS_HANDSHAKE_FAILED',
      message: 'boom',
    });
    // Outer mirror still set even when the typed cause is forwarded.
    expect(
      document
        .querySelector('iframe')
        ?.getAttribute('data-ggui-mcp-app-iframe-lifecycle'),
    ).toBe('error');
    unmount();
  });

  it('ggui:lifecycle mirrors to outer DOM even when no onLifecycle callback is bound', async () => {
    const { unmount } = render(<McpAppIframe resource={makeResource()} />);
    await simulateFromIframe({
      type: 'ggui:lifecycle',
      event: { state: 'code-ready' },
    });
    expect(
      document
        .querySelector('iframe')
        ?.getAttribute('data-ggui-mcp-app-iframe-lifecycle'),
    ).toBe('code-ready');
    unmount();
  });

  it('ggui:upgrade-required → onUpgradeRequired AND onError {kind:"version"}', async () => {
    const onUpgradeRequired = vi.fn();
    const onError = vi.fn();
    const { unmount } = render(
      <McpAppIframe
        resource={makeResource()}
        onUpgradeRequired={onUpgradeRequired}
        onError={onError}
      />,
    );
    await simulateFromIframe({
      type: 'ggui:upgrade-required',
      server: '2.0.0',
      client: ['1.0.0', '1.1.0'],
    });
    expect(onUpgradeRequired).toHaveBeenCalledWith('2.0.0', ['1.0.0', '1.1.0']);
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[0];
    expect(err?.kind).toBe('version');
    expect(err?.serverVersion).toBe('2.0.0');
    expect(err?.clientSupports).toEqual(['1.0.0', '1.1.0']);
    unmount();
  });
});

describe('<McpAppIframe> — lifecycle', () => {
  it('posts ui/resource-teardown on unmount BEFORE DOM removal', async () => {
    const { unmount } = render(<McpAppIframe resource={makeResource()} />);
    // Spy on postMessage BEFORE unmount — the ref-callback null phase
    // fires DURING commit while the cached contentWindow is still
    // addressable, so spying is the reliable signal (listener-on-
    // contentWindow misses because jsdom may detach the window before
    // the `message` event dispatches).
    const iframe = document.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const win = iframe!.contentWindow!;
    const postSpy = vi.spyOn(win, 'postMessage');
    await act(async () => {
      unmount();
    });
    const call = postSpy.mock.calls.find((args) => {
      const msg = args[0] as { method?: unknown };
      return msg?.method === 'ui/resource-teardown';
    });
    expect(call).toBeDefined();
    const [payload, targetOrigin] = call!;
    expect(targetOrigin).toBe('*');
    expect(payload).toEqual(buildResourceTeardownNotification());
    // Notifications MUST NOT carry an `id` per JSON-RPC 2.0.
    expect('id' in (payload as object)).toBe(false);
  });
});

describe('<McpAppIframe> — imperative ref', () => {
  it('dispatchAction posts a JSON-RPC notification to the iframe', async () => {
    const ref = createRef<McpAppIframeRef>();
    const { unmount } = render(<McpAppIframe ref={ref} resource={makeResource()} />);
    const capture = captureHostToIframe();
    await act(async () => {
      ref.current?.dispatchAction('test.action', { a: 1 });
    });
    await flush();
    expect(capture.calls[0]).toEqual(
      buildDispatchActionNotification('test.action', { a: 1 }),
    );
    capture.cleanup();
    unmount();
  });
});
