/**
 * Server mode detection — `'dev'` | `'prod'`.
 *
 * The server resolves `GGUI_MODE` at boot (option override > env var >
 * `'prod'` default) and surfaces the value via `/ggui/console/info` AND
 * a meta tag stamped into `index.html`. The SPA reads the meta tag
 * synchronously at module load so the first paint of `<TopNav>`
 * already knows whether to show the `/devtools` link — no flicker
 * between paint and `/info` round-trip.
 *
 * The SSR path falls back to `'prod'` since there's no DOM to read.
 * Tests can override via `setModeForTests`.
 */

export type ServerMode = 'dev' | 'prod';

const META_NAME = 'ggui-mode';

let cached: ServerMode | null = null;

export function getServerMode(): ServerMode {
  if (cached !== null) return cached;
  if (typeof document === 'undefined') return 'prod';
  const meta = document.querySelector(`meta[name="${META_NAME}"]`);
  const raw = meta?.getAttribute('content');
  cached = raw === 'dev' ? 'dev' : 'prod';
  return cached;
}

/** Test-only: force a mode and bypass DOM lookup. */
export function setModeForTests(mode: ServerMode | null): void {
  cached = mode;
}
