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
 *
 * ## `color-mix()` two-tier fallback
 *
 * Several tokens bake `color-mix()` so elevation/glow/surface ramps carry
 * a primary-accent tint that adapts per color mode at runtime:
 *   - the `--ggui-shape-shadow-*` tokens (indigo/claudic themes), and
 *   - the scoped `--ggui-color-surface-gradient` / `--ggui-effect-glow-*`
 *     tokens emitted below.
 *
 * Browsers without `color-mix()` support (Safari <16.2, Firefox <113) drop
 * any declaration whose value they cannot parse, so those tokens would
 * vanish entirely (shadows/glow gone, surface ramp flattened to white).
 * To keep the design intact on modern browsers AND degrade gracefully on
 * old ones, every `color-mix()` token is emitted as two tiers:
 *   1. a STATIC fallback (precomputed `rgba()` / flat gradient) FIRST, then
 *   2. the original `color-mix()` value re-declared inside an
 *      `@supports (color: color-mix(...))` block.
 * Modern browsers apply the second tier and render exactly as before; old
 * browsers stop at the first tier and keep a sane tinted fallback. The
 * emitter resolves the theme per mode, so the static fallback is computed
 * from that mode's own `primary-500` hex — no mode's tint is frozen.
 */

import { getTheme, getDefaultThemeId } from '../themes/index';
import type { ThemeMode } from '../themes/types';

/**
 * `@supports` query that gates the modern `color-mix()` tier of every
 * tinted token. Browsers that pass it (Chrome 111+, Safari 16.2+,
 * Firefox 113+) re-declare the color-mix values and keep the exact
 * design; browsers that fail it keep the static `rgba()` fallback emitted
 * just before. Probing `red`/`blue` (not theme tokens) keeps the query a
 * pure feature test.
 */
const COLOR_MIX_SUPPORTS = '@supports (color: color-mix(in srgb, red, blue))';

/**
 * Resolve a theme's literal `primary-500` hex from its emitted CSS
 * variable declarations (`--ggui-color-primary-500: #rrggbb;`). The value
 * adapts per mode (light vs dark ladders resolve different hexes), so
 * reading it back from the parsed variables keeps the static fallback in
 * lockstep with whichever mode is being rendered.
 *
 * Returns `null` when the variable is absent or not a 3/6-digit hex —
 * callers then skip fallback emission and rely on the color-mix value
 * alone (no worse than before this fallback existed).
 */
function resolvePrimary500Hex(cssVariables: string): string | null {
  const match = cssVariables.match(
    /--ggui-color-primary-500:\s*(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})\s*;/
  );
  return match ? match[1] : null;
}

/** Parse a 3- or 6-digit hex color into 0-255 channels. */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length !== 6) return null;
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

/**
 * Replace every `color-mix(in srgb, var(--ggui-color-primary-500) N%,
 * transparent)` occurrence in a value with the equivalent
 * `rgba(r, g, b, N/100)`. For an opaque source color mixed with
 * `transparent`, the two are pixel-identical, so the static fallback
 * matches the modern look exactly — it just doesn't track runtime
 * `--ggui-color-primary-500` overrides (acceptable for the old-browser
 * floor). Any other `color-mix()` form (e.g. mixed against a surface
 * color) is left untouched.
 */
function precomputePrimaryColorMix(
  value: string,
  primary500Hex: string
): string {
  const rgb = hexToRgb(primary500Hex);
  if (!rgb) return value;
  return value.replace(
    /color-mix\(\s*in srgb\s*,\s*var\(--ggui-color-primary-500\)\s+(\d+(?:\.\d+)?)%\s*,\s*transparent\s*\)/g,
    (_match, pct: string) => {
      const alpha = Number(pct) / 100;
      // Trim trailing zeros so `0.18`/`0.4` read clean in output.
      const a = Number(alpha.toFixed(4)).toString();
      return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
    }
  );
}

/**
 * Split a `:root { ... }` / `.scope { ... }` variable block into the
 * declaration lines that use `color-mix()` and those that don't. Used to
 * lift only the color-mix declarations into the two-tier `@supports`
 * layer while leaving plain declarations in the base block untouched.
 */
