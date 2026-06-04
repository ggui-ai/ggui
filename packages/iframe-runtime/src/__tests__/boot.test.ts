import { describe, it, expect, vi } from 'vitest';
import type { Render } from '@ggui-ai/protocol';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { bootSequence, type RendererBootFailedMessage } from '../runtime.js';
import type { ConnectFn } from '../registry-subscribe.js';
import {
  buildBootHarness,
  buildHappyInitResult,
  tick,
} from './boot-helpers.js';

/**
 * jsdom smoke for the renderer's full boot sequence (no-renderer
 * placeholder mode), post-Phase-1.19b.3 App-class swap.
 *
 * Approach: inject `MockTransport` + a fresh `App` (via `buildBootHarness`)
 * and a mocked `connectFn` so the spec drives the orchestration directly
 * without needing a postMessage window or a mock-WebSocket stub
 * (the WS lifecycle is covered by `registry-subscribe.test.ts`).
 *
 * What this spec verifies:
 *   - Renderer mounts a status DOM on boot.
 *   - Posts `ggui:renderer-ready` to the parent.
 *   - App.connect completes the `ui/initialize` handshake exactly once.
 *   - Parses the bootstrap from the inline `__GGUI_META__` global OR
 *     the spec-canonical `ui/notifications/tool-result` notification
 *     and feeds the parsed value into `connectFn`.
 *   - On a successful ack, `result.mountedRender` reflects the render
 *     when the ack snapshot's `render.id` matches `pinnedRenderId`
 *     (post-render-identity-collapse the renderId IS the pin).
 *   - Negative paths (UI_INITIALIZE_FAILED, MISSING_META_GGUI_BOOTSTRAP,
 *     UPGRADE_REQUIRED, WS_HANDSHAKE_FAILED) each surface a
 *     `ggui:bootstrap-failed` envelope to the recorder.
 *
 * Post-1.19b.3 (2026-05-28): Reading-B (Tier 2: `result.toolOutput._meta`)
 * is RETIRED. The spec-canonical MCP-Apps `McpUiInitializeResult` does not
 * define `toolOutput` — every slice-meta delivery now flows through the
 * inline `__GGUI_META__` global OR the post-handshake
 * `ui/notifications/tool-result` notification.
 */

const VALID_META: McpAppAiGguiRenderMeta = {
  wsUrl: 'wss://server.example/ws',
  wsToken: 'tok_abc',
  renderId: 'render_001',
  appId: 'app_001',
  expiresAt: '2099-01-01T00:00:00.000Z',
  runtimeUrl: '/_ggui/iframe-runtime.js',
};

