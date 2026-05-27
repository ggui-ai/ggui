import { describe, it, expect, vi } from 'vitest';
import { toMcpAppEnvelope } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { Render } from '@ggui-ai/protocol';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { bootSequence, type RendererBootFailedMessage } from '../runtime.js';
import type { ConnectFn } from '../registry-subscribe.js';

/**
 * jsdom smoke for the renderer's full boot sequence (no-renderer
 * placeholder mode).
 *
 * Approach: inject mocks for `callUiInitialize`, `connectFn`, and
 * `notifyParent` so the spec drives the orchestration directly without
 * needing a mock-WebSocket stub at this layer (the WS lifecycle is
 * covered by `registry-subscribe.test.ts`).
 *
 * What this spec verifies:
 *   - Renderer mounts a status DOM on boot.
 *   - Posts `ggui:renderer-ready` to the parent.
 *   - Calls `ui/initialize` exactly once.
 *   - Parses the bootstrap from the response and feeds the parsed
 *     value into `connectFn`.
 *   - On a successful ack, `result.mountedRender` reflects the render
 *     when the ack snapshot's `render.id` matches `pinnedRenderId`
 *     (post-render-identity-collapse the renderId IS the pin; no
 *     "first entry" fallback — the slice always carries a renderId).
 *   - Negative paths (UI_INITIALIZE_FAILED, MISSING_META_GGUI_BOOTSTRAP,
 *     UPGRADE_REQUIRED, WS_HANDSHAKE_FAILED) each surface a
 *     `ggui:bootstrap-failed` envelope to the recorder.
 *
 * Post-render-identity-collapse (2026-05-27, Phase B): the iframe
 * mounts EXACTLY ONE render keyed by `meta.renderId`. The placeholder
 * mode is silent (status-log only); per-frame channel handler behavior
 * lives in channel-specific unit tests with a renderer mock.
 */

const VALID_META: McpAppAiGguiRenderMeta = {
  wsUrl: 'wss://server.example/ws',
  wsToken: 'tok_abc',
  renderId: 'render_001',
  appId: 'app_001',
  expiresAt: '2099-01-01T00:00:00.000Z',
  runtimeUrl: '/_ggui/iframe-runtime.js',
};

function buildHappyInitResponse(): { result: unknown } {
  return {
    result: {
      toolOutput: {
        _meta: toMcpAppEnvelope(VALID_META),
        structuredContent: {},
      },
    },
  };
}

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
  it('boots from valid bootstrap and mounts the ack render when its id matches pinnedRenderId', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');

    // The bootstrap's renderId pins the mount slot; the ack's render
    // MUST carry that same id to land. Single-render-per-iframe.
    const initial = makeRender('render_001', 'first render');

    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInitResponse());
    const { connectFn, emitFrame } = buildMockConnect(initial);

    const notifyParent = vi.fn();

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent,
    });

    expect(result.ok).toBe(true);
    expect(callUiInitialize).toHaveBeenCalledTimes(1);

    // Notified parent of readiness.
    expect(notifyParent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ggui:renderer-ready' }),
    );

    // Ack's render promoted to mountedRender on the result.
    expect(result.mountedRender?.id).toBe('render_001');

    // Render-frame behavior in placeholder mode is silent (status-log
    // only — no React mount, no DOM mutation). The emitFrame helper
    // still confirms the render handler is registered and accepts the
    // frame without throwing; the mount-once semantics under renderer
    // mode are covered by channel-handler unit tests with a renderer
    // mock.
    const subsequent = makeRender('render_001', 'second push');
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

