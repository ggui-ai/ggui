/**
 * DTCG Theme Parser
 *
 * Converts a DtcgTheme definition into a ParsedTheme ready for CSS injection.
 * Handles two output artifacts:
 *   1. CSS custom properties (--ggui-* variables)
 *   2. @keyframes declarations
 */

import { deriveThemeVariables } from './derive-theme-variables';
import type { DtcgTheme, ParsedTheme, ThemeMode } from './types';


/** A recursive tree of DTCG tokens — leaves are DtcgToken, branches are nested records. */

/**
 * The theme's variable declarations — produced by the ONE producer,
 * {@link deriveThemeVariables} (ggui#987 §2.4), sorted by name.
 * Returns the raw lines (without a selector wrapper).
 */
function buildCssVariables(theme: DtcgTheme, mode: ThemeMode): string {
  return Object.entries(deriveThemeVariables(theme, mode))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
}

/**
 * Expand compact keyframe notation into proper CSS @keyframes.
 *
 * Input format (from theme JSON):
 *   "0%{opacity:1}50%{opacity:.6}100%{opacity:1}"
 *
 * Output:
 *   @keyframes ggui-accent-pulse {
 *     0% { opacity: 1; }
 *     50% { opacity: .6; }
 *     100% { opacity: 1; }
 *   }
 */
function expandKeyframe(name: string, compact: string): string {
  // Match keyframe stops: "0%{...}" or "from{...}" or "to{...}"
  const stopRegex = /([\d.]+%|from|to)\s*\{([^}]*)\}/g;
  const stops: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = stopRegex.exec(compact)) !== null) {
    const selector = match[1];
    const rawProps = match[2].trim();

    // Add semicolons to properties that don't have them, and ensure spacing
    const props = rawProps
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => (p.endsWith(';') ? p : `${p};`))
      .join(' ');

    stops.push(`  ${selector} { ${props} }`);
  }

  return `@keyframes ggui-${name} {\n${stops.join('\n')}\n}`;
}

/**
 * Build @keyframes CSS from the motion.keyframes tokens.
 */
function buildCssKeyframes(theme: DtcgTheme): string {
  const blocks: string[] = [];

  for (const [name, token] of Object.entries(theme.motion.keyframes)) {
    if (name.startsWith('$')) continue;
    blocks.push(expandKeyframe(name, String(token.$value)));
  }

  return blocks.join('\n\n');
}

/**
 * Parse a DtcgTheme into a ParsedTheme ready for injection.
 *
 * @param id - Unique theme identifier (e.g. "ggui", "premium-cyberpunk")
 * @param theme - Full DtcgTheme definition
 * @returns ParsedTheme with CSS strings
 */
export function parseTheme(id: string, theme: DtcgTheme, mode: ThemeMode = 'light'): ParsedTheme {
  const cssVariablesBody = buildCssVariables(theme, mode);
  const cssVariables = `:root {\n${cssVariablesBody}\n}`;
  const cssKeyframes = buildCssKeyframes(theme);

  const css = cssKeyframes
    ? `${cssVariables}\n\n${cssKeyframes}`
    : cssVariables;

  return {
    id,
    name: theme.$name,
    description: theme.$description,
    metadata: theme.$metadata,
    cssVariables,
    cssKeyframes,
    css,
  };
}

// ───── File-format entry points ─────
//
// A `ggui.json#theme` document and a registry definition are the same
// v2 document (ggui#987): both project through `deriveThemeVariables`.
// There is no duck-typed walk any more — the write door validates the
// shape and the derivation refuses a document missing a role.

/** Emit `:root { --ggui-*: value; }` for a document in one mode. */
export function generateCssVariables(theme: DtcgTheme, mode: ThemeMode = 'light'): string {
  return wrapInSelector(':root', buildCssVariables(theme, mode).split('\n'));
}

