/**
 * Tiny route matcher for the console SPA.
 *
 * **Operator-only information architecture.**
 *
 * There is no end-user browser zone. ggui's actual end-users see UI
 * through *their* MCP host (claude.ai, Claude Desktop, Cursor) — the
 * ggui server's own browser surface is operator-only.
 *
 * Two operator namespaces:
 *
 *   - **`/admin/*`** — production-mode operator panel. Default for
 *     `ggui serve`. Rendered inside `AdminShell` (left-rail sub-nav
 *     grouped Server / Auth / Appearance). Admin-cookie-gated; 401s
 *     bounce to `/admin-login`.
 *   - **`/devtools/*`** — development-mode debug panel. Mounts only
 *     when `GGUI_MODE=dev`. Default for `ggui dev`.
 *
 * Routes:
 *
 *       /                       → admin-index (lands on Status)
 *       /admin                  → admin-index — same as /
 *       /admin/status           → server / pairing / capabilities / storage
 *       /admin/sessions          → active render list
 *       /admin/blueprints       → registered blueprint + primitive catalog
 *       /admin/variants         → variant management (list, grouped by contract)
 *       /admin/variants/:hash   → per-contract variant detail (A/B compare)
 *       /admin/variants/:hash/generate → variant generation form
 *       /admin/config           → ggui.json viewer (read-only)
 *       /admin/tools            → MCP tool inspector
 *       /admin/llm-keys         → operator-side LLM provider keys
 *       /admin/connector-keys   → paired bearer tokens
 *       /admin/oauth-providers  → OAuth provider config
 *       /admin/clients          → registered OAuth clients
 *       /admin/theme            → theme picker + DTCG override editor
 *       /admin-login            → admin-token bearer paste
 *
 * Deep-link surfaces (top-level, bare-chrome — share-link targets):
 *
 *       /preview/<blueprintId>  → blueprint mount
 *
 * Anything else falls through as `not-found`. No dynamic routing
 * library dep — shipping a router for ten paths is exactly the kind
 * of bundle bloat the 500 KB cap exists to catch.
 *
 * The matcher reads `window.location.pathname`; callers subscribe to
 * `popstate` + the custom `ggui-eui:navigate` event to re-render on
 * programmatic navigation. `navigateTo` is the single mutation site
 * — `history.pushState` + dispatch one event.
 */

export type Route =
  // — Deep-link surfaces (top-level, bare-chrome) —
  | { readonly kind: 'blueprint'; readonly blueprintId: string }
  // — Admin zone — `/admin/*`. All admin-cookie-gated, all rendered
  // inside `AdminShell`. `admin-index` is the landing route for both
  // `/` and `/admin` and renders the same content as `admin-status`.
  | { readonly kind: 'admin-index' }
  | { readonly kind: 'admin-status' }
  | { readonly kind: 'admin-sessions' }
  | { readonly kind: 'admin-blueprints' }
  // Operator UX for the multi-variant blueprint system. Sibling of
  // `admin-blueprints` (the declared+cached registry view, which
  // predates the variant model). These three routes consume the
  // `ggui_ops_*` blueprint tools.
  | { readonly kind: 'admin-variants' }
  | { readonly kind: 'admin-variant-detail'; readonly contractHash: string }
  | { readonly kind: 'admin-variant-generate'; readonly contractHash: string }
  | { readonly kind: 'admin-config' }
  | { readonly kind: 'admin-tools' }
  | { readonly kind: 'admin-llm-keys' }
  | { readonly kind: 'admin-connector-keys' }
  | { readonly kind: 'admin-oauth-providers' }
  | { readonly kind: 'admin-clients' }
  | { readonly kind: 'admin-theme' }
  | { readonly kind: 'admin-login' }
  // — Devtools zone — `/devtools/*`. Mounts only when the server reports
  // `mode === 'dev'` (server reads `GGUI_MODE`, surfaces via `/info`).
  // Same admin-cookie gate as `/admin/*`. Rendered inside
  // `<DevtoolsShell>`.
  | { readonly kind: 'devtools-index' }
  | { readonly kind: 'devtools-llm-trace' }
  | { readonly kind: 'devtools-validator' }
  | { readonly kind: 'devtools-cache' }
  | { readonly kind: 'devtools-timeline' }
  | { readonly kind: 'devtools-payloads' }
  | { readonly kind: 'devtools-benchmarks' }
  | { readonly kind: 'not-found'; readonly pathname: string };

