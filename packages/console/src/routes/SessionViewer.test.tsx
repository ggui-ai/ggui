/**
 * `SessionViewer` — jsdom proofs for the cookie → resource →
 * `<McpAppIframe>` pipeline.
 *
 * Plan §C9.5 deliverable 3 (Wave 2). The viewer rewrite in commit 2
 * (800e9527) routes every live session through `<McpAppIframe>`
 * instead of the in-process `<GguiSession>` tree. These tests pin
 * the console's wiring around the iframe host; the iframe's own
 * host-bridge protocol is tested by `<McpAppIframe>`'s own tests
 * (packages/ggui-react/src/McpAppIframe/McpAppIframe.test.tsx).
 *
 * What jsdom CAN prove here (and what these tests anchor on):
 *
 *   - Step 1 — POST /ggui/console/session-cookie with the short-code
 *     mints a cookie-session response that drives the state machine
 *     into `loading-resource`.
 *   - Step 2 — GET /ggui/console/session-resource?session=<id> fires
 *     with the cookie-derived session id; the response's
 *     `contents[0]` lands on `<McpAppIframe resource={...}>`.
 *   - `onObserve` callback routes renderer-emitted observability
 *     events into the activity ring buffer (five kinds: four known +
 *     unknown extensibly-closed fallback).
 *   - `onError` routes a ProtocolError into the error pane.
 *   - Test-action form fires `dispatchAction(name, data)` on the
 *     iframe ref.
 *   - Resource-fetch failure transitions the state machine to
 *     `resource-failed` and renders the failure copy.
 *
 * `<McpAppIframe>` itself is mocked at the module boundary so these
 * tests stay focused on the viewer's wiring contract, not the
 * iframe's internal dispatch. The mock exposes hooks for the tests
 * to pull observe / error emissions into the component under test.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  forwardRef,
  useImperativeHandle,
  type ReactElement,
} from 'react';

// ── Mock `<McpAppIframe>` at the `@ggui-ai/react` boundary ──────────
//
// We keep the mock narrow: just enough surface for the viewer's
// wiring tests. The mock records every resource prop it was handed,
// exposes its observe / error handlers via module-level hooks, and
// surfaces a real `dispatchAction` mock through the forwarded ref.
//
// The viewer also re-exports `ProtocolError` from `@ggui-ai/react`
// as a TYPE, not a value — so the mock only needs to cover the
// runtime `McpAppIframe` value + the `McpAppIframeProps` /
// `McpAppIframeRef` type exports (types are erased at runtime so
// we don't need to stub them).

interface McpAppIframeRefMock {
  readonly dispatchAction: (name: string, data: unknown) => void;
}

interface McpAppIframePropsMock {
  readonly resource: { readonly uri: string; readonly mimeType: string; readonly text: string };
  readonly bootstrap?: {
    readonly wsUrl: string;
    readonly token: string;
    readonly expiresAt: string;
    readonly sessionId: string;
    readonly appId: string;
    readonly runtimeUrl: string;
  };
  readonly onObserve?: (event: { readonly kind: string } & Record<string, unknown>) => void;
  readonly onError?: (err: {
    readonly kind: string;
    readonly [field: string]: unknown;
  }) => void;
}

const iframeHandles: {
  current: {
    resource: McpAppIframePropsMock['resource'] | null;
    bootstrap: McpAppIframePropsMock['bootstrap'] | null;
    onObserve: McpAppIframePropsMock['onObserve'] | null;
    onError: McpAppIframePropsMock['onError'] | null;
    dispatchAction: ReturnType<typeof vi.fn>;
  };
} = {
  current: {
    resource: null,
    bootstrap: null,
    onObserve: null,
    onError: null,
    dispatchAction: vi.fn(),
  },
};

function resetIframeHandles(): void {
  iframeHandles.current = {
    resource: null,
    bootstrap: null,
    onObserve: null,
    onError: null,
    dispatchAction: vi.fn(),
  };
}

vi.mock('@ggui-ai/react', () => {
  const McpAppIframe = forwardRef<McpAppIframeRefMock, McpAppIframePropsMock>(
    function MockMcpAppIframe(props, ref): ReactElement {
      iframeHandles.current.resource = props.resource;
      iframeHandles.current.bootstrap = props.bootstrap ?? null;
      iframeHandles.current.onObserve = props.onObserve ?? null;
      iframeHandles.current.onError = props.onError ?? null;
      useImperativeHandle(
        ref,
        () => ({
          dispatchAction: iframeHandles.current.dispatchAction,
        }),
        [],
      );
      return (
        <div
          data-testid="mock-mcp-app-iframe"
          data-resource-uri={props.resource.uri}
          data-bootstrap-session={props.bootstrap?.sessionId ?? ''}
        />
      );
    },
  );
  return { McpAppIframe };
});

// Import the viewer AFTER the mock registration. Vitest's vi.mock is
// hoisted, so the order inside the test file is cosmetic — but
// keeping the import below the mock call mirrors the setup pattern
// every other console test uses.
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
 * calls (cookie / resource / bootstrap / stack). Callers can override
 * any stub for failure-path tests.
 *
 * Reading B per `docs/principles/renderer-as-portable-runtime.md`
 * §6.2: the viewer fetches the production thin-shell HTML, the
 * bootstrap JSON, and the inspector stack snapshot in parallel,
 * then mounts `<McpAppIframe resource + bootstrap>` plus the
 * per-entry stack inspector pane. Resource + bootstrap failure
 * blocks the iframe; stack failure degrades gracefully (empty
 * inspector pane, iframe still mounts).
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
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/ggui/console/session-cookie')) {
      if (cookie) return cookie();
      return jsonResponse({
        sessionId: 'sess-xyz',
        appId: 'app-demo',
        expiresAt: Date.now() + 3600_000,
      });
    }
    // session-bootstrap matched BEFORE session-resource because the
    // former is a longer prefix of the same namespace; without this
    // ordering, `session-resource` would shadow it.
    if (url.includes('/ggui/console/session-bootstrap')) {
      if (bootstrap) return bootstrap();
      return jsonResponse({
        bootstrap: {
          wsUrl: 'wss://test.example/ws',
          token: 'mock-token',
          expiresAt: '2099-12-31T23:59:59.999Z',
          sessionId: 'sess-xyz',
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
            uri: 'ui://ggui/session',
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
  resetIframeHandles();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Mount pipeline ──────────────────────────────────────────────────

describe('SessionViewer — mount pipeline', () => {
  it('fetches cookie → (resource + bootstrap in parallel), then mounts <McpAppIframe> with both', async () => {
    installFetchMock();
    render(<SessionViewer shortCode="scode0001" />);

    // Iframe mounts only after ALL THREE fetches resolve (cookie →
    // {resource, bootstrap} in parallel) and we reach the `ready`
    // state. waitFor handles the async transitions.
    await waitFor(() => {
      expect(screen.getByTestId('mock-mcp-app-iframe')).toBeTruthy();
    });

    // Resource is the production thin-shell HTML wrapped as
    // ResourceContents (Reading B per renderer-as-portable-runtime
    // §6.2).
    expect(iframeHandles.current.resource).toEqual({
      uri: 'ui://ggui/session',
      mimeType: 'text/html;profile=mcp-app',
      text: '<html><body data-ggui-shell="thin">shell</body></html>',
    });
    // Bootstrap is forwarded onto `<McpAppIframe bootstrap>`. The
    // host threads it through `ui/initialize`'s
    // `toolOutput._meta.ggui.bootstrap`.
    expect(iframeHandles.current.bootstrap).toEqual({
      wsUrl: 'wss://test.example/ws',
      token: 'mock-token',
      expiresAt: '2099-12-31T23:59:59.999Z',
      sessionId: 'sess-xyz',
      appId: 'app-demo',
      runtimeUrl: '/_ggui/iframe-runtime.js',
    });
    // Selector hooks the Playwright lane targets (resource URI is
    // the production constant now; bootstrap-session anchors on the
    // forwarded sessionId).
    expect(
      screen.getByTestId('mock-mcp-app-iframe').getAttribute('data-resource-uri'),
    ).toBe('ui://ggui/session');
    expect(
      screen.getByTestId('mock-mcp-app-iframe').getAttribute('data-bootstrap-session'),
    ).toBe('sess-xyz');
  });

  it('shows the not-found card when the short-code cookie mint returns 404', async () => {
    installFetchMock({
      cookie: async () =>
        new Response('not found', { status: 404 }),
    });
    render(<SessionViewer shortCode="missing" />);
    await waitFor(() => {
      expect(screen.getByText(/short-code not found/i)).toBeTruthy();
    });
    expect(screen.queryByTestId('mock-mcp-app-iframe')).toBeNull();
  });

  it('transitions to resource-failed when the session-resource fetch returns 503', async () => {
    installFetchMock({
      resource: async () =>
        new Response(
          JSON.stringify({ error: 'mcp_apps_disabled' }),
          { status: 503 },
        ),
    });
    render(<SessionViewer shortCode="scode0002" />);
    await waitFor(() => {
      expect(
        screen.getByText(/session resource unavailable/i),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(/session-resource fetch returned 503/i),
    ).toBeTruthy();
    expect(screen.queryByTestId('mock-mcp-app-iframe')).toBeNull();
  });

  it('transitions to resource-failed when contents[] is empty', async () => {
    installFetchMock({
      resource: async () => jsonResponse({ contents: [] }),
    });
    render(<SessionViewer shortCode="scode0003" />);
    await waitFor(() => {
      expect(
        screen.getByText(/empty contents array/i),
      ).toBeTruthy();
    });
  });

  it('transitions to resource-failed when the session-bootstrap fetch returns 503', async () => {
    installFetchMock({
      bootstrap: async () =>
        new Response(
          JSON.stringify({ error: 'mcp_apps_disabled' }),
          { status: 503 },
        ),
    });
    render(<SessionViewer shortCode="scode0004" />);
    await waitFor(() => {
      expect(
        screen.getByText(/session resource unavailable/i),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(/session-bootstrap fetch returned 503/i),
    ).toBeTruthy();
    expect(screen.queryByTestId('mock-mcp-app-iframe')).toBeNull();
  });

  it('transitions to resource-failed when the session-bootstrap response is missing the bootstrap field', async () => {
    installFetchMock({
      bootstrap: async () => jsonResponse({}),
    });
    render(<SessionViewer shortCode="scode0005" />);
    await waitFor(() => {
      expect(screen.getByText(/missing `bootstrap` field/i)).toBeTruthy();
    });
    expect(screen.queryByTestId('mock-mcp-app-iframe')).toBeNull();
  });
});

// ── Observability routing ──────────────────────────────────────────

describe('SessionViewer — onObserve → activity ring buffer', () => {
  async function mountAndWaitForIframe(): Promise<void> {
    installFetchMock();
    render(<SessionViewer shortCode="scode-obs" />);
    await waitFor(() => {
      expect(iframeHandles.current.onObserve).toBeTruthy();
    });
  }

  /**
   * Helper — pull every `observe`-kind row from the activity list.
   * Each row stamps `data-ggui-console-activity-kind="observe"` on
   * the `<li>`; filtering by attribute sidesteps the duplicate-text
   * false-positive (row label `event.kind` also appears inside the
   * preview `<code>` block).
   */
  function observeRows(): readonly HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-ggui-console-activity-row][data-ggui-console-activity-kind="observe"]',
      ),
    );
  }

  it('routes wired-tool-invoked into an observe row', async () => {
    await mountAndWaitForIframe();
    const fireObserve = iframeHandles.current.onObserve;
    if (!fireObserve) throw new Error('onObserve handler not captured');

    act(() => {
      fireObserve({
        kind: 'wired-tool-invoked',
        toolName: 'tasks.create',
        dispatchedAt: '2026-04-23T00:00:00Z',
      });
    });

    await waitFor(() => {
      expect(observeRows()).toHaveLength(1);
    });
    const row = observeRows()[0];
    if (!row) throw new Error('observe row missing');
    expect(row.textContent).toContain('wired-tool-invoked');
    // The counter segment surfaces the ring-buffer length.
    expect(screen.getByText(/1 event$/)).toBeTruthy();
  });

  it('routes contract-error-emitted with signal tone', async () => {
    await mountAndWaitForIframe();
    const fireObserve = iframeHandles.current.onObserve;
    if (!fireObserve) throw new Error('onObserve handler not captured');

    act(() => {
      fireObserve({
        kind: 'contract-error-emitted',
        code: 'TOOL_THREW',
        toolName: 'tasks.create',
      });
    });

    await waitFor(() => {
      expect(observeRows()).toHaveLength(1);
    });
    const row = observeRows()[0];
    if (!row) throw new Error('observe row missing');
    expect(row.textContent).toContain('contract-error-emitted');
    // Tone — signal renders via StatusBadge; we verify the DOM
    // preserves the kind string rather than asserting exact tone
    // class (those are brand-stylesheet concerns).
    expect(row.textContent).toContain('TOOL_THREW');
  });

  it('routes schema-version-mismatch', async () => {
    await mountAndWaitForIframe();
    const fireObserve = iframeHandles.current.onObserve;
    if (!fireObserve) throw new Error('onObserve handler not captured');

    act(() => {
      fireObserve({
        kind: 'schema-version-mismatch',
        observedVersion: '2.0.0',
        acceptedVersions: ['1.0.0'],
        observedBy: 'client',
      });
    });

    await waitFor(() => {
      expect(observeRows()).toHaveLength(1);
    });
    const row = observeRows()[0];
    if (!row) throw new Error('observe row missing');
    expect(row.textContent).toContain('schema-version-mismatch');
  });

  it('routes subscribe-failed', async () => {
    await mountAndWaitForIframe();
    const fireObserve = iframeHandles.current.onObserve;
    if (!fireObserve) throw new Error('onObserve handler not captured');

    act(() => {
      fireObserve({
        kind: 'subscribe-failed',
        reason: 'transient-network-jitter',
      });
    });

    await waitFor(() => {
      expect(observeRows()).toHaveLength(1);
    });
    const row = observeRows()[0];
    if (!row) throw new Error('observe row missing');
    expect(row.textContent).toContain('subscribe-failed');
  });

  it('renders an unknown observability kind via the extensibly-closed fallback', async () => {
    await mountAndWaitForIframe();
    const fireObserve = iframeHandles.current.onObserve;
    if (!fireObserve) throw new Error('onObserve handler not captured');

    act(() => {
      fireObserve({
        kind: 'brand-new-kind-the-console-does-not-know',
        detail: { arbitrary: 'fields', allowed: true },
      });
    });

    await waitFor(() => {
      expect(observeRows()).toHaveLength(1);
    });
    const row = observeRows()[0];
    if (!row) throw new Error('observe row missing');
    // Row label is still `event.kind` — no special-casing.
    expect(row.textContent).toContain('brand-new-kind-the-console-does-not-know');
    // The iframe remains mounted — unknown events don't crash.
    expect(screen.getByTestId('mock-mcp-app-iframe')).toBeTruthy();
  });

  it('stacks multiple observe events in the ring buffer', async () => {
    await mountAndWaitForIframe();
    const fireObserve = iframeHandles.current.onObserve;
    if (!fireObserve) throw new Error('onObserve handler not captured');

    act(() => {
      fireObserve({ kind: 'wired-tool-invoked', toolName: 't1', dispatchedAt: 'a' });
    });
    act(() => {
      fireObserve({ kind: 'wired-tool-invoked', toolName: 't2', dispatchedAt: 'b' });
    });
    act(() => {
      fireObserve({ kind: 'subscribe-failed', reason: 'x' });
    });

    await waitFor(() => {
      expect(observeRows()).toHaveLength(3);
    });
    expect(screen.getByText(/3 events$/)).toBeTruthy();
  });
});

