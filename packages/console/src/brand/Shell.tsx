/**
 * `Shell` — page frame that wires `TopNav` + main content + `Footer`.
 *
 * Every console route renders its content as `Shell` children so
 * the nav bar, max-width rail, and footer stay identical across
 * routes. The `variant` prop swaps the main container's width:
 *
 *   - `wide` (default) — 1120px.
 *   - `narrow` — 820px, used by deep-link viewers (render /
 *     blueprint) and not-found.
 *   - `admin` — wide, but with the admin sub-shell (left-rail)
 *     wrapping the children. Used by every `/admin/*` route.
 *   - `devtools` — wide, with the devtools sub-shell (left-rail).
 *     Used by every `/devtools/*` route. Only meaningful when the
 *     server reports `mode === 'dev'`.
 *
 * `route` is passed through to `TopNav` so the active link highlight
 * and breadcrumb stay in sync without each route re-threading it.
 */
import type { ReactElement, ReactNode } from 'react';
import type { Route } from '../router.js';
import { AdminShell } from './AdminShell.js';
import { DevtoolsShell } from './DevtoolsShell.js';
import { Footer } from './Footer.js';
import { LiveRenderPill } from './LiveRenderPill.js';
import { TopNav } from './TopNav.js';

export interface ShellProps {
  readonly route: Route;
  readonly children: ReactNode;
  readonly variant?: 'wide' | 'narrow' | 'admin' | 'devtools';
  readonly showFooter?: boolean;
  /**
   * Optional additional nav-right content. Always rendered AFTER the
   * default `LiveRenderPill` so page-specific pills (if ever added)
   * sit to the right of the live-render portal.
   */
  readonly navRightSlot?: ReactNode;
}

export function Shell({
  route,
  children,
  variant = 'wide',
  showFooter = true,
  navRightSlot,
}: ShellProps): ReactElement {
  const mainClass =
    variant === 'narrow'
      ? 'ggui-shell__main ggui-shell__main--narrow'
      : 'ggui-shell__main';
  const rightSlot = (
    <>
      <LiveRenderPill route={route} />
      {navRightSlot}
    </>
  );
  let body: ReactNode = children;
  if (variant === 'admin') {
    body = <AdminShell route={route}>{children}</AdminShell>;
  } else if (variant === 'devtools') {
    body = <DevtoolsShell route={route}>{children}</DevtoolsShell>;
  }
  return (
    <div className="ggui-shell">
      <TopNav route={route} rightSlot={rightSlot} />
      <main className={mainClass}>{body}</main>
      {showFooter ? <Footer /> : null}
    </div>
  );
}