const NAVIGATE_EVENT = 'ggui-eui:navigate';

/**
 * Parse `window.location.pathname` into a discriminated {@link Route}.
 * Kept pure so it can be called from tests with a synthetic pathname.
 */
export function parseRoute(pathname: string): Route {
  // Root → admin-index. `/` is an operator surface that lands on
  // Status.
  if (pathname === '/' || pathname === '') return { kind: 'admin-index' };

  // ── Deep-link surfaces ────────────────────────────────────────────
  const previewMatch = /^\/preview\/([^/]+)\/?$/.exec(pathname);
  if (previewMatch) {
    const blueprintId = previewMatch[1];
    if (!blueprintId) return { kind: 'not-found', pathname };
    return {
      kind: 'blueprint',
      blueprintId: decodeURIComponent(blueprintId),
    };
  }

  // ── Admin zone ───────────────────────────────────────────────────
  if (pathname === '/admin' || pathname === '/admin/') {
    return { kind: 'admin-index' };
  }
  if (pathname === '/admin/status' || pathname === '/admin/status/') {
    return { kind: 'admin-status' };
  }
  if (pathname === '/admin/sessions' || pathname === '/admin/sessions/') {
    return { kind: 'admin-sessions' };
  }
  if (
    pathname === '/admin/blueprints' ||
    pathname === '/admin/blueprints/'
  ) {
    return { kind: 'admin-blueprints' };
  }
  // Variant management routes. Order matters: longest-prefix routes
  // (with embedded params) must come BEFORE the bare index.
  const variantGenerateMatch =
    /^\/admin\/variants\/([^/]+)\/generate\/?$/.exec(pathname);
  if (variantGenerateMatch) {
    const contractHash = variantGenerateMatch[1];
    if (!contractHash) return { kind: 'not-found', pathname };
    return {
      kind: 'admin-variant-generate',
      contractHash: decodeURIComponent(contractHash),
    };
  }
  const variantDetailMatch = /^\/admin\/variants\/([^/]+)\/?$/.exec(pathname);
  if (variantDetailMatch) {
    const contractHash = variantDetailMatch[1];
    if (!contractHash) return { kind: 'not-found', pathname };
    return {
      kind: 'admin-variant-detail',
      contractHash: decodeURIComponent(contractHash),
    };
  }
  if (pathname === '/admin/variants' || pathname === '/admin/variants/') {
    return { kind: 'admin-variants' };
  }
  if (pathname === '/admin/config' || pathname === '/admin/config/') {
    return { kind: 'admin-config' };
  }
  if (pathname === '/admin/tools' || pathname === '/admin/tools/') {
    return { kind: 'admin-tools' };
  }
  if (pathname === '/admin/llm-keys' || pathname === '/admin/llm-keys/') {
    return { kind: 'admin-llm-keys' };
  }
  if (
    pathname === '/admin/connector-keys' ||
    pathname === '/admin/connector-keys/'
  ) {
    return { kind: 'admin-connector-keys' };
  }
  if (
    pathname === '/admin/oauth-providers' ||
    pathname === '/admin/oauth-providers/'
  ) {
    return { kind: 'admin-oauth-providers' };
  }
  if (pathname === '/admin/clients' || pathname === '/admin/clients/') {
    return { kind: 'admin-clients' };
  }
  if (pathname === '/admin/theme' || pathname === '/admin/theme/') {
    return { kind: 'admin-theme' };
  }
  if (pathname === '/admin-login' || pathname === '/admin-login/') {
    return { kind: 'admin-login' };
  }

  // ── Devtools zone ───────────────────────────────────────────────
  if (pathname === '/devtools' || pathname === '/devtools/') {
    return { kind: 'devtools-index' };
  }
  if (
    pathname === '/devtools/llm-trace' ||
    pathname === '/devtools/llm-trace/'
  ) {
    return { kind: 'devtools-llm-trace' };
  }
  if (
    pathname === '/devtools/validator' ||
    pathname === '/devtools/validator/'
  ) {
    return { kind: 'devtools-validator' };
  }
  if (pathname === '/devtools/cache' || pathname === '/devtools/cache/') {
    return { kind: 'devtools-cache' };
  }
  if (
    pathname === '/devtools/timeline' ||
    pathname === '/devtools/timeline/'
  ) {
    return { kind: 'devtools-timeline' };
  }
  if (
    pathname === '/devtools/payloads' ||
    pathname === '/devtools/payloads/'
  ) {
    return { kind: 'devtools-payloads' };
  }
  if (
    pathname === '/devtools/benchmarks' ||
    pathname === '/devtools/benchmarks/'
  ) {
    return { kind: 'devtools-benchmarks' };
  }

  return { kind: 'not-found', pathname };
}

