import { describe, it, expect, vi } from 'vitest';
import { toMcpAppEnvelope } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { SessionStackEntry } from '@ggui-ai/protocol';
import type {
  McpAppAiGguiMeta,
  McpAppAiGguiSessionMeta,
  McpAppAiGguiStackItemMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { bootSequence, type RendererBootFailedMessage } from '../runtime.js';
import type { ConnectFn } from '../registry-subscribe.js';

/**
 * jsdom smoke for the renderer's full boot sequence.
 *
 * Approach: inject mocks for `callUiInitialize`, `connectFn`, and
 * `notifyParent` so the spec drives the orchestration directly without
 * needing a mock-WebSocket stub at this layer (the WS lifecycle is
 * covered by `registry-subscribe.test.ts`).
 *
 * What this spec verifies:
 *   - Renderer mounts a status DOM + an empty stack list on boot.
 *   - Posts `ggui:renderer-ready` to the parent.
 *   - Calls `ui/initialize` exactly once.
 *   - Parses the bootstrap from the response and feeds the parsed
 *     value into `connectFn`.
 *   - On a successful ack carrying initial stack, mounts a structural
 *     `<li data-ggui-stack-item="...">` per item.
 *   - On a subsequent push frame (delivered via the registry handler
 *     registered by the placeholder boot path), upserts the stack and
 *     re-renders.
 *
 * Negative paths (UI_INITIALIZE_FAILED, MISSING_META_GGUI_BOOTSTRAP,
 * UPGRADE_REQUIRED) each surface a `ggui:bootstrap-failed` envelope to
 * the recorder.
 */

const VALID_SESSION: McpAppAiGguiSessionMeta = {
  wsUrl: 'wss://server.example/ws',
  wsToken: 'tok_abc',
  sessionId: 'sess_001',
  appId: 'app_001',
  expiresAt: '2099-01-01T00:00:00.000Z',
  runtimeUrl: '/_ggui/iframe-runtime.js',
};

const VALID_META: McpAppAiGguiMeta = { session: VALID_SESSION };

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

function makeStackItem(id: string, description: string): SessionStackEntry {
  return {
    id,
    componentCode: '/* unused at C7a */',
    description,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build a `connectFn` that captures the registry it receives + exposes
 * an `emitFrame(type, payload)` helper for driving inbound frames
 * through the registered handlers post-bind. Returns the connectFn +
 * the emitter + a reference to the captured registry.
 */
function buildMockConnect(stack: SessionStackEntry[] | undefined): {
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
        ...(stack !== undefined ? { stack } : {}),
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
  it('boots from valid bootstrap, renders initial stack, and folds push frames', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');

    const initial = makeStackItem('item_a', 'first item');
    const pushed = makeStackItem('item_b', 'second item');

    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInitResponse());
    const { connectFn, emitFrame } = buildMockConnect([initial]);

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

    // Initial stack from the ack rendered.
    const itemEls = dom.querySelectorAll('[data-ggui-stack-item]');
    expect(itemEls).toHaveLength(1);
    expect(itemEls[0]?.getAttribute('data-ggui-stack-item')).toBe('item_a');

    // A subsequent push frame folds into the stack via the registered
    // push handler.
    emitFrame('push', { stackItem: pushed, matchType: 'exact' });

    const after = dom.querySelectorAll('[data-ggui-stack-item]');
    expect(after).toHaveLength(2);
    expect(after[1]?.getAttribute('data-ggui-stack-item')).toBe('item_b');

    // Status line shows connected with the correct count.
    const statusEl = dom.querySelector('[data-ggui-status]');
    expect(statusEl?.textContent).toMatch(/Connected \(2 items\)/);

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
    const awaitPostMessageMeta = vi.fn().mockResolvedValue({
      session: VALID_SESSION,
    });

    const { connectFn, emitFrame } = buildMockConnect([
      makeStackItem('item_a', 'spec-canonical'),
    ]);
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
    expect(dom.querySelector('[data-ggui-stack-item]')?.getAttribute('data-ggui-stack-item')).toBe('item_a');

    // Subsequent push folds normally — proves the WS handlers wired
    // off the postMessage-delivered meta.
    emitFrame('push', {
      stackItem: makeStackItem('item_b', 'after spec-canonical boot'),
      matchType: 'exact',
    });
    expect(dom.querySelectorAll('[data-ggui-stack-item]')).toHaveLength(2);
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

    // Hostile postMessage meta — different sessionId. If the resolver
    // mistakenly preferred this over the synchronous Reading-B, the
    // bound session.sessionId on the wire config would be 'sess_999'
    // instead of VALID_SESSION's 'sess_001'.
    const hostileSession: McpAppAiGguiSessionMeta = {
      ...VALID_SESSION,
      sessionId: 'sess_999',
    };
    const awaitPostMessageMeta = vi.fn().mockResolvedValue({
      session: hostileSession,
    });

    const { connectFn } = buildMockConnect([makeStackItem('item_a', 'b')]);

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent: vi.fn(),
      awaitPostMessageMeta,
    });
    expect(result.ok).toBe(true);
    // Reading-B's session won — the postMessage promise was started
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

    const { connectFn } = buildMockConnect([makeStackItem('item_z', 'pre-resolved')]);

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent: vi.fn(),
      awaitPostMessageMeta,
      preResolvedMeta: { session: VALID_SESSION },
    });

    expect(result.ok).toBe(true);
    expect(awaitPostMessageMeta).not.toHaveBeenCalled();
  });
});