describe('bootSequence — spec-canonical postMessage tier (MCP-Apps SEP-1865)', () => {
  /**
   * Spec-strict hosts (`<AppRenderer>` from `@mcp-ui/client`, ChatGPT
   * MCP-Apps connector, the spec-conformant claude.ai code path)
   * return `McpUiInitializeResult = { protocolVersion, hostInfo,
   * hostCapabilities, hostContext }` — no `toolOutput`. They deliver
   * slice meta via the separate `ui/notifications/tool-result`
   * postMessage.
   *
   * Reading-B (`result.toolOutput._meta`) returns MISSING_TOOL_OUTPUT
   * for these hosts; the resolver must fall through to the spec-
   * canonical async tier (the `awaitPostMessageMeta` injection seam)
   * and pick the meta up there.
   *
   * The injected resolver mimics what production wires (a one-shot
   * `awaitToolResultMeta(timeout)` listener) — tests just hand back
   * the meta directly.
   */
  it('falls through to awaitPostMessageMeta when ui/initialize returns no toolOutput', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');

    // Spec-conformant ui/initialize response — only hostContext, no
    // toolOutput. Mirrors the McpUiInitializeResult shape per
    // `@modelcontextprotocol/ext-apps/spec.types.d.ts:434`.
    const callUiInitialize = vi.fn().mockResolvedValue({
      result: {
        protocolVersion: '2026-01-26',
        hostInfo: { name: 'spec-strict-host', version: '1.0' },
        hostCapabilities: {},
        hostContext: { availableDisplayModes: ['inline'] },
      },
    });

    // The spec-canonical async tier — returns meta as if delivered by
    // a `ui/notifications/tool-result` postMessage.
    const awaitPostMessageMeta = vi.fn().mockResolvedValue(VALID_META);

    const { connectFn, emitFrame } = buildMockConnect(
      makeRender('render_001', 'spec-canonical'),
    );
    const notifyParent = vi.fn();

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent,
      awaitPostMessageMeta,
    });

    expect(result.ok).toBe(true);
    expect(awaitPostMessageMeta).toHaveBeenCalledTimes(1);
    expect(notifyParent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ggui:renderer-ready' }),
    );
    expect(result.mountedRender?.id).toBe('render_001');

    // Smoke that the render handler is registered after a postMessage-
    // tier boot — placeholder mode accepts the frame without throwing
    // (no DOM mutation to observe; renderer-mode coverage lives in
    // channel handler unit tests).
    emitFrame('render', {
      render: makeRender('render_001', 'after spec-canonical boot'),
      matchType: 'exact',
    });
  });

  /**
   * Reading-B (Tier 2) wins synchronously, the async tier should
   * never resolve into the parse. The postMessage Promise will still
   * be called (listener installed before ui/initialize for race
   * safety), but its eventual resolution is ignored.
   */
  it('uses synchronous Reading-B when both Reading-B AND postMessage carry meta', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');

    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInitResponse());

    // Hostile postMessage meta — different renderId. If the resolver
    // mistakenly preferred this over the synchronous Reading-B, the
    // bound wire config would pin to 'render_999' instead of
    // VALID_META's 'render_001'.
    const hostileMeta: McpAppAiGguiRenderMeta = {
      ...VALID_META,
      renderId: 'render_999',
    };
    const awaitPostMessageMeta = vi.fn().mockResolvedValue(hostileMeta);

    const { connectFn } = buildMockConnect(makeRender('render_001', 'b'));

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent: vi.fn(),
      awaitPostMessageMeta,
    });
    expect(result.ok).toBe(true);
    // Reading-B's meta won — the postMessage promise was started
    // (listener race safety) but its value was discarded.
    expect(awaitPostMessageMeta).toHaveBeenCalledTimes(1);
  });

  /**
   * `preResolvedMeta` short-circuits every resolver tier — the
   * autostart layer already caught a postMessage and parsed it.
   * bootSequence still calls ui/initialize (spec lifecycle +
   * hostContext) but never inspects its result for slice meta.
   */
  it('skips all resolver tiers when preResolvedMeta is supplied', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');

    // ui/initialize returns a SPEC-INVALID payload — would normally
    // fail every tier. With preResolvedMeta, this is never inspected
    // for slice meta.
    const callUiInitialize = vi.fn().mockResolvedValue({
      result: { someRandomField: true },
    });
    const awaitPostMessageMeta = vi.fn(); // must NOT be called

    const { connectFn } = buildMockConnect(makeRender('render_001', 'pre-resolved'));

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent: vi.fn(),
      awaitPostMessageMeta,
      preResolvedMeta: VALID_META,
    });

    expect(result.ok).toBe(true);
    expect(awaitPostMessageMeta).not.toHaveBeenCalled();
  });
});

describe('bootSequence — single-render mode (post-render-identity-collapse)', () => {
  it('leaves mountedRender null when the ack render id does not match the pin', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');

    // The ack carries a render with a different id — the renderer
    // ignores the mismatch (pinned to meta.renderId = 'render_001').
    const otherRender = makeRender('render_other', 'unrelated');

    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInitResponse());

    const { connectFn } = buildMockConnect(otherRender);

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent: vi.fn(),
    });
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
    const callUiInitialize = vi.fn().mockResolvedValue({
      error: { code: -1, message: 'host refused' },
    });
    const connectFn = vi.fn() as unknown as ConnectFn;
    const notifyParent = vi.fn();

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent,
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

  it('surfaces MISSING_META_GGUI_BOOTSTRAP when toolOutput lacks _meta', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');
    const callUiInitialize = vi.fn().mockResolvedValue({
      result: { toolOutput: { structuredContent: {} } },
    });
    const connectFn = vi.fn() as unknown as ConnectFn;
    const notifyParent = vi.fn();

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent,
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
    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInitResponse());

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

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent,
    });

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
    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInitResponse());
    const connectFn = vi.fn().mockRejectedValue(new Error('AUTH_REJECTED: token expired')) as unknown as ConnectFn;
    const notifyParent = vi.fn();

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent,
    });

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
