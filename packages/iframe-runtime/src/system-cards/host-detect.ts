/**
 * Host environment detection — figure out which embedder is hosting
 * the iframe-runtime so system cards can adapt their theming.
 *
 * Two signals matter:
 *
 *   - **Is this Claude?** (claude.ai web's `claudemcpcontent.com`
 *     sandbox proxy, or Claude Desktop's local iframe). When yes,
 *     system cards should drop their own background so the host's
 *     chat-bubble surface shows through, and use Claude-friendly
 *     accents.
 *   - **What color scheme does the user prefer?** Read from
 *     `prefers-color-scheme`. Subscribed via `matchMedia` so the card
 *     re-themes live when the user toggles their OS appearance.
 *
 * Both helpers are SSR-safe (return sensible defaults when `window`
 * is undefined).
 */
import * as React from 'react';

/**
 * Best-effort detection that we're embedded inside Claude (web or
 * desktop). Heuristics:
 *
 *   1. Hostname endsWith `claudemcpcontent.com` → claude.ai web.
 *      claude.ai loads the runtime through this sandbox proxy
 *      origin, so the iframe's own location lands here.
 *   2. Document referrer contains `claude.ai` → loaded from the
 *      claude.ai chat surface (covers cases where the runtime
 *      iframe inherits the parent origin via srcdoc).
 *   3. Hostname/UA contains `claude` (case-insensitive) → covers
 *      Claude Desktop's `desktop.claude.ai` / similar.
 *
 * Returns `false` when `window` is undefined (SSR / Node test
 * environments) — the caller can default to a non-Claude theme.
 *
 * @public
 */
export function isInsideClaude(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const host = window.location?.hostname ?? '';
    if (host.endsWith('claudemcpcontent.com')) return true;
    if (/(^|\.)claude\.ai$/i.test(host)) return true;
    if (/claude/i.test(host)) return true;
    const referrer = typeof document !== 'undefined' ? document.referrer : '';
    if (/claude\.ai/i.test(referrer)) return true;
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (/Claude/.test(ua)) return true;
  } catch {
    /* cross-origin frame access denied / malformed location — fall through */
  }
  return false;
}

/**
 * React hook returning the user's preferred color scheme. Listens to
 * the `prefers-color-scheme` media query so the card re-themes live
 * when the user toggles between light and dark in their OS / browser
 * settings.
 *
 * Defaults to `'light'` when `window.matchMedia` is unavailable
 * (older runtimes, SSR pre-paint).
 *
 * @public
 */
export function useColorScheme(): 'light' | 'dark' {
  const getInitial = React.useCallback((): 'light' | 'dark' => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return 'light';
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }, []);

  const [scheme, setScheme] = React.useState<'light' | 'dark'>(getInitial);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent): void => {
      setScheme(e.matches ? 'dark' : 'light');
    };
    // Both `addEventListener` (modern) and `addListener` (Safari ≤13)
    // — defensive in case the runtime ships in a webview that hasn't
    // updated its MediaQueryList implementation.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler);
      return () => {
        mql.removeEventListener('change', handler);
      };
    }
    // Legacy fallback intentionally cast through unknown — older lib.dom
    // typings expose `addListener` only on the deprecated branch.
    const legacy = mql as unknown as {
      addListener: (cb: (e: MediaQueryListEvent) => void) => void;
      removeListener: (cb: (e: MediaQueryListEvent) => void) => void;
    };
    legacy.addListener(handler);
    return () => {
      legacy.removeListener(handler);
    };
  }, []);

  return scheme;
}
