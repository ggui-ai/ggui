/**
 * LiveRenderPill — Slice 10b focused render tests.
 *
 * Lane 3 (vitest + jsdom). Three concerns:
 *
 *   - Idle endpoint (empty renders / error) → component renders
 *     nothing.
 *   - Active endpoint (≥1 render with shortCode) → pill appears with
 *     `live · N` label + navigates to `/s/<shortCode>` on click.
 *   - Viewer-route hide: when already on `/s/<shortCode>`, pill is
 *     suppressed regardless of server state (noise prevention).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Route } from '../router.js';
import { LiveRenderPill } from './LiveRenderPill.js';

// Any non-viewer route works — pill suppresses only on `viewer`.
// Picking `admin-status` after the two-zone IA reorg.
const STATUS_ROUTE: Route = { kind: 'admin-status' };
const VIEWER_ROUTE: Route = { kind: 'viewer', shortCode: 'abc12345' };

function mockFetch(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LiveRenderPill', () => {
  it('renders nothing when the server reports no active renders', async () => {
    mockFetch({ renders: [], total: 0 });
    render(<LiveRenderPill route={STATUS_ROUTE} />);
    // Give the fetch a chance to resolve — pill still shouldn't appear.
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('[data-ggui-nav-live-pill]')).toBeNull();
  });

  it('renders nothing when no render has a shortCode', async () => {
    mockFetch({
      renders: [
        {
          renderId: 'rndr-without-shortcode',
        },
      ],
      total: 1,
    });
    render(<LiveRenderPill route={STATUS_ROUTE} />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    expect(document.querySelector('[data-ggui-nav-live-pill]')).toBeNull();
  });

  it('renders the pill when a render with a shortCode is returned', async () => {
    mockFetch({
      renders: [
        {
          renderId: 'rndr-1',
          shortCode: 'abc12345',
        },
      ],
      total: 1,
    });
    render(<LiveRenderPill route={STATUS_ROUTE} />);
    await waitFor(() => {
      const pill = document.querySelector('[data-ggui-nav-live-pill]');
      expect(pill).toBeTruthy();
    });
    const pill = document.querySelector('[data-ggui-nav-live-pill]');
    expect(pill?.getAttribute('data-ggui-nav-live-shortcode')).toBe(
      'abc12345',
    );
    expect(pill?.textContent).toMatch(/live · 1/);
  });

  it('reports the plural render count when multiple renders are live', async () => {
    mockFetch({
      renders: [
        { renderId: 'r-1', shortCode: 'aaaa1111' },
        { renderId: 'r-2', shortCode: 'bbbb2222' },
        { renderId: 'r-3', shortCode: 'cccc3333' },
      ],
      total: 3,
    });
    render(<LiveRenderPill route={STATUS_ROUTE} />);
    await waitFor(() => {
      expect(
        document.querySelector('[data-ggui-nav-live-pill]')?.textContent,
      ).toMatch(/live · 3/);
    });
  });

  it('navigates to /s/<shortCode> on click', async () => {
    mockFetch({
      renders: [
        { renderId: 'rndr-1', shortCode: 'aabbccdd' },
      ],
      total: 1,
    });
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    render(<LiveRenderPill route={STATUS_ROUTE} />);
    const pill = await waitFor(() => {
      const el = document.querySelector('[data-ggui-nav-live-pill]');
      if (!el) throw new Error('pill not rendered');
      return el as HTMLButtonElement;
    });
    act(() => {
      fireEvent.click(pill);
    });
    expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/s/aabbccdd');
    pushStateSpy.mockRestore();
  });

  it('suppresses itself when the current route is the viewer', async () => {
    mockFetch({
      renders: [
        { renderId: 'rndr-1', shortCode: 'abc12345' },
      ],
      total: 1,
    });
    render(<LiveRenderPill route={VIEWER_ROUTE} />);
    // No fetch should even fire on the viewer route.
    expect(global.fetch).not.toHaveBeenCalled();
    expect(document.querySelector('[data-ggui-nav-live-pill]')).toBeNull();
  });

  it('treats a non-ok response as idle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('err', { status: 500 })),
    );
    render(<LiveRenderPill route={STATUS_ROUTE} />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    expect(document.querySelector('[data-ggui-nav-live-pill]')).toBeNull();
  });
});
