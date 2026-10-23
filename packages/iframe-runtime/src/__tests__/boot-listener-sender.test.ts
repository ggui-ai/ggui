/**
 * ggui#2015: the pre-handshake tool-result listener acts only on messages
 * from the embedding window. Any frame that shares the top-level document
 * can reach this frame's WindowProxy and post into it, and before the
 * handshake nothing else binds a tool-result to the host — so the sender
 * is the binding, the same one the MCP Apps transport uses once the App
 * is constructed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toMcpAppEnvelope, type McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { awaitToolResultMeta, extractMetaFromToolResult } from '../runtime.js';

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
const SLICE_PARAMS = { content: [], _meta: toMcpAppEnvelope(META) };
const LOCATOR = 'ui://ggui/render/render_001/abcdef0123456789';
const LOCATOR_PARAMS = { structuredContent: { resourceUri: LOCATOR } };

function toolResult(params: unknown): object {
  return { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params };
}

function post(data: object, source: MessageEventSource | null): void {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
}

/** A promise's state read without awaiting it: the sentinel until it settles. */
function watch<T>(p: Promise<T>): () => T | 'unsettled' {
  let state: T | 'unsettled' = 'unsettled';
  void p.then((v) => {
    state = v;
  });
  return () => state;
}

let stranger: Window;
let frame: HTMLIFrameElement;

beforeEach(() => {
  vi.useFakeTimers();
  frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const w = frame.contentWindow;
  if (w === null) throw new Error('jsdom gave the stranger frame no window');
  stranger = w;
  expect(stranger, 'the fixture is a window other than the parent').not.toBe(window.parent);
});

afterEach(() => {
  frame.remove();
  vi.useRealTimers();
});

describe('awaitToolResultMeta acts on the embedding window only (ggui#2015)', () => {
  it('a slice-carrying tool-result from another frame, or with no source, does not settle; the parent\'s does', async () => {
    const read = watch(awaitToolResultMeta(1_000));
    post(toolResult(SLICE_PARAMS), stranger);
    post(toolResult(SLICE_PARAMS), null);
    await vi.advanceTimersByTimeAsync(10);
    expect(read()).toBe('unsettled');
    post(toolResult(SLICE_PARAMS), window.parent);
    await vi.advanceTimersByTimeAsync(0);
    expect(read()).toEqual({ kind: 'meta', boot: extractMetaFromToolResult(SLICE_PARAMS) });
  });

  it('an identity-only tool-result from another frame is ignored; the parent\'s locator settles', async () => {
    const read = watch(awaitToolResultMeta(1_000));
    post(toolResult(LOCATOR_PARAMS), stranger);
    await vi.advanceTimersByTimeAsync(10);
    expect(read()).toBe('unsettled');
    post(toolResult(LOCATOR_PARAMS), window.parent);
    await vi.advanceTimersByTimeAsync(0);
    expect(read()).toEqual({ kind: 'locator', locator: LOCATOR });
  });

  it('a stranger\'s message neither settles nor resets the bound: the wait still times out to null', async () => {
    const read = watch(awaitToolResultMeta(1_000));
    post(toolResult(SLICE_PARAMS), stranger);
    await vi.advanceTimersByTimeAsync(900);
    post(toolResult(SLICE_PARAMS), stranger);
    expect(read()).toBe('unsettled');
    await vi.advanceTimersByTimeAsync(101);
    expect(read()).toBeNull();
  });
});