/** Same as {@link generateCssVariables}, wrapped in a caller-supplied selector (scoped previews). */
export function generateScopedCssVariables(theme: DtcgTheme, selector: string, mode: ThemeMode = 'light'): string {
  return wrapInSelector(selector, buildCssVariables(theme, mode).split('\n'));
}

/**
 * Convert a DTCG-shaped tree to a flat map of `var()` references keyed
 * by dot-notation token paths — the AUTHORED tokens only (derived
 * variables have no document path).
 * @returns `{ 'color.primary.600': 'var(--ggui-color-primary-600)' }`
 */
function tokenPathToCssVar(path: string[]): string {
  return `--ggui-${path.join('-')}`;
}

export function themeToCssVarReferences(
  theme: unknown,
): Record<string, string> {
  const refs: Record<string, string> = {};

  function traverse(obj: Record<string, unknown>, path: string[] = []) {
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('$')) continue;

      if (value !== null && typeof value === 'object' && '$value' in value) {
        const fullPath = [...path, key].join('.');
        refs[fullPath] = `var(${tokenPathToCssVar([...path, key])})`;
      } else if (value !== null && typeof value === 'object') {
        traverse(value as Record<string, unknown>, [...path, key]);
      }
    }
  }

  if (theme !== null && typeof theme === 'object') {
    traverse(theme as Record<string, unknown>);
  }
  return refs;
}


function wrapInSelector(selector: string, lines: string[]): string {
  return `${selector} {\n${lines.join('\n')}\n}`;
}

/**
 * Generate human-readable Markdown reference of the theme's CSS variables.
 * Consumed by the LLM generation pipeline to teach the model which
 * `--ggui-*` tokens are available.
 *
 * @param theme - Full {@link DtcgTheme} definition
 * @returns Markdown reference listing all emitted CSS variables
 */
export function generateThemeReferenceDocumentation(theme: DtcgTheme): string {
  const derived = deriveThemeVariables(theme, 'light');
  const byFamily = new Map<string, Array<[string, string]>>();
  for (const [name, value] of Object.entries(derived)) {
    const family = name.replace(/^--ggui-/, '').split('-')[0]!;
    const list = byFamily.get(family) ?? [];
    list.push([name, value]);
    byFamily.set(family, list);
  }
  const sections: string[] = [
    '# Design System CSS Variables',
    '',
    'Use these CSS variables in your component styles. They are the complete set a card can read — every one is emitted by every theme (ggui#987 §2.4):',
    '',
  ];
  for (const [family, entries] of byFamily) {
    sections.push(`## ${family[0]!.toUpperCase()}${family.slice(1)}`, '');
    for (const [name, value] of entries) sections.push(`- var(${name}) - ${value}`);
    sections.push('');
  }
  sections.push('## Material Role Pairs', '');
  sections.push(
    'Each tinted surface ships an `on*` foreground token. Always pair them:',
    '- `--ggui-color-container` with `--ggui-color-onContainer` (a card, a bubble, a panel)',
    '- `--ggui-color-ground` with `--ggui-color-onGround` (the page canvas)',
    '- `--ggui-color-sunken` with `--ggui-color-onSunken` (inputs at rest, wells, code)',
    '- `--ggui-color-elevated` with `--ggui-color-onElevated` (menus, popovers, modals, toasts)',
    '- `--ggui-color-heroGround` with `--ggui-color-onHeroGround` (a hero panel: brand-tinted on a light host, the ink pair on a dark one)',
    '- `--ggui-color-primary-500` with `--ggui-color-onPrimary`; `--ggui-color-primaryContainer` with `--ggui-color-onPrimaryContainer`',
    '- `--ggui-color-error-500` with `--ggui-color-onError`; `--ggui-color-errorContainer` with `--ggui-color-onErrorContainer`',
    '- `--ggui-color-tertiaryContainer` with `--ggui-color-onTertiaryContainer` (the second accent)',
    '',
    'Links read `--ggui-color-link`; the flat `--ggui-color-error` is the error tone.',
  );
  return sections.join('\n');
}