function partitionColorMixDeclarations(block: string): {
  base: string;
  colorMix: string[];
} {
  const open = block.indexOf('{');
  const close = block.lastIndexOf('}');
  if (open === -1 || close === -1) return { base: block, colorMix: [] };
  const selector = block.slice(0, open + 1);
  const body = block.slice(open + 1, close);
  const baseLines: string[] = [];
  const colorMixLines: string[] = [];
  for (const rawLine of body.split('\n')) {
    if (rawLine.trim() === '') continue;
    if (rawLine.includes('color-mix(')) colorMixLines.push(rawLine);
    else baseLines.push(rawLine);
  }
  return {
    base: `${selector}\n${baseLines.join('\n')}\n}`,
    colorMix: colorMixLines,
  };
}

/**
 * Wrap a parsed `:root`/`.scope` variable block so `color-mix()`-based
 * tokens (e.g. the indigo/claudic `--ggui-shape-shadow-*` shadows) degrade
 * gracefully on old browsers. Emits, in order:
 *
 *   1. the base block (non-color-mix declarations) unchanged;
 *   2. a STATIC fallback block re-declaring each color-mix token with a
 *      precomputed per-mode `rgba()` so old browsers keep the tinted
 *      shadow instead of dropping it entirely;
 *   3. an `@supports` block re-declaring the original color-mix tokens so
 *      modern browsers render the exact, runtime-adaptive value.
 *
 * `selectorPrefix` is the `:root` or `.scopeClass` selector the block is
 * scoped to. When the theme exposes no resolvable primary-500 hex, or the
 * block has no color-mix tokens, it is returned unchanged.
 */
function withColorMixFallback(
  block: string,
  selectorPrefix: string,
  primary500Hex: string | null
): string {
  if (!primary500Hex || !block.includes('color-mix(')) return block;
  const { base, colorMix } = partitionColorMixDeclarations(block);
  if (colorMix.length === 0) return block;
  const fallbackLines = colorMix.map((line) =>
    precomputePrimaryColorMix(line, primary500Hex)
  );
  const fallbackBlock = `${selectorPrefix} {\n${fallbackLines.join('\n')}\n}`;
  const modernBlock = `${COLOR_MIX_SUPPORTS} {\n  ${selectorPrefix} {\n${colorMix.join('\n')}\n  }\n}`;
  return `${base}\n${fallbackBlock}\n${modernBlock}`;
}

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
  if (theme) {
    // Wrap the `:root` variables so any `color-mix()` shadow token degrades
    // gracefully (per-mode rgba fallback + `@supports` modern re-declare).
    const primary500 = resolvePrimary500Hex(theme.cssVariables);
    const variables = withColorMixFallback(
      theme.cssVariables,
      ':root',
      primary500
    );
    return theme.cssKeyframes
      ? `${variables}\n\n${theme.cssKeyframes}`
      : variables;
  }

  // Fallback to default theme (avoid infinite recursion if default is also missing)
  const defaultId = getDefaultThemeId();
  if (themeId === defaultId) return '';
  return getThemeCss(defaultId, mode);
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

  // Resolve the theme's literal primary-500 hex from the emitted CSS
  // variables. Used to compute STATIC rgba()/flat-gradient fallbacks for
  // the `color-mix()`-based effect tokens below (and the color-mix shadow
  // tokens) so browsers without `color-mix()` support (Safari <16.2,
  // Firefox <113) still render a tinted shadow + glow + surface ramp
  // instead of dropping the whole declaration.
  const primary500 = resolvePrimary500Hex(theme.cssVariables);
  // Scope the parsed `:root` variables to the class, then split any
  // `color-mix()`-based custom property (e.g. the indigo/claudic shadow
  // tokens) into a precomputed-rgba fallback + an `@supports`-gated modern
  // re-declaration. Modern browsers keep the EXACT per-mode color-mix
  // value; older Safari/FF get the per-mode rgba so the shadow's tint
  // survives instead of the whole declaration being dropped.
  const scoped = withColorMixFallback(
    theme.cssVariables.replace(/^:root\s*\{/, `.${scopeClass} {`),
    `.${scopeClass}`,
    primary500
  );
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
  // Gradient + effect tokens primitives can opt-in to for premium accents.
  // `--ggui-color-primary-gradient` is a confident left-to-right
  // primary-500 → primary-600 ramp suitable for hero CTAs (no color-mix —
  // valid everywhere). `--ggui-color-surface-gradient` /
  // `--ggui-effect-glow-primary` / `--ggui-effect-glow-primary-strong`
  // bake `color-mix()`, so they ship a static fallback + an `@supports`
  // modern tier (see `buildGradientTokens`).
  const gradientTokens = buildGradientTokens(scopeClass, primary500);
  return `${scoped}\n${baseInherits}\n${gradientTokens}\n${theme.cssKeyframes}\n.${scopeClass} *, .${scopeClass} *::before, .${scopeClass} *::after { box-sizing: border-box; }\n.${scopeClass} h1, .${scopeClass} h2, .${scopeClass} h3, .${scopeClass} h4, .${scopeClass} h5, .${scopeClass} h6, .${scopeClass} button, .${scopeClass} input, .${scopeClass} textarea, .${scopeClass} select { font-family: inherit; }`;
}

