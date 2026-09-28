/**
 * ggui#1415 runtime item 2 — once the boot slice is resolved, the runtime
 * removes the inline copies of the envelope the shell left behind: the
 * `__GGUI_META__` global, the pre-load tool-result buffer, and the shell's
 * envelope `<script>` element, whose text outlives the global. The key root
 * the view proves with is already held in the runtime's own closure.
 *
 * This is hygiene, not a boundary: card code runs in the same realm and can
 * still ask the host to read its own locator. It removes the free copies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GGUI_SHELL_META_MARKER,
  toMcpAppEnvelope,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { bootSequence } from '../runtime.js';
import type { ConnectFn } from '../registry-subscribe.js';
import { buildBootHarness, tick } from './boot-helpers.js';
import { createViewRootHolder } from '../view-root.js';

const KEY = 'K-7dUBMeCtprxv4DED-VUuAjEBHGqoaWA-hHgh5t12A';
const P = Buffer.from(
  JSON.stringify({ sessionId: 'render_001', appId: 'app_001', kind: 'ws', iat: 100, exp: 280, jti: 'j', kid: 'k', src: 'read' }),
  'utf8',
).toString('base64url');
const META: McpAppAiGguiRenderMeta = {
  wsUrl: 'wss://server.example/ws',
  wsToken: `${P}.c2ln`,
  viewKey: KEY,
  sessionId: 'render_001',
  appId: 'app_001',
  expiresAt: '2099-01-01T00:00:00.000Z',
  runtimeUrl: '/_ggui/iframe-runtime.js',
};

const connectFn: ConnectFn = async () => ({
  handle: { kind: 'ws' as const, status: 'open' as const, send: vi.fn(), start: vi.fn(), dispose: async () => {} },
  ack: { sequence: 1, timestamp: Date.now(), serverVersion: undefined },
});

interface InlineGlobals {
  __GGUI_META__?: unknown;
  __GGUI_PENDING_TOOL_RESULTS__?: unknown;
}
const inline = globalThis as InlineGlobals;

/** A document shaped like the self-contained shell's: the envelope script, then the runtime's. */
function shellDocument(): Document {
  const doc = document.implementation.createHTMLDocument('shell');
  const envelope = doc.createElement('script');
  envelope.textContent = `${GGUI_SHELL_META_MARKER}${JSON.stringify(toMcpAppEnvelope(META))};`;
  const runtime = doc.createElement('script');
  runtime.setAttribute('data-ggui-runtime', 'src');
  runtime.setAttribute('src', META.runtimeUrl);
  const unrelated = doc.createElement('script');
  unrelated.textContent = 'window.somethingElse = 1;';
  doc.body.append(envelope, runtime, unrelated);
  return doc;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, '__GGUI_META__');
  Reflect.deleteProperty(globalThis, '__GGUI_PENDING_TOOL_RESULTS__');
});

describe('bootSequence removes the inline envelope copies once the boot slice is resolved (ggui#1415)', () => {
  it('booting from the inline global: the global and the envelope script are gone, the root is held', async () => {
    inline.__GGUI_META__ = toMcpAppEnvelope(META);
    inline.__GGUI_PENDING_TOOL_RESULTS__ = [{ content: [], _meta: toMcpAppEnvelope(META) }];
    const doc = shellDocument();
    const viewRoots = createViewRootHolder();
    const { app, transport } = buildBootHarness();

    const result = await bootSequence({ doc, app, transport, connectFn, notifyParent: vi.fn(), toolResultTimeoutMs: 50, viewRoots });

    expect(result.ok).toBe(true);
    expect('__GGUI_META__' in globalThis).toBe(false);
    expect('__GGUI_PENDING_TOOL_RESULTS__' in globalThis).toBe(false);
    const scripts = Array.from(doc.querySelectorAll('script'));
    expect(scripts.some((s) => (s.textContent ?? '').includes(GGUI_SHELL_META_MARKER))).toBe(false);
    expect(doc.body.innerHTML).not.toContain(KEY);
    // The runtime's own tag and unrelated scripts stay.
    expect(doc.querySelector('script[data-ggui-runtime="src"]')).not.toBeNull();
    expect(scripts.some((s) => s.textContent === 'window.somethingElse = 1;')).toBe(true);
    expect(viewRoots.current('render_001')).toMatchObject({ root: P, key: KEY });
  });

  it('booting from a tool result: a global the shell set anyway is removed too', async () => {
    inline.__GGUI_META__ = { unrelated: true };
    const { app, transport, pushToolResult } = buildBootHarness();
    const bootPromise = bootSequence({
      doc: document.implementation.createHTMLDocument('shell'),
      app,
      transport,
      connectFn,
      notifyParent: vi.fn(),
      toolResultTimeoutMs: 500,
      viewRoots: createViewRootHolder(),
    });
    await tick();
    pushToolResult(META);
    expect((await bootPromise).ok).toBe(true);
    expect('__GGUI_META__' in globalThis).toBe(false);
  });
});
