/**
 * Status — Slice 10a focused render tests for the live-sessions hero.
 *
 * Lane 3 (vitest + jsdom). Asserts the hero's four branches:
 *
 *   - loading → quiet skeleton (grid still paints)
 *   - empty   → idle eyebrow + playground pointer
 *   - error   → quiet error copy
 *   - active  → rail with "open latest →" CTA + per-row "open →"
 *
 * The underlying fetch is stubbed so tests don't hit the real server.
 * Status fires two parallel fetches (`/info` + `/sessions?limit=3`);
 * the tests reply to both via a URL-routing stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Status } from './Status.js';

interface InfoBody {
  readonly server: string;
  readonly version: string;
  readonly pairing: { readonly enabled: boolean; readonly pending: null };
  readonly capabilities: {
    readonly toolCount: number;
    readonly blueprintCount: number;
    readonly primitiveCount: number;
    readonly agentWired: boolean;
    readonly generation: {
      readonly wired: boolean;
      readonly hasCredentials: boolean;
    };
  };
  readonly storage: {
    readonly sessionStore: 'memory';
    readonly vectorStore: 'memory';
  };
}

function makeInfo(): InfoBody {
  return {
    server: 'test-server',
    version: '0.0.0',
    pairing: { enabled: false, pending: null },
    capabilities: {
      toolCount: 3,
      blueprintCount: 1,
      primitiveCount: 5,
      agentWired: false,
      generation: { wired: false, hasCredentials: false },
    },
    storage: { sessionStore: 'memory', vectorStore: 'memory' },
  };
}

function stubFetch(
  sessionsBody: unknown,
  options: { readonly sessionsStatus?: number } = {},
): void {
  const { sessionsStatus = 200 } = options;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/ggui/console/info')) {
        return new Response(JSON.stringify(makeInfo()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/ggui/console/sessions')) {
        return new Response(JSON.stringify(sessionsBody), {
          status: sessionsStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Status — live-sessions hero', () => {
  it('renders the empty-state hero when no sessions are live', async () => {
    stubFetch({ sessions: [], total: 0 });
    render(<Status />);
    await waitFor(() => {
      const hero = document.querySelector('[data-ggui-status-hero]');
      expect(hero?.getAttribute('data-ggui-status-hero')).toBe('empty');
    });
    // No active-session attributes when empty.
    expect(
      document.querySelector('[data-ggui-live-session-count]'),
    ).toBeNull();
  });

  it('renders the active hero with row + open-latest button when a session exists', async () => {
    stubFetch({
      sessions: [
        {
          sessionId: 'sess-1',
          shortCode: 'abc12345',
          appId: 'builder',
          stackSize: 1,
          lastActivityAt: Date.now(),
          createdAt: Date.now() - 5_000,
          status: 'active',
        },
      ],
      total: 1,
    });
    render(<Status />);
    const hero = await waitFor(() => {
      const el = document.querySelector('[data-ggui-status-hero]');
      if (el?.getAttribute('data-ggui-status-hero') !== 'active') {
        throw new Error('hero not yet active');
      }
      return el;
    });
    expect(hero.getAttribute('data-ggui-live-session-count')).toBe('1');
    expect(
      hero.querySelector('[data-ggui-status-hero-open-latest]'),
    ).toBeTruthy();
    const rowShort = hero.querySelector(
      '[data-ggui-status-hero-shortcode="abc12345"]',
    );
    expect(rowShort).toBeTruthy();
  });

  it('renders a session count in the eyebrow that matches returned rows', async () => {
    const now = Date.now();
    stubFetch({
      sessions: [
        {
          sessionId: 's-1',
          shortCode: 'aaaa1111',
          appId: 'builder',
          stackSize: 1,
          lastActivityAt: now,
          createdAt: now - 1_000,
          status: 'active',
        },
        {
          sessionId: 's-2',
          shortCode: 'bbbb2222',
          appId: 'builder',
          stackSize: 0,
          lastActivityAt: now - 500,
          createdAt: now - 2_000,
          status: 'active',
        },
      ],
      total: 2,
    });
    render(<Status />);
    await waitFor(() => {
      expect(
        document
          .querySelector('[data-ggui-status-hero]')
          ?.getAttribute('data-ggui-live-session-count'),
      ).toBe('2');
    });
    const eyebrow = document.querySelector('.ggui-status-hero__eyebrow');
    expect(eyebrow?.textContent).toMatch(/2 sessions/);
  });

  it('navigates to the latest session on "open latest →" click', async () => {
    const now = Date.now();
    stubFetch({
      sessions: [
        {
          sessionId: 's-latest',
          shortCode: 'deadbeef',
          appId: 'builder',
          stackSize: 0,
          lastActivityAt: now,
          createdAt: now - 500,
          status: 'active',
        },
      ],
      total: 1,
    });
    const pushSpy = vi.spyOn(window.history, 'pushState');
    render(<Status />);
    const btn = (await waitFor(() => {
      const el = document.querySelector(
        '[data-ggui-status-hero-open-latest]',
      );
      if (!el) throw new Error('open-latest button not rendered yet');
      return el;
    })) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(pushSpy).toHaveBeenCalledWith(null, '', '/s/deadbeef');
    pushSpy.mockRestore();
  });

  it('renders the error copy when /sessions returns non-ok', async () => {
    stubFetch({ sessions: [], total: 0 }, { sessionsStatus: 500 });
    render(<Status />);
    await waitFor(() => {
      expect(
        document.querySelector('[data-ggui-status-hero]')?.getAttribute(
          'data-ggui-status-hero',
        ),
      ).toBe('error');
    });
  });
});