/**
 * Return a referentially stable {@link Route} for `pathname`. The
 * last (pathname → route) pair is cached at module scope; subsequent
 * calls with the same pathname return the exact same object reference.
 *
 * **Why this exists.** React's `useSyncExternalStore` calls the
 * `getSnapshot` callback on every render and compares the result via
 * `Object.is` to decide whether to bail out. `parseRoute` is pure but
 * allocates a fresh object literal on every invocation, which means
 * two back-to-back calls for the same pathname return distinct
 * references — React reads that as "the store changed again" and
 * re-renders, which calls `getSnapshot` again, and the tree collapses
 * with `Maximum update depth exceeded` (warning: "The result of
 * getSnapshot should be cached to avoid an infinite loop").
 */
let lastRoutePathname: string | null = null;
let lastRoute: Route | null = null;
export function getStableRoute(pathname: string): Route {
  if (pathname !== lastRoutePathname || lastRoute === null) {
    lastRoutePathname = pathname;
    lastRoute = parseRoute(pathname);
  }
  return lastRoute;
}

/**
 * Test-only cache reset. Kept in production for bundle simplicity — a
 * no-op in practice unless a test calls it.
 */
export function _resetRouteCacheForTests(): void {
  lastRoutePathname = null;
  lastRoute = null;
}

/**
 * Programmatic navigation. Pushes a history entry and notifies the
 * listener in `useRoute` via the internal custom event.
 */
export function navigateTo(pathname: string): void {
  if (typeof window === 'undefined') return;
  window.history.pushState(null, '', pathname);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

/**
 * Subscribe to route changes. Passes the raw pathname to the
 * listener so callers can decide whether to re-parse or bail.
 */
export function onRouteChange(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('popstate', listener);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}

/**
 * True when `route.kind` belongs to the admin zone (`/admin/*` paths
 * or the `admin-login` exchange page). Used by `Shell` to swap to
 * `AdminShell` and by `TopNav` to highlight the trailing admin link.
 */
export function isAdminRoute(route: Route): boolean {
  return (
    route.kind === 'admin-index' ||
    route.kind === 'admin-status' ||
    route.kind === 'admin-sessions' ||
    route.kind === 'admin-blueprints' ||
    route.kind === 'admin-variants' ||
    route.kind === 'admin-variant-detail' ||
    route.kind === 'admin-variant-generate' ||
    route.kind === 'admin-config' ||
    route.kind === 'admin-tools' ||
    route.kind === 'admin-llm-keys' ||
    route.kind === 'admin-connector-keys' ||
    route.kind === 'admin-oauth-providers' ||
    route.kind === 'admin-clients' ||
    route.kind === 'admin-theme'
  );
}

/** Discriminated subset for the dev-mode debug zone (`/devtools/*`). */
export type DevtoolsRoute = Extract<
  Route,
  { kind: `devtools-${string}` }
>;

/**
 * True when `route.kind` belongs to the dev-mode debug zone
 * (`/devtools/*` paths). Used by `Shell` to swap to `DevtoolsShell`.
 * Routes still parse in prod mode — the SPA navigates to them just
 * fine — but the server-side surfaces only mount when `mode === 'dev'`.
 *
 * Type-predicate so callsites narrow `route` to {@link DevtoolsRoute}
 * after the check (the alternative is exhaustive switches in `App.tsx`,
 * which defeats the point of grouping the kinds under one shell).
 */
export function isDevtoolsRoute(route: Route): route is DevtoolsRoute {
  return (
    route.kind === 'devtools-index' ||
    route.kind === 'devtools-llm-trace' ||
    route.kind === 'devtools-validator' ||
    route.kind === 'devtools-cache' ||
    route.kind === 'devtools-timeline' ||
    route.kind === 'devtools-payloads' ||
    route.kind === 'devtools-benchmarks'
  );
}
