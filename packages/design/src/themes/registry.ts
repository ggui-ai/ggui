/**
 * Theme Registry
 *
 * Central registry of all available DtcgTheme definitions, keyed by
 * stable theme id and color mode. The `(id, mode)` shape lets a
 * project pick `theme: 'claudic'` and have it render light + dark
 * with a single switch (e.g. console /theme picker, OS
 * `prefers-color-scheme`, or `ggui.json#theme.mode`).
 *
 * **Mode fallback.** Themes registered with only a `light` variant
 * resolve `mode: 'dark'` to the light tokens — never undefined. This
 * keeps the API stable for any future single-mode preset, even though
 * every preset currently in the registry ships both modes.
 */

import type {
  DtcgTheme,
  ParsedTheme,
  ThemeEntry,
  ThemeMode,
  ThemeRegistration,
} from './types';
import { parseTheme } from './parser';

import { theme as gguiTheme } from './definitions/ggui';
import { theme as cyberpunkTheme } from './definitions/premium-cyberpunk';
import { theme as zenTheme } from './definitions/premium-zen';
import { theme as neonNoirTheme } from './definitions/premium-neon-noir';
import { theme as botanicalTheme } from './definitions/premium-botanical';
import { theme as claudicTheme } from './definitions/claudic';
import { theme as indigoTheme } from './definitions/indigo';

/** All registered themes keyed by ID */
const themes = new Map<string, ThemeRegistration>([
  ['ggui', gguiTheme],
  ['indigo', indigoTheme],
  ['claudic', claudicTheme],
  ['premium-cyberpunk', cyberpunkTheme],
  ['premium-zen', zenTheme],
  ['premium-neon-noir', neonNoirTheme],
  ['premium-botanical', botanicalTheme],
]);

/**
 * Cache of parsed themes to avoid re-parsing on every call.
 *
 * Keyed by `${id}:${mode}` because the parsed CSS differs between
 * light and dark variants of the same theme id.
 */
const parsedCache = new Map<string, ParsedTheme>();

/**
 * Resolve a requested mode against a registration.
 *
 * Returns the requested mode when the registration ships it,
 * otherwise falls back to `'light'`. Centralizes the
 * "dark falls back to light when missing" rule.
 */
function resolveMode(reg: ThemeRegistration, requested: ThemeMode): ThemeMode {
  if (requested === 'dark' && reg.dark) return 'dark';
  return 'light';
}

/**
 * Get a parsed theme by ID and color mode.
 *
 * Parses the raw {@link DtcgTheme} on first access and caches the result
 * keyed by `(id, resolvedMode)`. Returns `undefined` only when the theme
 * id is unregistered — when a theme has no `dark` variant, the request
 * resolves to its `light` tokens rather than returning `undefined`.
 *
 * @param id - Theme identifier (e.g., `'ggui'`, `'claudic'`)
 * @param mode - Color mode (default `'light'`)
 * @returns Parsed theme with CSS variables, or `undefined`
 */
export function getTheme(
  id: string,
  mode: ThemeMode = 'light'
): ParsedTheme | undefined {
  const reg = themes.get(id);
  if (!reg) return undefined;

  const resolvedMode = resolveMode(reg, mode);
  const cacheKey = `${id}:${resolvedMode}`;
  const cached = parsedCache.get(cacheKey);
  if (cached) return cached;

  const raw = resolvedMode === 'dark' ? reg.dark! : reg.light;
  const parsed = parseTheme(id, raw);
  parsedCache.set(cacheKey, parsed);
  return parsed;
}

/**
 * Get the raw {@link DtcgTheme} definition by ID and mode.
 *
 * Useful when you need the token tree for programmatic access
 * (e.g. the console token editor) rather than the parsed CSS output.
 *
 * @param id - Theme identifier
 * @param mode - Color mode (default `'light'`)
 * @returns Raw theme definition, or `undefined` if id not found
 */
export function getRawTheme(
  id: string,
  mode: ThemeMode = 'light'
): DtcgTheme | undefined {
  const reg = themes.get(id);
  if (!reg) return undefined;
  const resolvedMode = resolveMode(reg, mode);
  return resolvedMode === 'dark' ? reg.dark : reg.light;
}

/**
 * List all available themes as metadata entries for the picker UI.
 *
 * Returns an array of {@link ThemeEntry} objects in registry insertion
 * order — the default theme (`ggui`) registers first and lands at the
 * top. Each entry exposes the color modes it ships via `modes` so the
 * picker can render a "dark unavailable" indicator for legacy
 * single-mode presets.
 *
 * @returns Theme metadata entries in registry order
 */
export function listThemes(): ThemeEntry[] {
  const entries: ThemeEntry[] = [];
  for (const [id, reg] of themes) {
    const modes: ThemeMode[] = reg.dark ? ['light', 'dark'] : ['light'];
    entries.push({
      id,
      name: reg.light.$name,
      description: reg.light.$description,
      metadata: reg.light.$metadata,
      modes,
    });
  }

  return entries;
}

/**
 * Get the default theme ID.
 *
 * @returns `'ggui'` (the ggui built-in theme)
 */
export function getDefaultThemeId(): string {
  return 'ggui';
}

/**
 * Get all registered theme IDs.
 *
 * @returns Array of theme ID strings (e.g., `['ggui', 'premium-cyberpunk', ...]`)
 */
export function getThemeIds(): string[] {
  return Array.from(themes.keys());
}