function makeRender(id: string, description: string): Render {
  return {
    id,
    appId: 'app_001',
    componentCode: '/* unused at C7a */',
    description,
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

/**
 * Build a `connectFn` that captures the registry it receives + exposes
 * an `emitFrame(type, payload)` helper for driving inbound frames
 * through the registered handlers post-bind. Returns the connectFn +
 * the emitter + a reference to the captured registry.
 */
function buildMockConnect(render: Render | undefined): {
  connectFn: ConnectFn;
  emitFrame: (type: string, payload: unknown) => void;
} {
  const registryRef: { current: import('@ggui-ai/live-channel').ChannelRegistry | null } = { current: null };
  const connectFn: ConnectFn = async (opts) => {
    registryRef.current = opts.registry;
    return {
      handle: {
        kind: 'ws' as const,
        status: 'open' as const,
        send: vi.fn(),
        start: vi.fn(),
        dispose: async () => {},
      },
      ack: {
        sequence: 1,
        timestamp: Date.now(),
        ...(render !== undefined ? { render } : {}),
        serverVersion: undefined,
      },
    };
  };
  const emitFrame = (type: string, payload: unknown): void => {
    const reg = registryRef.current;
    if (reg === null) return;
    const handler = reg.inspectHandlers().get(type);
    if (handler === undefined) return;
    void handler.onMessage(payload);
  };
  return { connectFn, emitFrame };
}

describe('bootSequence — happy path', () => {
  it('boots from a spec-canonical toolresult notification and mounts the ack render', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');

    // The bootstrap's renderId pins the mount slot; the ack's render
    // MUST carry that same id to land. Single-render-per-iframe.
    const initial = makeRender('render_001', 'first render');

    const { app, transport, pushToolResult } = buildBootHarness();
    const { connectFn, emitFrame } = buildMockConnect(initial);
    const notifyParent = vi.fn();

    const bootPromise = bootSequence({
      doc: dom,
      app,
      transport,
      connectFn,
      notifyParent,
      toolResultTimeoutMs: 500,
    });

    // Let the App's `transport.start()` hook up `onmessage` before we
    // push the notification — without this the push lands before the
    // listener is live and drops silently.
    await tick();
    pushToolResult(VALID_META);

    const result = await bootPromise;

    expect(result.ok).toBe(true);
    expect(transport.methodsSeen).toContain('ui/initialize');

    // Notified parent of readiness.
    expect(notifyParent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ggui:renderer-ready' }),
    );

    // Ack's render promoted to mountedRender on the result.
    expect(result.mountedRender?.id).toBe('render_001');

    // Render-frame behavior in placeholder mode is silent (status-log
    // only — no React mount, no DOM mutation). The emitFrame helper
    // still confirms the render handler is registered and accepts the
    // frame without throwing.
    const subsequent = makeRender('render_001', 'second render');
    emitFrame('render', { render: subsequent, matchType: 'exact' });

    // No failure message was sent.
    const failures = notifyParent.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((m: unknown): m is RendererBootFailedMessage => {
        return (
          m !== null &&
          typeof m === 'object' &&
          (m as { type?: unknown }).type === 'ggui:bootstrap-failed'
        );
      });
    expect(failures).toHaveLength(0);
  });
});

describe('bootSequence — preResolvedMeta short-circuit', () => {
  /**
   * `preResolvedMeta` short-circuits every resolver tier — the
   * autostart layer already caught a postMessage / inline global and
   * parsed it. bootSequence still calls `app.connect()` (spec lifecycle
   * + hostContext) but never waits on the toolresult listener.
   */
  it('skips all resolver tiers when preResolvedMeta is supplied', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');

    const { app, transport, pushToolResult } = buildBootHarness();
    const { connectFn } = buildMockConnect(makeRender('render_001', 'pre-resolved'));

    const bootPromise = bootSequence({
      doc: dom,
      app,
      transport,
      connectFn,
      notifyParent: vi.fn(),
      preResolvedMeta: VALID_META,
      toolResultTimeoutMs: 50,
    });
    // Push a HOSTILE toolresult — should be ignored entirely since
    // preResolvedMeta short-circuits the resolver chain.
    await tick();
    pushToolResult({ ...VALID_META, renderId: 'render_hostile' });

    const result = await bootPromise;
    expect(result.ok).toBe(true);
    expect(result.mountedRender?.id).toBe('render_001');
  });
});

describe('bootSequence — single-render mode (post-render-identity-collapse)', () => {
  it('leaves mountedRender null when the ack render id does not match the pin', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');

    // The ack carries a render with a different id — the renderer
    // ignores the mismatch (pinned to meta.renderId = 'render_001').
    const otherRender = makeRender('render_other', 'unrelated');

    const { app, transport, pushToolResult } = buildBootHarness();
    const { connectFn } = buildMockConnect(otherRender);

    const bootPromise = bootSequence({
      doc: dom,
      app,
      transport,
      connectFn,
      notifyParent: vi.fn(),
      toolResultTimeoutMs: 500,
    });
    await tick();
    pushToolResult(VALID_META);

    const result = await bootPromise;
    // Boot still succeeds — the mismatch isn't a failure (server may
    // have pruned the pinned render). `mountedRender` stays null until
    // a subsequent render-frame for the pinned id lands.
    expect(result.ok).toBe(true);
    expect(result.mountedRender).toBeNull();
  });
});

