/**
 * Host-lifecycle + host-context forwarding tests for
 * `McpAppsStackItemRenderer`.
 *
 * Covers:
 *   - `ui/initialize` response forwards theme / containerDimensions /
 *     locale, and defaults when the host leaves them unset.
 *   - The adapter boundary: outer ggui session state (stack / actionSpec
 *     / streamSpec) is NEVER included in the `ui/initialize` result —
 *     MCP Apps iframes only see a narrow, locked context.
 *   - Messages from DIFFERENT frames are ignored (only the hosted
 *     iframe's contentWindow is honored).
 *   - Unmount fires a host-initiated `ui/resource-teardown` notification
 *     at the iframe BEFORE it is removed from the DOM.
 *   - Non-JSON-RPC messages + unsupported methods respond with
 *     `method_not_supported` (-32601) — never crash the host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { McpAppsStackItem } from '@ggui-ai/protocol/integrations/mcp-apps';
import { McpAppsStackItemRenderer } from './McpAppsStackItemRenderer';

function makeItem(overrides?: Partial<McpAppsStackItem>): McpAppsStackItem {
  return {
    type: 'mcpApps',
    id: 'item-1',
    createdAt: '2026-04-19T00:00:00Z',
    source: {
      connectorId: 'stripe',
      toolName: 'checkout',
      resourceUri: 'ui://stripe/checkout',
    },
    ...overrides,
  };
}

interface CapturedResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Capture `postMessage` calls the host makes to the iframe.
 *
 * jsdom's built-in `window.postMessage` on an iframe's contentWindow
 * dispatches a real `message` event on that same window. Rather than
 * replacing the method, we listen for those events and record them.
 * This is closer to real browser semantics and survives any framework-
 * level caching of the method binding.
 */
function captureHostToIframeMessages(): {
  calls: unknown[];
  cleanup: () => void;
} {
  const iframe = document.querySelector('iframe');
  if (!iframe) throw new Error('iframe not yet mounted');
  const win = iframe.contentWindow;
  if (!win) throw new Error('iframe has no contentWindow');
  const calls: unknown[] = [];
  const handler = (ev: MessageEvent) => calls.push(ev.data);
  win.addEventListener('message', handler);
  return {
    calls,
    cleanup: () => win.removeEventListener('message', handler),
  };
}

/**
 * Flush every pending microtask + the jsdom postMessage task queue.
 * `iframe.contentWindow.postMessage` is async per spec — jsdom queues
 * the dispatch on a task. We drain the queue with a macrotask hop.
 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Simulate a postMessage from the iframe back up to the host window.
 * We fire a MessageEvent whose `source` is the iframe's contentWindow —
 * that's what the renderer's handler checks before trusting the payload.
 */
async function simulateFromIframe(
  data: Record<string, unknown>,
): Promise<void> {
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
  // The host's response postMessage goes through jsdom's async dispatch
  // path; flush before any assertions read from the captured calls.
  await flush();
}

describe('McpAppsStackItemRenderer — host-context forwarding', () => {
  beforeEach(() => {
    // jsdom has no real navigator.language in every environment, pin it.
    Object.defineProperty(navigator, 'language', {
      value: 'en-US',
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds to ui/initialize with theme + containerDimensions + locale', async () => {
    const { unmount } = render(
      <McpAppsStackItemRenderer
        stackItem={makeItem({
          containerDimensions: { width: 640, height: 480, maxWidth: 800 },
        })}
        sessionId="sess-1"
        theme={{ '--color-primary': '#ff0000' }}
        locale="fr-FR"
      />,
    );
    const cap = captureHostToIframeMessages();
    await simulateFromIframe({
      jsonrpc: '2.0',
      id: 42,
      method: 'ui/initialize',
    });
    expect(cap.calls.length).toBe(1);
    const response = cap.calls[0] as CapturedResponse;
    expect(response.id).toBe(42);
    expect(response.result).toBeDefined();
    const result = response.result!;
    expect(result.theme).toEqual({ '--color-primary': '#ff0000' });
    expect(result.locale).toBe('fr-FR');
    expect(result.containerDimensions).toEqual({
      width: 640,
      height: 480,
      maxWidth: 800,
      maxHeight: undefined,
    });
    cap.cleanup();
    unmount();
  });

  it('falls back to default theme + navigator.language when host omits them', async () => {
    const { unmount } = render(
      <McpAppsStackItemRenderer stackItem={makeItem()} sessionId="sess-1" />,
    );
    const cap = captureHostToIframeMessages();
    await simulateFromIframe({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
    });
    const response = cap.calls[0] as CapturedResponse;
    const result = response.result!;
    // Default theme contains at least a color-primary token.
    expect(result.theme).toHaveProperty('--color-primary');
    // Falls through to navigator.language (pinned to 'en-US' in beforeEach).
    expect(result.locale).toBe('en-US');
    cap.cleanup();
    unmount();
  });

  it('ADAPTER BOUNDARY: ui/initialize does NOT forward stack / session state to the iframe', async () => {
    const { unmount } = render(
      <McpAppsStackItemRenderer stackItem={makeItem()} sessionId="sess-1" />,
    );
    const cap = captureHostToIframeMessages();
    await simulateFromIframe({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
    });
    const response = cap.calls[0] as CapturedResponse;
    const result = response.result!;
    // Narrow context surface — anything beyond these three keys would
    // widen the iframe's view of outer ggui state.
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(['containerDimensions', 'locale', 'theme']);
    // Specifically: no stack / actionSpec / streamSpec / session leak.
    for (const forbidden of [
      'stack',
      'actionSpec',
      'streamSpec',
      'propsSpec',
      'sessionId',
      'appId',
      'currentStackIndex',
    ]) {
      expect(result).not.toHaveProperty(forbidden);
    }
    cap.cleanup();
    unmount();
  });

  it('ignores messages from frames that are not the hosted iframe', async () => {
    const { unmount } = render(
      <McpAppsStackItemRenderer stackItem={makeItem()} sessionId="sess-1" />,
    );
    const cap = captureHostToIframeMessages();
    // Dispatch a ui/initialize whose `source` is NOT the iframe's window.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { jsonrpc: '2.0', id: 1, method: 'ui/initialize' },
          // `source: null` is the case when a MessageEvent is synthesized
          // without a Window ref; it must not be trusted.
          source: null,
          origin: 'http://localhost',
        }),
      );
    });
    expect(cap.calls.length).toBe(0);
    cap.cleanup();
    unmount();
  });

  it('responds to unknown methods with -32601 method_not_supported', async () => {
    const { unmount } = render(
      <McpAppsStackItemRenderer stackItem={makeItem()} sessionId="sess-1" />,
    );
    const cap = captureHostToIframeMessages();
    await simulateFromIframe({
      jsonrpc: '2.0',
      id: 9,
      method: 'ui/request-display-mode',
      params: { mode: 'fullscreen' },
    });
    const response = cap.calls[0] as CapturedResponse;
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32601);
    expect(response.error?.message).toBe('method_not_supported');
    cap.cleanup();
    unmount();
  });

  it('silently drops malformed / non-JSON-RPC messages (no response)', async () => {
    const { unmount } = render(
      <McpAppsStackItemRenderer stackItem={makeItem()} sessionId="sess-1" />,
    );
    const cap = captureHostToIframeMessages();
    await simulateFromIframe({ not: 'a jsonrpc message' });
    await simulateFromIframe({ jsonrpc: '1.0', method: 'ui/initialize' });
    expect(cap.calls.length).toBe(0);
    cap.cleanup();
    unmount();
  });
});