// ── onError routing ────────────────────────────────────────────────

describe('SessionViewer — onError → error pane', () => {
  it('renders the IframeErrorPane for a bootstrap ProtocolError', async () => {
    installFetchMock();
    render(<SessionViewer shortCode="scode-err" />);
    await waitFor(() => {
      expect(iframeHandles.current.onError).toBeTruthy();
    });

    act(() => {
      iframeHandles.current.onError?.({
        kind: 'bootstrap',
        reason: 'TOKEN_EXPIRED',
        message: 'Bootstrap token expired before renderer could attach',
      });
    });

    // The error pane carries a unique data-attribute anchor.
    await waitFor(() => {
      expect(
        document.querySelector('[data-ggui-console-iframe-error]'),
      ).toBeTruthy();
    });
    const pane = document.querySelector<HTMLElement>(
      '[data-ggui-console-iframe-error]',
    );
    if (!pane) throw new Error('error pane missing');
    expect(pane.textContent).toContain('bootstrap');
    expect(pane.textContent).toContain(
      'Bootstrap token expired before renderer could attach',
    );
  });

  it('formats a contract-kind ProtocolError through nested payload.error.code', async () => {
    installFetchMock();
    render(<SessionViewer shortCode="scode-ctr-err" />);
    await waitFor(() => {
      expect(iframeHandles.current.onError).toBeTruthy();
    });

    act(() => {
      iframeHandles.current.onError?.({
        kind: 'contract',
        payload: {
          toolName: 'tasks.create',
          actionName: 'create',
          error: {
            code: 'TOOL_THREW',
            message: 'Tool execution failed',
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        document.querySelector('[data-ggui-console-iframe-error]'),
      ).toBeTruthy();
    });
    const pane = document.querySelector<HTMLElement>(
      '[data-ggui-console-iframe-error]',
    );
    if (!pane) throw new Error('error pane missing');
    expect(pane.textContent).toContain('contract-error TOOL_THREW');
    expect(pane.textContent).toContain('Tool execution failed');
  });
});

// ── Test-action form ────────────────────────────────────────────────

describe('SessionViewer — test-action form', () => {
  async function mountAndWaitForIframe(): Promise<void> {
    installFetchMock();
    render(<SessionViewer shortCode="scode-test" />);
    await waitFor(() => {
      expect(screen.getByTestId('mock-mcp-app-iframe')).toBeTruthy();
    });
  }

  it('fires iframeRef.dispatchAction with the form name + parsed JSON payload', async () => {
    await mountAndWaitForIframe();

    const nameInput = screen.getByLabelText(
      /action name/i,
    ) as HTMLInputElement;
    const payloadInput = screen.getByLabelText(
      /payload \(JSON\)/i,
    ) as HTMLTextAreaElement;
    const submit = screen.getByRole('button', { name: /fire →/i });

    fireEvent.change(nameInput, { target: { value: 'tasks.complete' } });
    fireEvent.change(payloadInput, {
      target: { value: '{"id":"task-42","done":true}' },
    });
    fireEvent.click(submit);

    expect(iframeHandles.current.dispatchAction).toHaveBeenCalledTimes(1);
    expect(iframeHandles.current.dispatchAction).toHaveBeenCalledWith(
      'tasks.complete',
      { id: 'task-42', done: true },
    );
  });

  it('surfaces a parse error when the payload JSON is malformed and does NOT fire dispatchAction', async () => {
    await mountAndWaitForIframe();

    const nameInput = screen.getByLabelText(
      /action name/i,
    ) as HTMLInputElement;
    const payloadInput = screen.getByLabelText(
      /payload \(JSON\)/i,
    ) as HTMLTextAreaElement;
    const submit = screen.getByRole('button', { name: /fire →/i });

    fireEvent.change(nameInput, { target: { value: 'x' } });
    fireEvent.change(payloadInput, {
      target: { value: '{ not json }' },
    });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/parse error/i)).toBeTruthy();
    });
    expect(iframeHandles.current.dispatchAction).not.toHaveBeenCalled();
  });

  it('disables the fire button when the name field is empty', async () => {
    await mountAndWaitForIframe();
    const submit = screen.getByRole('button', {
      name: /fire →/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});