describe('bootSequence — single-item mode (Phase 3 Wave 1 §S3)', () => {
  it('filters the initial stack to the bootstrap.stackItemId and ignores sibling pushes', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');

    const pinnedItem = makeStackItem('item_pinned', 'the pinned one');
    const otherItem = makeStackItem('item_other', 'sibling');

    const pinnedStackItem: McpAppAiGguiStackItemMeta = {
      stackItemId: 'item_pinned',
    };
    const pinnedMeta: McpAppAiGguiMeta = {
      session: VALID_SESSION,
      stackItem: pinnedStackItem,
    };

    const callUiInitialize = vi.fn().mockResolvedValue({
      result: {
        toolOutput: {
          _meta: toMcpAppEnvelope(pinnedMeta),
          structuredContent: {},
        },
      },
    });

    // Ack carries both items — the server subscribe is session-scoped
    // and delivers the full stack regardless of the renderer's per-item
    // pin.
    const { connectFn, emitFrame } = buildMockConnect([pinnedItem, otherItem]);

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent: vi.fn(),
    });
    expect(result.ok).toBe(true);

    // Initial ack filtered to the pinned item only.
    const itemEls = dom.querySelectorAll('[data-ggui-stack-item]');
    expect(itemEls).toHaveLength(1);
    expect(itemEls[0]?.getAttribute('data-ggui-stack-item')).toBe('item_pinned');

    // Subsequent sibling push is dropped (filter remains active).
    emitFrame('push', { stackItem: otherItem, matchType: 'exact' });
    expect(dom.querySelectorAll('[data-ggui-stack-item]')).toHaveLength(1);

    // A push targeting the pinned id replaces it (still one entry).
    emitFrame('push', {
      stackItem: makeStackItem('item_pinned', 'updated'),
      matchType: 'exact',
    });
    const after = dom.querySelectorAll('[data-ggui-stack-item]');
    expect(after).toHaveLength(1);
    expect(after[0]?.getAttribute('data-ggui-stack-item')).toBe('item_pinned');
  });

  it('renders an empty stack when the pinned id is absent from the ack', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');

    const ackOnlyItem = makeStackItem('item_only', 'unrelated');

    const pinnedMeta: McpAppAiGguiMeta = {
      session: VALID_SESSION,
      stackItem: { stackItemId: 'item_missing' },
    };

    const callUiInitialize = vi.fn().mockResolvedValue({
      result: {
        toolOutput: {
          _meta: toMcpAppEnvelope(pinnedMeta),
          structuredContent: {},
        },
      },
    });

    const { connectFn } = buildMockConnect([ackOnlyItem]);

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent: vi.fn(),
    });
    expect(result.ok).toBe(true);

    expect(dom.querySelectorAll('[data-ggui-stack-item]')).toHaveLength(0);
    expect(dom.querySelector('[data-ggui-empty]')?.getAttribute('data-ggui-empty')).toBe('true');
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

    const statusEl = dom.querySelector('[data-ggui-status]');
    expect(statusEl?.getAttribute('data-ggui-status')).toBe('error');
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
    const statusEl = dom.querySelector('[data-ggui-status]');
    expect(statusEl?.getAttribute('data-ggui-status')).toBe('upgrade-required');
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

describe('renderStack placeholders — empty state', () => {
  it('renders the empty placeholder when ack returns no stack', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');
    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInitResponse());
    const { connectFn } = buildMockConnect(undefined);
    const notifyParent = vi.fn();

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent,
    });

    expect(result.ok).toBe(true);
    const empty = dom.querySelector('[data-ggui-empty]');
    expect(empty?.textContent).toMatch(/no stack items/i);
  });
});