describe('McpAppsStackItemRenderer — host-initiated teardown', () => {
  it('posts ui/resource-teardown notification to the iframe on unmount', () => {
    // We replace the iframe's `postMessage` with a synchronous spy
    // BEFORE unmount. The detach ref-callback fires during commit (while
    // the iframe is still in the DOM), calls `postMessage` on the cached
    // contentWindow, and we record the invocation immediately. This
    // sidesteps jsdom's async `message`-event dispatch which isn't
    // reliable when the target Window is being discarded in the same
    // turn.
    const { unmount } = render(
      <McpAppsStackItemRenderer stackItem={makeItem()} sessionId="sess-1" />,
    );
    const iframe = document.querySelector('iframe');
    if (!iframe || !iframe.contentWindow) {
      throw new Error('iframe + contentWindow required');
    }
    const win = iframe.contentWindow;
    const postSpy = vi.fn();
    Object.defineProperty(win, 'postMessage', {
      value: postSpy,
      writable: true,
      configurable: true,
    });
    unmount();
    // Detach ref fires synchronously during commit — the spy must
    // have been called exactly once by the time unmount() returns.
    expect(postSpy).toHaveBeenCalledTimes(1);
    const [payload, targetOrigin] = postSpy.mock.calls[0] ?? [];
    expect(targetOrigin).toBe('*');
    const msg = payload as {
      jsonrpc: string;
      method: string;
      params?: { reason?: string };
      id?: unknown;
    };
    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.method).toBe('ui/resource-teardown');
    expect(msg.params?.reason).toBe('host_unmount');
    // Notifications MUST NOT carry an `id` per JSON-RPC 2.0.
    expect('id' in msg).toBe(false);
  });
});

describe('McpAppsStackItemRenderer — iframe wiring', () => {
  it('points the iframe src at the ggui server /mcp-apps/resource route', () => {
    const { container } = render(
      <McpAppsStackItemRenderer
        stackItem={makeItem()}
        sessionId="sess-1"
        serverBaseUrl="https://ggui.example"
      />,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute('src')).toBe(
      'https://ggui.example/mcp-apps/resource?session=sess-1&item=item-1',
    );
    expect(iframe?.getAttribute('sandbox')).toContain('allow-scripts');
    expect(iframe?.getAttribute('data-ggui-mcp-apps')).toBe('iframe');
    expect(iframe?.getAttribute('data-ggui-connector-id')).toBe('stripe');
  });

  it('composes allow="..." from declared permissions', () => {
    const { container } = render(
      <McpAppsStackItemRenderer
        stackItem={makeItem({
          permissions: { camera: true, clipboardWrite: true },
        })}
        sessionId="sess-1"
      />,
    );
    const iframe = container.querySelector('iframe');
    const allow = iframe?.getAttribute('allow') ?? '';
    expect(allow).toContain("camera 'self'");
    expect(allow).toContain("clipboard-write 'self'");
    expect(allow).not.toContain('microphone');
    expect(allow).not.toContain('geolocation');
  });

  it('omits allow when no permissions were declared', () => {
    const { container } = render(
      <McpAppsStackItemRenderer stackItem={makeItem()} sessionId="sess-1" />,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe?.hasAttribute('allow')).toBe(false);
  });
});
