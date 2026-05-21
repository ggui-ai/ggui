/**
 * `BlueprintViewer` — jsdom proofs for the fetch → mount pipeline.
 *
 * What jsdom CAN prove (and what these tests anchor on):
 *   - The fetch path targets `/ggui/console/blueprint/:id` with a
 *     URL-encoded id.
 *   - Load / error / not-found / ready states paint their respective
 *     DOM shells.
 *   - On a 200 response the mount card stamps the expected
 *     `data-ggui-stack-entry="component"` + `data-ggui-code-ready="true"`
 *     anchors + `data-ggui-blueprint-id` selector hook (the canonical
 *     data-attr contract shared across in-process renderer surfaces).
 *
 * What jsdom CAN'T prove (called out so future sessions don't overreach):
 *   - The actual React-component mount via `import(blob:...)`. jsdom
 *     lacks `URL.createObjectURL` + blob-URL dynamic import. The
 *     happy-path
 *     browser-level mount is asserted by the Lane-1 Playwright spec
 *     against a real Chromium page. Here we pin the handoff-DOM
 *     (the `data-ggui-code-ready="true"` slot gets painted), not
 *     the mount completion.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { BlueprintViewer } from './BlueprintViewer.js';

// The `StackItemRenderer` path invokes `URL.createObjectURL` on the
// componentCode blob; jsdom doesn't ship it. Stub it here — the
// compiled blob-URL load fails under jsdom, which is fine since we
// only assert on the enclosing `data-ggui-*` anchors.
beforeEach(() => {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:blueprint-viewer-test'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

type FetchArgs = Parameters<typeof fetch>;

describe('BlueprintViewer — fetch path', () => {
  it('targets /ggui/console/blueprint/:id with a URL-encoded id', async () => {
    const fetchSpy = vi.fn<(...args: FetchArgs) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            blueprintId: 'weather-card-fixture',
            blueprintName: 'Weather Card Fixture',
            code: 'export default function W(){return null;}',
            contentType: 'application/javascript+react',
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    render(<BlueprintViewer blueprintId="weather-card-fixture" />);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    const firstCall = fetchSpy.mock.calls[0];
    expect(firstCall?.[0]).toBe(
      '/ggui/console/blueprint/weather-card-fixture',
    );
  });

  it('URL-encodes ids that contain slashes or other special chars', async () => {
    const fetchSpy = vi.fn<(...args: FetchArgs) => Promise<Response>>(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    render(<BlueprintViewer blueprintId="my/scoped@id" />);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const firstCall = fetchSpy.mock.calls[0];
    // encodeURIComponent('my/scoped@id') → 'my%2Fscoped%40id'.
    expect(firstCall?.[0]).toBe(
      '/ggui/console/blueprint/my%2Fscoped%40id',
    );
  });
});

describe('BlueprintViewer — render states', () => {
  it('shows the loading state before the fetch resolves', () => {
    // Never-resolving fetch — the component stays in `loading`.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    const { container } = render(<BlueprintViewer blueprintId="any" />);
    expect(container.textContent).toContain('Loading blueprint…');
    // No mount card during loading.
    expect(
      container.querySelector('[data-ggui-stack-entry="component"]'),
    ).toBeNull();
  });

  it('shows the not-found card on a 404 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    const { container } = render(<BlueprintViewer blueprintId="missing" />);
    await waitFor(() => {
      expect(container.textContent).toContain('Blueprint not found');
    });
    expect(container.textContent).toContain('missing');
    // No mount card for a missing blueprint.
    expect(
      container.querySelector('[data-ggui-stack-entry="component"]'),
    ).toBeNull();
  });

  it('shows the error card on a non-2xx/non-404 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    const { container } = render(<BlueprintViewer blueprintId="boom" />);
    await waitFor(() => {
      expect(container.textContent).toContain("Couldn't load blueprint");
    });
    expect(container.textContent).toContain('server returned 500');
  });

  it('paints the mount card with the canonical data-ggui-* anchors on a 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              blueprintId: 'weather-card-fixture',
              blueprintName: 'Weather Card Fixture',
              code: 'export default function Weather(){return null;}',
              contentType: 'application/javascript+react',
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    );
    const { container } = render(
      <BlueprintViewer blueprintId="weather-card-fixture" />,
    );
    // Wait for the mount card to appear — `data-ggui-stack-entry`
    // only renders after the fetch resolves.
    const card = await waitFor(() => {
      const el = container.querySelector(
        '[data-ggui-stack-entry="component"]',
      );
      if (!el) throw new Error('mount card not yet rendered');
      return el;
    });
    // Load-bearing anchors — the canonical `data-ggui-*` contract shared
    // across in-process renderer surfaces. Browser specs can match any
    // surface with one selector.
    expect(card.getAttribute('data-ggui-code-ready')).toBe('true');
    expect(card.getAttribute('data-ggui-blueprint-id')).toBe(
      'weather-card-fixture',
    );
    // Blueprint metadata surfaces in the card header.
    expect(card.textContent).toContain('Weather Card Fixture');
    expect(card.textContent).toContain('application/javascript+react');
  });

  it('Slice 11.5 C5 — clicking "Try live →" POSTs to /try and navigates to the returned url', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method });
        if (init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              sessionId: 'try-abc',
              shortCode: 'abc1234567',
              url: '/s/abc1234567',
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            blueprintId: 'todo-list',
            blueprintName: 'Todo List',
            code: 'export default function T(){return null;}',
            contentType: 'application/javascript+react',
          }),
          { status: 200 },
        );
      }),
    );
    const pushStateSpy = vi.spyOn(window.history, 'pushState');

    const { container } = render(
      <BlueprintViewer blueprintId="todo-list" />,
    );
    // Wait for the mount card; CTA only renders after the fetch resolves.
    const btn = await waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>(
        'button[data-ggui-try-live]',
      );
      if (!el) throw new Error('try-live button not rendered');
      return el;
    });
    expect(btn.getAttribute('data-ggui-blueprint-id')).toBe('todo-list');
    expect(btn.textContent).toContain('Try live');

    await act(async () => {
      btn.click();
    });

    await waitFor(() => {
      const postCall = calls.find((c) => c.method === 'POST');
      if (!postCall) throw new Error('POST not yet fired');
      expect(postCall.url).toBe('/ggui/console/blueprint/todo-list/try');
    });
    await waitFor(() => {
      expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/s/abc1234567');
    });
  });

  it('Slice 11.5 C5 — surfaces an inline error when /try returns 503 try_not_wired', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              error: 'try_not_wired',
              message: 'POST /try requires sessionChannel + shortCodeIndex.',
            }),
            { status: 503 },
          );
        }
        return new Response(
          JSON.stringify({
            blueprintId: 'todo-list',
            blueprintName: 'Todo List',
            code: 'export default function T(){return null;}',
            contentType: 'application/javascript+react',
          }),
          { status: 200 },
        );
      }),
    );
    const pushStateSpy = vi.spyOn(window.history, 'pushState');

    const { container } = render(
      <BlueprintViewer blueprintId="todo-list" />,
    );
    const btn = await waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>(
        'button[data-ggui-try-live]',
      );
      if (!el) throw new Error('try-live button not rendered');
      return el;
    });
    await act(async () => {
      btn.click();
    });

    await waitFor(() => {
      const marker = container.querySelector('[data-ggui-try-live="error"]');
      if (!marker) throw new Error('error marker not rendered');
      expect(marker.getAttribute('title')).toContain('sessionChannel');
    });
    // Navigation did NOT fire — the blueprint mount stays put.
    expect(pushStateSpy).not.toHaveBeenCalled();
  });

  it('abortss the fetch when unmounted mid-request (no setState-on-unmounted warning)', async () => {
    // Hang the fetch so the effect cleanup path is the only way out.
    // The component's abort controller fires `abort()` on unmount;
    // the fetch promise's rejection-on-abort must NOT flow into
    // `setState`.
    let abortSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        abortSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }),
    );
    const { unmount } = render(<BlueprintViewer blueprintId="x" />);
    expect(abortSignal?.aborted).toBe(false);
    act(() => {
      unmount();
    });
    expect(abortSignal?.aborted).toBe(true);
  });
});
