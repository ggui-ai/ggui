/**
 * `TopNav` — sticky brand-kit navigation bar.
 *
 * **Operator-only information architecture.**
 *
 * The TopNav carries only the wordmark + crumb. There are no
 * user-zone links to display because every surface is operator-zone,
 * and operators navigate within the admin sub-shell's left rail. A
 * simple "admin" link makes the entry point obvious from the deep-
 * link surface (`/preview/<id>`) and from the not-found page; the
 * link disappears when already inside `/admin/*`.
 */
import type { ReactElement, ReactNode } from 'react';
import { getServerMode } from '../mode.js';
import {
  isAdminRoute,
  isDevtoolsRoute,
  navigateTo,
  type Route,
} from '../router.js';
import { Wordmark } from '../routes/Wordmark.js';

export interface TopNavProps {
  /**
   * Current route kind — used to render the active-link underline and
   * render the in-section breadcrumb text (e.g. blueprintId).
   */
  readonly route: Route;
  /**
   * Optional right-side slot (rendered after the primary nav links).
   * Used by routes that want to stamp a status pill next to the mark.
   */
  readonly rightSlot?: ReactNode;
}

export function TopNav({ route, rightSlot }: TopNavProps): ReactElement {
  const crumb = breadcrumbFor(route);
  const inAdmin = isAdminRoute(route);
  const inDevtools = isDevtoolsRoute(route);
  // `/devtools` link only appears when the server stamped
  // `<meta name="ggui-mode" content="dev">` into the bootstrap HTML.
  // In prod the mode meta is absent → `getServerMode()` returns 'prod'
  // → link is hidden, even though `parseRoute` still understands the
  // path family (manual URL paste lands on the placeholder pages).
  const showDevtoolsLink = getServerMode() === 'dev' && !inDevtools;
  return (
    <nav className="ggui-nav" aria-label="console navigation">
      <div className="ggui-nav__inner">
        <div className="ggui-nav__left">
          <button
            type="button"
            className="ggui-nav__link"
            onClick={() => navigateTo('/admin/status')}
            aria-label="go to admin"
            style={{ display: 'flex', alignItems: 'center' }}
          >
            <Wordmark width={84} />
          </button>
          <span className="ggui-nav__brand" aria-label="ggui console">
            console
          </span>
          <span className="ggui-nav__version">v1</span>
          <span className="ggui-nav__version" aria-label="community edition">
            community
          </span>
          {inDevtools ? (
            <span
              className="ggui-nav__version"
              data-ggui-dev-mode-pill
              style={{ background: 'var(--ggui-accent)', color: 'white' }}
              aria-label="dev mode"
            >
              DEV MODE
            </span>
          ) : null}
          {crumb ? <span className="ggui-nav__crumb">{crumb}</span> : null}
        </div>
        <ul className="ggui-nav__links">
          {showDevtoolsLink ? (
            <li>
              <button
                type="button"
                className="ggui-nav__link"
                onClick={() => navigateTo('/devtools')}
                data-ggui-nav-devtools
              >
                devtools →
              </button>
            </li>
          ) : null}
          {inAdmin ? null : (
            <li>
              <button
                type="button"
                className="ggui-nav__link"
                onClick={() => navigateTo('/admin/status')}
              >
                admin →
              </button>
            </li>
          )}
          {rightSlot ? <li>{rightSlot}</li> : null}
        </ul>
      </div>
    </nav>
  );
}

function breadcrumbFor(route: Route): string | null {
  switch (route.kind) {
    case 'blueprint':
      return `/ preview / ${route.blueprintId}`;
    case 'admin-index':
    case 'admin-status':
      return '/ admin / status';
    case 'admin-sessions':
      return '/ admin / renders';
    case 'admin-blueprints':
      return '/ admin / blueprints';
    case 'admin-config':
      return '/ admin / config';
    case 'admin-tools':
      return '/ admin / tools';
    case 'admin-llm-keys':
      return '/ admin / llm-keys';
    case 'admin-connector-keys':
      return '/ admin / connector-keys';
    case 'admin-oauth-providers':
      return '/ admin / oauth-providers';
    case 'admin-clients':
      return '/ admin / clients';
    case 'admin-theme':
      return '/ admin / theme';
    case 'admin-login':
      return '/ admin-login';
    case 'devtools-index':
      return '/ devtools';
    case 'devtools-llm-trace':
      return '/ devtools / llm-trace';
    case 'devtools-validator':
      return '/ devtools / validator';
    case 'devtools-cache':
      return '/ devtools / cache';
    case 'devtools-timeline':
      return '/ devtools / timeline';
    case 'devtools-payloads':
      return '/ devtools / payloads';
    case 'devtools-benchmarks':
      return '/ devtools / benchmarks';
    case 'not-found':
      return route.pathname;
    default:
      return null;
  }
}
