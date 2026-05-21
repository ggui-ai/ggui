/**
 * LiveSessionPill — Slice 10b focused render tests.
 *
 * Lane 3 (vitest + jsdom). Three concerns:
 *
 *   - Idle endpoint (empty sessions / error) → component renders
 *     nothing.
 *   - Active endpoint (≥1 session with shortCode) → pill appears with
 *     `live · N` label + navigates to `/s/<shortCode>` on click.
 *   - Viewer-route hide: when already on `/s/<shortCode>`, pill is
 *     suppressed regardless of server state (noise prevention).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Route } from '../router.js';
import { LiveSessionPill } from './LiveSessionPill.js';

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

describe('LiveSessionPill', () => {
  it('renders nothing when the server reports no active sessions', async () => {
    mockFetch({ sessions: [], total: 0 });
    render(<LiveSessionPill route={STATUS_ROUTE} />);
    // Give the fetch a chance to resolve — pill still shouldn't appear.
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('[data-ggui-nav-live-pill]')).toBeNull();
  });

  it('renders nothing when no session has a shortCode', async () => {
    mockFetch({
      sessions: [
        {
          sessionId: 'sess-without-shortcode',
          stackSize: 0,
        },
      ],
      total: 1,
    });
    render(<LiveSessionPill route={STATUS_ROUTE} />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    expect(document.querySelector('[data-ggui-nav-live-pill]')).toBeNull();
  });

  it('renders the pill when a session with a shortCode is returned', async () => {
    mockFetch({
      sessions: [
        {
          sessionId: 'sess-1',
          shortCode: 'abc12345',
          stackSize: 1,
        },
      ],
      total: 1,
    });
    render(<LiveSessionPill route={STATUS_ROUTE} />);
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

  it('reports the plural session count when multiple sessions are live', async () => {
    mockFetch({
      sessions: [
        { sessionId: 's-1', shortCode: 'aaaa1111', stackSize: 1 },
        { sessionId: 's-2', shortCode: 'bbbb2222', stackSize: 2 },
        { sessionId: 's-3', shortCode: 'cccc3333', stackSize: 0 },
      ],
      total: 3,
    });
    render(<LiveSessionPill route={STATUS_ROUTE} />);
    await waitFor(() => {
      expect(
        document.querySelector('[data-ggui-nav-live-pill]')?.textContent,
      ).toMatch(/live · 3/);
    });
  });

  it('navigates to /s/<shortCode> on click', async () => {
    mockFetch({
      sessions: [
        { sessionId: 'sess-1', shortCode: 'aabbccdd', stackSize: 1 },
      ],
      total: 1,
    });
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    render(<LiveSessionPill route={STATUS_ROUTE} />);
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
      sessions: [
        { sessionId: 'sess-1', shortCode: 'abc12345', stackSize: 1 },
      ],
      total: 1,
    });
    render(<LiveSessionPill route={VIEWER_ROUTE} />);
    // No fetch should even fire on the viewer route.
    expect(global.fetch).not.toHaveBeenCalled();
    expect(document.querySelector('[data-ggui-nav-live-pill]')).toBeNull();
  });

  it('treats a non-ok response as idle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('err', { status: 500 })),
    );
    render(<LiveSessionPill route={STATUS_ROUTE} />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    expect(document.querySelector('[data-ggui-nav-live-pill]')).toBeNull();
  });
});
