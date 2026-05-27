/**
 * `SessionViewer` — jsdom proofs for the cookie → resource → srcdoc
 * iframe pipeline.
 *
 * The viewer is a READ-ONLY operator preview surface. It mounts a
 * same-origin `<iframe srcDoc>` carrying the production thin-shell
 * HTML, then replies to the shell's spec-canonical `ui/initialize`
 * postMessage with the slice envelope it fetched server-side. There
 * is NO `<AppRenderer>`, NO sandbox-proxy, NO operator-driven test-
 * fire form. Interactive surfaces own dispatch; the console viewer
 * just visualizes.
 *
 * What jsdom CAN prove here (and what these tests anchor on):
 *
 *   - Step 1 — POST /ggui/console/session-cookie with the short-code
 *     mints a cookie-session response that drives the state machine
 *     into `loading-resource`.
 *   - Step 2 — GET /ggui/console/session-resource?session=<id>,
 *     /ggui/console/sessions/:id/meta, and /ggui/console/session-stack
 *     fire in parallel; the resource's `contents[0].text` lands on
 *     the iframe's `srcdoc`, the meta slice replies to `ui/initialize`.
 *   - `ui/initialize` postMessage from the iframe's contentWindow
 *     receives a JSON-RPC reply whose
 *     `result.toolOutput._meta["ai.ggui/render"]` matches the fetched
 *     meta (spec Path-B inline-meta delivery).
 *   - Resource-fetch failure transitions the state machine to
 *     `resource-failed` and renders the failure copy.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// Import the viewer. No external module-boundary mocks — the viewer
// has no React-side iframe-host dependency to stub now that
// `<McpAppIframe>` / `<AppRenderer>` is no longer in the chain.
import { SessionViewer } from './SessionViewer.js';

// ── Test helpers ────────────────────────────────────────────────────

type FetchArgs = Parameters<typeof fetch>;
type FetchImpl = (...args: FetchArgs) => Promise<Response>;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/**
 * Install a fetch mock that answers the four endpoints the viewer
 * calls (cookie / resource / meta / stack). Callers can override
 * any stub for failure-path tests.
 */
