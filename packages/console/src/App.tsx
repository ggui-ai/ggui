/**
 * `App` — console SPA entry + route switcher.
 *
 * **Operator-only information architecture.** The console serves
 * operators; there is no end-user zone.
 *
 *   - `/`                    → admin-index → mounts {@link Status}
 *   - `/admin`               → admin-index → mounts {@link Status}
 *   - `/admin/status`        → {@link Status}
 *   - `/admin/sessions`       → {@link Renders}
 *   - `/admin/blueprints`    → {@link Blueprints}
 *   - `/admin/variants`      → {@link BlueprintVariants}
 *   - `/admin/variants/:hash`         → {@link BlueprintVariantDetail}
 *   - `/admin/variants/:hash/generate`→ {@link BlueprintVariantGenerate}
 *   - `/admin/config`        → {@link Config}
 *   - `/admin/tools`         → {@link McpInspector}
 *   - `/admin/llm-keys`      → {@link AdminLlmKeys}
 *   - `/admin/connector-keys`→ {@link Keys}
 *   - `/admin/oauth-providers`→ {@link AdminOAuthProviders}
 *   - `/admin/clients`       → {@link Clients}
 *   - `/admin/theme`         → {@link Theme}
 *   - `/admin-login`         → {@link AdminLogin}
 *
 *   Dev-mode debug zone (gated behind `GGUI_MODE=dev`):
 *   - `/devtools`            → {@link Devtools} (index)
 *   - `/devtools/llm-trace`  → {@link Devtools}
 *   - `/devtools/validator`  → {@link Devtools}
 *   - `/devtools/cache`      → {@link Devtools}
 *   - `/devtools/timeline`   → {@link Devtools}
 *   - `/devtools/payloads`   → {@link Devtools}
 *   - `/devtools/benchmarks` → {@link Devtools} (benchmarks dashboard embed)
 *
 *   Deep-link surfaces (top-level, bare-chrome — share-link targets):
 *   - `/preview/<id>`        → {@link BlueprintViewer}
 *
 * Route matching + navigation live in `./router.ts` — this component
 * just subscribes to route changes and dispatches.
 */
import { useSyncExternalStore, type ReactElement } from 'react';
import { SectionHead } from './brand/SectionHead.js';
import { Shell } from './brand/Shell.js';
import { AdminLogin } from './routes/AdminLogin.js';
import { AdminLlmKeys } from './routes/AdminLlmKeys.js';
import { AdminOAuthProviders } from './routes/AdminOAuthProviders.js';
import { BlueprintViewer } from './routes/BlueprintViewer.js';
import { Blueprints } from './routes/Blueprints.js';
import { BlueprintVariantDetail } from './routes/BlueprintVariantDetail.js';
import { BlueprintVariantGenerate } from './routes/BlueprintVariantGenerate.js';
import { BlueprintVariants } from './routes/BlueprintVariants.js';
import { Clients } from './routes/Clients.js';
import { Config } from './routes/Config.js';
import { Devtools } from './routes/Devtools.js';
import { Keys } from './routes/Keys.js';
import { McpInspector } from './routes/McpInspector.js';
import { Renders } from './routes/Renders.js';
import { Status } from './routes/Status.js';
import { Theme } from './routes/Theme.js';
import { getStableRoute, navigateTo, onRouteChange, type Route, isDevtoolsRoute } from './router.js';

// Hoisted singleton for the SSR path. `useSyncExternalStore` compares
// snapshots with `Object.is`, so freshly-allocating `{ kind: 'admin-index' }`
// on every call would re-trigger the `getSnapshot should be cached`
// bailout that `getStableRoute` fixes for the client path.
const SERVER_ROUTE: Route = { kind: 'admin-index' };

function getRouteSnapshot(): Route {
  if (typeof window === 'undefined') return SERVER_ROUTE;
  return getStableRoute(window.location.pathname);
}

function getServerRouteSnapshot(): Route {
  return SERVER_ROUTE;
}