/**
 * Build the scoped gradient + glow effect tokens with a two-tier
 * `@supports` fallback. These tokens are emitted by the scoped helper
 * (not the theme parser), so the fallback is constructed here rather than
 * routed through {@link withColorMixFallback}: the surface-gradient mixes
 * against a SURFACE color (not `transparent`), so its old-browser fallback
 * is a FLAT surface ramp — never white/none — while the two glow tokens
 * mix against `transparent` and precompute to an exact `rgba()`.
 *
 * Modern browsers (Chrome 111+, Safari 16.2+, Firefox 113+) re-declare and
 * render the exact color-mix values; older browsers keep the static layer.
 * When no primary-500 hex resolves, only the color-mix layer is emitted
 * (no regression vs. before this fallback existed).
 */
function buildGradientTokens(
  scopeClass: string,
  primary500Hex: string | null
): string {
  const selector = `.${scopeClass}`;
  // `--ggui-color-primary-gradient` has no color-mix — always valid.
  const primaryGradient = `  --ggui-color-primary-gradient: linear-gradient(135deg, var(--ggui-color-primary-500) 0%, var(--ggui-color-primary-600) 100%);`;
  // Modern color-mix declarations (the current, exact look).
  const surfaceGradientModern = `  --ggui-color-surface-gradient: linear-gradient(180deg, var(--ggui-color-surface) 0%, color-mix(in srgb, var(--ggui-color-primary-500) 4%, var(--ggui-color-surface)) 100%);`;
  const glowModern = `  --ggui-effect-glow-primary: 0 0 0 4px color-mix(in srgb, var(--ggui-color-primary-500) 18%, transparent);`;
  const glowStrongModern = `  --ggui-effect-glow-primary-strong: 0 8px 24px -4px color-mix(in srgb, var(--ggui-color-primary-500) 40%, transparent), 0 0 0 1px color-mix(in srgb, var(--ggui-color-primary-500) 30%, transparent) inset;`;

  // Without a resolvable primary hex we can't compute the rgba fallback,
  // so emit color-mix-only (same as the pre-fix behavior).
  if (!primary500Hex) {
    return `${selector} {\n${primaryGradient}\n${surfaceGradientModern}\n${glowModern}\n${glowStrongModern}\n}`;
  }

  // STATIC fallbacks (no color-mix). Flat surface gradient never collapses
  // to white/none; glow tints precompute to exact rgba (mix-vs-transparent
  // == rgba, so identical to the modern value on modern browsers).
  const surfaceGradientFallback = `  --ggui-color-surface-gradient: linear-gradient(180deg, var(--ggui-color-surface) 0%, var(--ggui-color-surface) 100%);`;
  const glowFallback = `  --ggui-effect-glow-primary: ${precomputePrimaryColorMix(
    '0 0 0 4px color-mix(in srgb, var(--ggui-color-primary-500) 18%, transparent)',
    primary500Hex
  )};`;
  const glowStrongFallback = `  --ggui-effect-glow-primary-strong: ${precomputePrimaryColorMix(
    '0 8px 24px -4px color-mix(in srgb, var(--ggui-color-primary-500) 40%, transparent), 0 0 0 1px color-mix(in srgb, var(--ggui-color-primary-500) 30%, transparent) inset',
    primary500Hex
  )};`;

  const baseBlock = `${selector} {\n${primaryGradient}\n${surfaceGradientFallback}\n${glowFallback}\n${glowStrongFallback}\n}`;
  const modernBlock = `${COLOR_MIX_SUPPORTS} {\n  ${selector} {\n${surfaceGradientModern}\n${glowModern}\n${glowStrongModern}\n  }\n}`;
  return `${baseBlock}\n${modernBlock}`;
}