function installFetchMock({
  cookie,
  resource,
  bootstrap,
  stack,
}: {
  readonly cookie?: () => Promise<Response>;
  readonly resource?: () => Promise<Response>;
  readonly bootstrap?: () => Promise<Response>;
  readonly stack?: () => Promise<Response>;
} = {}): ReturnType<typeof vi.fn<FetchImpl>> {
  const fetchSpy = vi.fn<FetchImpl>(async (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes('/ggui/console/session-cookie')) {
      if (cookie) return cookie();
      return jsonResponse({
        sessionId: 'sess-xyz',
        appId: 'app-demo',
        expiresAt: Date.now() + 3600_000,
      });
    }
    // sessions/:id/meta matched BEFORE session-resource because the
    // former is a longer prefix; without this ordering session-resource
    // would shadow it.
    if (url.includes('/ggui/console/sessions/') && url.endsWith('/meta')) {
      if (bootstrap) return bootstrap();
      return jsonResponse({
        'ai.ggui/render': {
          wsUrl: 'wss://test.example/ws',
          wsToken: 'mock-token',
          expiresAt: '2099-12-31T23:59:59.999Z',
          renderId: 'sess-xyz',
          appId: 'app-demo',
          runtimeUrl: '/_ggui/iframe-runtime.js',
        },
      });
    }
    if (url.includes('/ggui/console/session-stack')) {
      if (stack) return stack();
      return jsonResponse({
        stack: [],
        currentStackIndex: -1,
        eventSequence: 0,
      });
    }
    if (url.includes('/ggui/console/session-resource')) {
      if (resource) return resource();
      return jsonResponse({
        contents: [
          {
            uri: 'ui://ggui/render',
            mimeType: 'text/html;profile=mcp-app',
            text: '<html><body data-ggui-shell="thin">shell</body></html>',
          },
        ],
      });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

beforeEach(() => {
  // Each test gets a clean DOM + fetch mock.
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Mount pipeline ──────────────────────────────────────────────────

describe('SessionViewer — mount pipeline', () => {
  it('fetches cookie → (resource + meta + stack in parallel), then mounts srcdoc iframe with the shell HTML', async () => {
    installFetchMock();
    render(<SessionViewer shortCode="scode0001" />);

    const iframe = await waitFor(() => {
      const el = screen.getByTestId('session-viewer-iframe');
      if (!(el instanceof HTMLIFrameElement)) {
        throw new Error('session-viewer-iframe is not an <iframe>');
      }
      return el;
    });

    // srcdoc carries the production thin-shell HTML (the resource
    // endpoint's `contents[0].text`).
    expect(iframe.getAttribute('srcdoc')).toContain(
      'data-ggui-shell="thin"',
    );
    // sandbox attr is set; we keep `allow-scripts` so the shell's
    // inline bootstrap runs. `allow-same-origin` is intentionally
    // omitted (defense in depth).
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('replies to the shell\'s ui/initialize postMessage with the slice-envelope toolOutput._meta', async () => {
    installFetchMock();
    render(<SessionViewer shortCode="scode-init" />);

    const iframe = await waitFor(() => {
      const el = screen.getByTestId('session-viewer-iframe');
      if (!(el instanceof HTMLIFrameElement)) {
        throw new Error('session-viewer-iframe is not an <iframe>');
      }
      return el;
    });

    // jsdom doesn't actually navigate the srcdoc iframe + load
    // GGUI_SESSION_SHELL_HTML, so we can't observe a real shell-
    // initiated postMessage. Instead we drive the wire directly:
    // simulate the shell's `ui/initialize` request by dispatching a
    // MessageEvent whose `source` matches `iframe.contentWindow`,
    // then capture the viewer's reply by spying on
    // `iframe.contentWindow.postMessage`.
    const contentWindow = iframe.contentWindow;
    if (!contentWindow) throw new Error('iframe.contentWindow missing');

    const replies: Array<unknown> = [];
    const originalPostMessage = contentWindow.postMessage.bind(contentWindow);
    contentWindow.postMessage = ((message: unknown) => {
      replies.push(message);
      // Forward to original so jsdom's own dispatching stays
      // consistent if a future test cares.
      try {
        originalPostMessage(message as never, '*');
      } catch {
        /* jsdom is sometimes strict — best-effort forward */
      }
    }) as typeof contentWindow.postMessage;

    // Simulate the shell's `postRpc('ui/initialize', ...)` envelope.
    window.dispatchEvent(
      new MessageEvent('message', {
        source: contentWindow,
        data: {
          jsonrpc: '2.0',
          id: 1,
          method: 'ui/initialize',
          params: {
            appCapabilities: {},
            appInfo: { name: 'ggui-session', version: '1.0.0' },
            protocolVersion: '2026-01-26',
          },
        },
      }),
    );

    await waitFor(() => {
      expect(replies.length).toBeGreaterThan(0);
    });
    const reply = replies[0] as {
      jsonrpc?: string;
      id?: number;
      result?: {
        toolOutput?: {
          _meta?: {
            'ai.ggui/render'?: {
              renderId?: string;
              runtimeUrl?: string;
            };
          };
        };
      };
    };
    expect(reply.jsonrpc).toBe('2.0');
    expect(reply.id).toBe(1);
    const renderSlice = reply.result?.toolOutput?._meta?.['ai.ggui/render'];
    expect(renderSlice).toBeTruthy();
    expect(renderSlice?.renderId).toBe('sess-xyz');
    expect(renderSlice?.runtimeUrl).toBe('/_ggui/iframe-runtime.js');
  });

  it('ignores non-ui/initialize postMessages', async () => {
    installFetchMock();
    render(<SessionViewer shortCode="scode-noise" />);

    const iframe = await waitFor(() => {
      const el = screen.getByTestId('session-viewer-iframe');
      if (!(el instanceof HTMLIFrameElement)) {
        throw new Error('session-viewer-iframe is not an <iframe>');
      }
      return el;
    });
    const contentWindow = iframe.contentWindow;
    if (!contentWindow) throw new Error('iframe.contentWindow missing');
    const replies: Array<unknown> = [];
    contentWindow.postMessage = ((message: unknown) => {
      replies.push(message);
    }) as typeof contentWindow.postMessage;

    // Ignored: wrong method.
    window.dispatchEvent(
      new MessageEvent('message', {
        source: contentWindow,
        data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} },
      }),
    );
    // Ignored: wrong source (not the iframe).
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { jsonrpc: '2.0', id: 2, method: 'ui/initialize', params: {} },
      }),
    );
    // Ignored: not JSON-RPC.
    window.dispatchEvent(
      new MessageEvent('message', {
        source: contentWindow,
        data: 'hello',
      }),
    );

    // Give React a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(replies).toEqual([]);
  });

  it('shows the not-found card when the short-code cookie mint returns 404', async () => {
    installFetchMock({
      cookie: async () => new Response('not found', { status: 404 }),
    });
    render(<SessionViewer shortCode="missing" />);
    await waitFor(() => {
      expect(screen.getByText(/short-code not found/i)).toBeTruthy();
    });
    expect(screen.queryByTestId('session-viewer-iframe')).toBeNull();
  });

  it('transitions to resource-failed when the session-resource fetch returns 503', async () => {
    installFetchMock({
      resource: async () =>
        new Response(JSON.stringify({ error: 'mcp_apps_disabled' }), {
          status: 503,
        }),
    });
    render(<SessionViewer shortCode="scode0002" />);
    await waitFor(() => {
      expect(screen.getByText(/session resource unavailable/i)).toBeTruthy();
    });
    expect(
      screen.getByText(/session-resource fetch returned 503/i),
    ).toBeTruthy();
    expect(screen.queryByTestId('session-viewer-iframe')).toBeNull();
  });

  it('transitions to resource-failed when contents[] is empty', async () => {
    installFetchMock({
      resource: async () => jsonResponse({ contents: [] }),
    });
    render(<SessionViewer shortCode="scode0003" />);
    await waitFor(() => {
      expect(screen.getByText(/empty contents array/i)).toBeTruthy();
    });
  });

  it('transitions to resource-failed when the sessions/:id/meta fetch returns 503', async () => {
    installFetchMock({
      bootstrap: async () =>
        new Response(JSON.stringify({ error: 'mcp_apps_disabled' }), {
          status: 503,
        }),
    });
    render(<SessionViewer shortCode="scode0004" />);
    await waitFor(() => {
      expect(screen.getByText(/session resource unavailable/i)).toBeTruthy();
    });
    expect(
      screen.getByText(/sessions\/:id\/meta fetch returned 503/i),
    ).toBeTruthy();
    expect(screen.queryByTestId('session-viewer-iframe')).toBeNull();
  });

  it('transitions to resource-failed when the sessions/:id/meta response is missing the render slice', async () => {
    installFetchMock({
      bootstrap: async () => jsonResponse({}),
    });
    render(<SessionViewer shortCode="scode0005" />);
    await waitFor(() => {
      expect(
        screen.getByText(/missing `ai\.ggui\/render` slice/i),
      ).toBeTruthy();
    });
    expect(screen.queryByTestId('session-viewer-iframe')).toBeNull();
  });
});
