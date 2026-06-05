/**
 * `LiveGguiSessionPill` — compact zero-click portal to the most-recent
 * live render, making the `/s/<shortCode>` viewer discoverable from
 * the top nav.
 *
 * Mounts in the `TopNav` right slot; self-fetches `GET
 * /ggui/console/renders?limit=3`, repolls every 10s, and renders a
 * small `live · N ↗` pill when the server has at least one active
 * render with a shortCode. Click → `navigateTo('/s/<shortCode>')`.
 *
 * Design notes:
 *
 *   - Respects the 5-item nav lock. The pill sits beside the 5 links
 *     as an auxiliary status + portal, not a navigation entry.
 *   - Hides itself on the viewer route (`/s/<shortCode>`) — the
 *     operator is already there; a pill pointing at "the latest" is
 *     noise (and the "latest" may be the render they're on).
 *   - Hides on fetch error + empty list — no placeholder. Silence is
 *     the honest answer when nothing is live.
 *   - Only one fetch in flight at a time; the `AbortController`
 *     cascade guarantees the component unmounts cleanly mid-poll.
 *
 * This is intentionally a self-contained component rather than a
 * prop-drilled callback chain from `App.tsx` — the data it needs
 * (renders) is orthogonal to route state, and Shell already owns
 * pill-height considerations.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { isAdminRoute, navigateTo, type Route } from '../router.js';

const POLL_INTERVAL_MS = 10_000;

interface GguiSessionRow {
  readonly renderId: string;
  readonly shortCode?: string;
}

interface GguiSessionsBody {
  readonly renders: readonly GguiSessionRow[];
  readonly total: number;
}

type PillState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'active'; readonly total: number; readonly shortCode: string };

export function LiveGguiSessionPill({
  route,
}: {
  readonly route: Route;
}): ReactElement | null {
  const [state, setState] = useState<PillState>({ kind: 'idle' });
  // Hide on (a) the viewer itself — pointing at "the latest" while
  // already viewing it is noise — and (b) every non-admin route.
  // `/ggui/console/renders` is admin-cookie-gated since the 2026-05-03
  // security fix, so polling it from `/`, `/settings`, `/login` would
  // 401 every 10s and surface no live data. The pill is operator
  // chrome by design now; user-zone surfaces don't need it.
  const hideForRoute = route.kind === 'viewer' || !isAdminRoute(route);

  useEffect(() => {
    if (hideForRoute) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      const controller = new AbortController();
      try {
        const res = await fetch('/ggui/console/renders?limit=3', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          if (!cancelled) setState({ kind: 'idle' });
        } else {
          const body = (await res.json()) as GguiSessionsBody;
          if (cancelled) return;
          const withShort = body.renders.find(
            (r) => typeof r.shortCode === 'string',
          );
          if (!withShort || !withShort.shortCode) {
            setState({ kind: 'idle' });
          } else {
            setState({
              kind: 'active',
              total: body.renders.length,
              shortCode: withShort.shortCode,
            });
          }
        }
      } catch {
        if (!cancelled) setState({ kind: 'idle' });
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => {
            void poll();
          }, POLL_INTERVAL_MS);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [hideForRoute]);

  if (hideForRoute || state.kind === 'idle') return null;
  const label = state.total === 1 ? 'live · 1' : `live · ${state.total}`;
  return (
    <button
      type="button"
      className="ggui-nav__pill"
      data-ggui-nav-live-pill
      data-ggui-nav-live-shortcode={state.shortCode}
      onClick={() =>
        navigateTo(`/s/${encodeURIComponent(state.shortCode)}`)
      }
      aria-label={`open latest live render ${state.shortCode}`}
    >
      <span className="ggui-nav__pill-dot" aria-hidden />
      <span>{label}</span>
      <span className="ggui-nav__pill-arrow" aria-hidden>
        ↗
      </span>
    </button>
  );
}