export function App(): ReactElement {
  const route = useSyncExternalStore(
    onRouteChange,
    getRouteSnapshot,
    getServerRouteSnapshot,
  );

  // ── Deep-link surfaces (bare chrome) ──────────────────────────
  if (route.kind === 'blueprint') {
    return (
      <Shell route={route} variant="narrow">
        <BlueprintViewer blueprintId={route.blueprintId} />
      </Shell>
    );
  }

  // ── Admin zone ────────────────────────────────────────────────
  // `/` and `/admin` both land on Status — Status is the highest-
  // signal default for an operator opening the panel.
  if (route.kind === 'admin-index' || route.kind === 'admin-status') {
    return (
      <Shell route={route} variant="admin">
        <Status />
      </Shell>
    );
  }
  if (route.kind === 'admin-sessions') {
    return (
      <Shell route={route} variant="admin">
        <Renders />
      </Shell>
    );
  }
  if (route.kind === 'admin-blueprints') {
    return (
      <Shell route={route} variant="admin">
        <Blueprints />
      </Shell>
    );
  }
  if (route.kind === 'admin-variants') {
    return (
      <Shell route={route} variant="admin">
        <BlueprintVariants />
      </Shell>
    );
  }
  if (route.kind === 'admin-variant-detail') {
    return (
      <Shell route={route} variant="admin">
        <BlueprintVariantDetail contractHash={route.contractHash} />
      </Shell>
    );
  }
  if (route.kind === 'admin-variant-generate') {
    return (
      <Shell route={route} variant="admin">
        <BlueprintVariantGenerate contractHash={route.contractHash} />
      </Shell>
    );
  }
  if (route.kind === 'admin-config') {
    return (
      <Shell route={route} variant="admin">
        <Config />
      </Shell>
    );
  }
  if (route.kind === 'admin-tools') {
    return (
      <Shell route={route} variant="admin">
        <McpInspector />
      </Shell>
    );
  }
  if (route.kind === 'admin-llm-keys') {
    return (
      <Shell route={route} variant="admin">
        <AdminLlmKeys />
      </Shell>
    );
  }
  if (route.kind === 'admin-connector-keys') {
    return (
      <Shell route={route} variant="admin">
        <Keys />
      </Shell>
    );
  }
  if (route.kind === 'admin-oauth-providers') {
    return (
      <Shell route={route} variant="admin">
        <AdminOAuthProviders />
      </Shell>
    );
  }
  if (route.kind === 'admin-clients') {
    return (
      <Shell route={route} variant="admin">
        <Clients />
      </Shell>
    );
  }
  if (route.kind === 'admin-theme') {
    return (
      <Shell route={route} variant="admin">
        <Theme />
      </Shell>
    );
  }
  if (route.kind === 'admin-login') {
    return (
      <Shell route={route} variant="narrow">
        <AdminLogin />
      </Shell>
    );
  }

  // ── Devtools zone ────────────────────────────────────────────
  // All `/devtools/*` kinds render through the same `<Devtools>`
  // component — it switches on `route.kind` to choose between the
  // index and per-surface views.
  if (isDevtoolsRoute(route)) {
    return (
      <Shell route={route} variant="devtools">
        <Devtools route={route} />
      </Shell>
    );
  }

  return (
    <Shell route={route} variant="narrow">
      <NotFound pathname={route.pathname} />
    </Shell>
  );
}

function NotFound({ pathname }: { readonly pathname: string }): ReactElement {
  return (
    <section className="ggui-section">
      <SectionHead
        num="404 / not found"
        title="Nothing lives here."
        mute="This is an operator-only server."
        intro={
          <>
            <code className="ggui-code">{pathname}</code> is not a route
            served by this console. The end-user pages were retired —
            ggui&rsquo;s end-users see UI through their MCP host
            (claude.ai, Claude Desktop, Cursor), not through this
            server&rsquo;s own surface.
          </>
        }
      />
      <div className="ggui-card">
        <div className="ggui-card__head">
          <span className="ggui-card__title">routes</span>
          <span className="ggui-card__num">RTE / 01</span>
        </div>
        <div className="ggui-card__body">
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'grid',
              gap: 10,
            }}
          >
            <li>
              <button
                type="button"
                className="ggui-btn ggui-btn--ghost"
                onClick={() => navigateTo('/admin/status')}
              >
                <span className="ggui-btn__dot" aria-hidden />/ admin
              </button>
            </li>
            <li>
              <button
                type="button"
                className="ggui-btn ggui-btn--ghost"
                onClick={() => navigateTo('/admin-login')}
              >
                <span className="ggui-btn__dot" aria-hidden />/ admin-login
              </button>
            </li>
          </ul>
          <p className="ggui-muted">
            The{' '}
            <code className="ggui-code">/preview/&lt;blueprintId&gt;</code>{' '}
            route requires a real id — paste a blueprint id registered
            in <code className="ggui-code">ggui.json</code>.
          </p>
        </div>
      </div>
    </section>
  );
}
