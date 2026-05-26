import { describe, it, expect, vi } from 'vitest';
import { metaToMcpAppMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
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
        _meta: metaToMcpAppMeta(VALID_META),
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
          _meta: metaToMcpAppMeta(pinnedMeta),
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
          _meta: metaToMcpAppMeta(pinnedMeta),
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
