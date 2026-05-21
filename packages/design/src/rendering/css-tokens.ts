/**
 * CSS Tokens
 *
 * Single source of truth for CSS variable injection. Derives all CSS from
 * the theme registry rather than hardcoding values, ensuring consistency
 * between the design system and all rendering contexts.
 *
 * Every public helper accepts an optional {@link ThemeMode} so callers can
 * resolve a theme's dark variant. When the requested theme has not shipped
 * a dark mode yet, the registry falls back to its `light` tokens — see
 * `themes/registry.ts` for the resolution rule.
 */

import { getTheme, getDefaultThemeId } from '../themes/index';
import type { ThemeMode } from '../themes/types';

/**
 * Get the full CSS (variables + keyframes) for the default theme.
 *
 * Equivalent to `getThemeCss(getDefaultThemeId(), mode)`.
 *
 * @param mode - Color mode (default `'light'`)
 * @returns CSS string with `:root` block and `@keyframes` declarations
 */
export function getCssTokens(mode: ThemeMode = 'light'): string {
  return getThemeCss(getDefaultThemeId(), mode);
}

/**
 * Get scoped CSS for the default theme, replacing `:root` with a class selector.
 *
 * Equivalent to `getScopedThemeCss(getDefaultThemeId(), scopeClass, mode)`.
 *
 * @param scopeClass - CSS class name to scope variables under (without leading dot)
 * @param mode - Color mode (default `'light'`)
 * @returns Scoped CSS string
 */
export function getScopedCssTokens(
  scopeClass: string,
  mode: ThemeMode = 'light'
): string {
  return getScopedThemeCss(getDefaultThemeId(), scopeClass, mode);
}

/**
 * Get the full CSS for a specific theme by ID and mode.
 *
 * Falls back to the default theme if the requested theme is not found.
 * Returns an empty string as a last resort if the default theme is also missing.
 *
 * @param themeId - Theme identifier (e.g., `'ggui'`, `'premium-cyberpunk'`)
 * @param mode - Color mode (default `'light'`)
 * @returns CSS string with `:root` block and `@keyframes` declarations
 */
export function getThemeCss(
  themeId: string,
  mode: ThemeMode = 'light'
): string {
  const theme = getTheme(themeId, mode);
  if (theme) return theme.css;

  // Fallback to default theme (avoid infinite recursion if default is also missing)
  const defaultId = getDefaultThemeId();
  if (themeId === defaultId) return '';
  const fallback = getTheme(defaultId, mode);
  return fallback ? fallback.css : '';
}

/**
 * Get scoped CSS for a specific theme, replacing `:root` with a class selector.
 *
 * Useful for rendering components inside a scoped container (or shadow DOM)
 * where `:root` would not apply. Also includes a universal
 * `box-sizing: border-box` rule scoped to the class.
 *
 * Falls back to the default theme if the requested theme is not found.
 * Returns an empty string as a last resort if the default theme is also missing.
 *
 * @param themeId - Theme identifier
 * @param scopeClass - CSS class name to scope variables under (without leading dot)
 * @param mode - Color mode (default `'light'`)
 * @returns Scoped CSS string
 */
export function getScopedThemeCss(
  themeId: string,
  scopeClass: string,
  mode: ThemeMode = 'light'
): string {
  const theme = getTheme(themeId, mode);
  if (!theme) {
    // Fallback to default theme (avoid infinite recursion if default is also missing)
    const defaultId = getDefaultThemeId();
    if (themeId === defaultId) return '';
    return getScopedThemeCss(defaultId, scopeClass, mode);
  }

  const scoped = theme.cssVariables.replace(/^:root\s*\{/, `.${scopeClass} {`);
  // Apply the theme's `font-family` + base body color to the scope
  // root so unstyled descendants (h1-h6 / button / etc — primitives
  // that don't explicitly set `font-family`) inherit the active
  // theme's sans stack instead of the user-agent default (which is
  // Times New Roman in most browsers' default stylesheets for h1-h6).
  // Same for body color so the `--ggui-color-onSurface` token
  // resolves on plain text without a Text/Heading wrapper.
  //
  // Scope root stays TRANSPARENT (no `background`). When this tree is
  // mounted inside an MCP-Apps host iframe (claude.ai, Claude Desktop)
  // the host's chat-bubble / card chrome should show through — the
  // generated UI is meant to layer onto whatever container the host
  // provides, not paint its own opaque page surface. Primitives that
  // need a real surface (Card, Modal, etc.) opt into
  // `var(--ggui-color-surface)` or `var(--ggui-color-surface-gradient)`
  // explicitly. The standalone `/r/<shortCode>` viewer that ships with
  // OSS bakes its OWN page-level background in the shell HTML for the
  // direct-browser case.
  const baseInherits = `.${scopeClass} {
  font-family: var(--ggui-font-family-sans);
  color: var(--ggui-color-onSurface);
  background-color: transparent;
}`;
  // Gradient tokens primitives can opt-in to for premium accents:
  // `--ggui-color-primary-gradient` is a confident left-to-right
  // primary-500 → primary-600 ramp suitable for hero CTAs.
  // `--ggui-effect-glow-primary` is a soft outer halo for focus /
  // hover states (drop into `box-shadow`).
  const gradientTokens = `.${scopeClass} {
  --ggui-color-primary-gradient: linear-gradient(135deg, var(--ggui-color-primary-500) 0%, var(--ggui-color-primary-600) 100%);
  --ggui-color-surface-gradient: linear-gradient(180deg, var(--ggui-color-surface) 0%, color-mix(in srgb, var(--ggui-color-primary-500) 4%, var(--ggui-color-surface)) 100%);
  --ggui-effect-glow-primary: 0 0 0 4px color-mix(in srgb, var(--ggui-color-primary-500) 18%, transparent);
  --ggui-effect-glow-primary-strong: 0 8px 24px -4px color-mix(in srgb, var(--ggui-color-primary-500) 40%, transparent), 0 0 0 1px color-mix(in srgb, var(--ggui-color-primary-500) 30%, transparent) inset;
}`;
  return `${scoped}\n${baseInherits}\n${gradientTokens}\n${theme.cssKeyframes}\n.${scopeClass} *, .${scopeClass} *::before, .${scopeClass} *::after { box-sizing: border-box; }\n.${scopeClass} h1, .${scopeClass} h2, .${scopeClass} h3, .${scopeClass} h4, .${scopeClass} h5, .${scopeClass} h6, .${scopeClass} button, .${scopeClass} input, .${scopeClass} textarea, .${scopeClass} select { font-family: inherit; }`;
}