describe('bootSequence — failure paths', () => {
  it('surfaces UI_INITIALIZE_FAILED when the host returns an error', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');
    const { app, transport } = buildBootHarness({
      initResponse: {
        error: { code: -1, message: 'host refused' },
      },
    });
    const connectFn = vi.fn() as unknown as ConnectFn;
    const notifyParent = vi.fn();

    const result = await bootSequence({
      doc: dom,
      app,
      transport,
      connectFn,
      notifyParent,
      toolResultTimeoutMs: 50,
    });

    expect(result.ok).toBe(false);
    expect(connectFn).not.toHaveBeenCalled();
    expect(notifyParent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ggui:bootstrap-failed',
        reason: 'UI_INITIALIZE_FAILED',
      }),
    );
  });

  it('surfaces MISSING_META_GGUI_BOOTSTRAP when no slice meta arrives via inline OR toolresult', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');
    const { app, transport } = buildBootHarness();
    const connectFn = vi.fn() as unknown as ConnectFn;
    const notifyParent = vi.fn();

    const result = await bootSequence({
      doc: dom,
      app,
      transport,
      connectFn,
      notifyParent,
      // Short timeout — no toolresult pushed, so the listener bails fast.
      toolResultTimeoutMs: 50,
    });

    expect(result.ok).toBe(false);
    expect(connectFn).not.toHaveBeenCalled();
    expect(notifyParent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ggui:bootstrap-failed',
        reason: 'MISSING_META_GGUI_BOOTSTRAP',
      }),
    );
  });

  it('surfaces UPGRADE_REQUIRED when connectFn rejects with a typed UpgradeRequiredError', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');
    const { app, transport, pushToolResult } = buildBootHarness();

    // Build a duck-typed UpgradeRequiredError-shaped throw — the
    // runtime guard checks `name === 'UpgradeRequiredError'` + `code
    // === 'UPGRADE_REQUIRED'` rather than instanceof. Matches what the
    // real protocol package emits.
    const upgradeErr = Object.assign(new Error('protocol mismatch v9001'), {
      name: 'UpgradeRequiredError',
      code: 'UPGRADE_REQUIRED',
    });
    const connectFn = vi.fn().mockRejectedValue(upgradeErr) as unknown as ConnectFn;
    const notifyParent = vi.fn();

    const bootPromise = bootSequence({
      doc: dom,
      app,
      transport,
      connectFn,
      notifyParent,
      toolResultTimeoutMs: 500,
    });
    await tick();
    pushToolResult(VALID_META);

    const result = await bootPromise;

    expect(result.ok).toBe(false);
    expect(notifyParent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ggui:bootstrap-failed',
        reason: 'UPGRADE_REQUIRED',
      }),
    );
  });

  it('surfaces WS_HANDSHAKE_FAILED on a generic connectFn rejection', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');
    const { app, transport, pushToolResult } = buildBootHarness();
    const connectFn = vi.fn().mockRejectedValue(new Error('AUTH_REJECTED: token expired')) as unknown as ConnectFn;
    const notifyParent = vi.fn();

    const bootPromise = bootSequence({
      doc: dom,
      app,
      transport,
      connectFn,
      notifyParent,
      toolResultTimeoutMs: 500,
    });
    await tick();
    pushToolResult(VALID_META);

    const result = await bootPromise;

    expect(result.ok).toBe(false);
    expect(notifyParent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ggui:bootstrap-failed',
        reason: 'WS_HANDSHAKE_FAILED',
        message: expect.stringContaining('AUTH_REJECTED'),
      }),
    );
  });
});

// Re-export for downstream module consumers that imported via boot.test
// before the rewrite. Not used directly here.
export { buildHappyInitResult };
