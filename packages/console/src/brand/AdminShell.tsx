/**
 * `AdminShell` — sub-shell for the operator-zone (`/admin/*`).
 *
 * The user-zone shell ({@link Shell}) renders the lean 4-item TopNav
 * for end-users. The admin zone gets its own sub-shell on top of that
 * — same TopNav (so operators can return to `/`) but with a grouped
 * left-rail underneath that surfaces every operator surface in one
 * coherent navigation rather than scattering them across the top bar.
 *
 * Three groups (locked 2026-05-03 nav reorg):
 *
 *   - **Server**     — Status, Config, Tools
 *   - **Auth**       — LLM keys, Connector keys, OAuth providers, Clients
 *   - **Appearance** — Theme
 *
 * Reuses the `ggui-config-grid` / `ggui-config-rail` CSS classes that
 * were originally tailored for the Config viewer's section rail —
 * shape is identical (sticky sidebar + max-width content pane), so a
 * second copy would be redundant. If the visual treatment ever needs
 * to diverge from Config, copy → rename then.
 */
import type { ReactElement, ReactNode } from 'react';
import { navigateTo, type Route } from '../router.js';

export interface AdminShellProps {
  readonly route: Route;
  readonly children: ReactNode;
}

interface RailItem {
  readonly label: string;
  readonly path: string;
  readonly match: Route['kind'];
}

interface RailGroup {
  readonly label: string;
  readonly items: readonly RailItem[];
}

/**
 * The single source of truth for the admin sub-nav. Order is
 * read-most-often → write-rarest:
 *
 *   - Server first — `/admin/status` is the default landing pane and
 *     the most-visited surface (operators check liveness daily).
 *   - Auth second — visited when pairing a new client or rotating
 *     keys; weekly-ish.
 *   - Appearance last — set-and-forget.
 */
const GROUPS: readonly RailGroup[] = [
  {
    label: 'server',
    items: [
      { label: 'status', path: '/admin/status', match: 'admin-status' },
      { label: 'renders', path: '/admin/renders', match: 'admin-renders' },
      {
        label: 'blueprints',
        path: '/admin/blueprints',
        match: 'admin-blueprints',
      },
      // Variant management surface. Sibling of `blueprints` (the
      // declared+cached registry view) — `variants` is the operator's
      // daily-driver for the per-contract multi-variant model the
      // matcher consults at handshake time.
      {
        label: 'variants',
        path: '/admin/variants',
        match: 'admin-variants',
      },
      { label: 'config', path: '/admin/config', match: 'admin-config' },
      { label: 'tools', path: '/admin/tools', match: 'admin-tools' },
    ],
  },
  {
    label: 'auth',
    items: [
      { label: 'LLM keys', path: '/admin/llm-keys', match: 'admin-llm-keys' },
      {
        label: 'connector keys',
        path: '/admin/connector-keys',
        match: 'admin-connector-keys',
      },
      {
        label: 'OAuth providers',
        path: '/admin/oauth-providers',
        match: 'admin-oauth-providers',
      },
      { label: 'clients', path: '/admin/clients', match: 'admin-clients' },
    ],
  },
  {
    label: 'appearance',
    items: [{ label: 'theme', path: '/admin/theme', match: 'admin-theme' }],
  },
];

export function AdminShell({
  route,
  children,
}: AdminShellProps): ReactElement {
  return (
    <div className="ggui-config-grid" data-ggui-admin-shell>
      <AdminRail route={route} />
      <div className="ggui-admin-pane">{children}</div>
    </div>
  );
}

function AdminRail({ route }: { readonly route: Route }): ReactElement {
  return (
    <nav
      className="ggui-config-rail"
      aria-label="admin sections"
      data-ggui-admin-rail
    >
      {GROUPS.map((group) => (
        <div key={group.label} data-ggui-admin-group={group.label}>
          <div
            className="ggui-stack__head"
            style={{ padding: '10px 14px 6px', borderBottom: 0 }}
          >
            <span className="ggui-stack__label" style={{ fontSize: 11 }}>
              {group.label}
            </span>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {group.items.map((item) => {
              const isActive = route.kind === item.match;
              return (
                <li key={item.path} data-ggui-admin-item={item.match}>
                  <button
                    type="button"
                    onClick={() => navigateTo(item.path)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`ggui-config-rail__btn${isActive ? ' is-active' : ''}`}
                  >
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
