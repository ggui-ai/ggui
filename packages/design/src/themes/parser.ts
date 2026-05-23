/**
 * DTCG Theme Parser
 *
 * Converts a DtcgTheme definition into a ParsedTheme ready for CSS injection.
 * Handles three output artifacts:
 *   1. CSS custom properties (--ggui-* variables)
 *   2. @keyframes declarations
 *   3. Canvas configuration object
 */

import type { DtcgTheme, DtcgToken, ParsedTheme } from './types';

/**
 * Format a DTCG token value for CSS output.
 *
 * Most token types (`color`, `dimension`, `fontFamily`, `fontWeight`,
 * `duration`, `cubicBezier`, `number`, `string`, `transition`-as-string)
 * ship their `$value` as a CSS-ready string and pass through unchanged.
 *
 * Two DTCG-spec composite types may ship as structured objects when the
 * theme came from an operator-authored {@link ThemeDocument} file:
 *
 *   - `shadow` → `{ offsetX, offsetY, blur, spread, color }`
 *     → composes to `${offsetX} ${offsetY} ${blur} ${spread} ${color}`
 *   - `transition` → `{ duration, timingFunction, property? }`
 *     → composes to `${property} ${duration} ${timingFunction}` (no
 *       property when absent)
 *
 * Arrays (e.g. canvas `colors`) are comma-joined.
 */
function formatValue(token: DtcgToken<unknown>): string {
  const v = token.$value;
  if (Array.isArray(v)) {
    return v.join(', ');
  }
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (token.$type === 'shadow' && 'offsetX' in obj) {
      return `${obj.offsetX} ${obj.offsetY} ${obj.blur} ${obj.spread} ${obj.color}`;
    }
    if (token.$type === 'transition' && 'duration' in obj && 'timingFunction' in obj) {
      const prop = typeof obj.property === 'string' && obj.property ? `${obj.property} ` : '';
      return `${prop}${obj.duration} ${obj.timingFunction}`;
    }
    // Unknown composite — coerce to string (will surface as `[object Object]`
    // for the operator to debug; this is intentional, since silently emitting
    // a broken CSS value would hide the misconfiguration).
  }
  return String(v);
}

/** A recursive tree of DTCG tokens — leaves are DtcgToken, branches are nested records. */
type DtcgTokenTree = { [key: string]: DtcgToken<unknown> | DtcgTokenTree };

/**
 * Walk a tree of DtcgTokens and emit CSS variable declarations.
 * Recursively handles nested records (e.g. font.family.sans).
 */
function walkTokens(
  obj: DtcgTokenTree,
  prefix: string,
  out: string[]
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('$')) continue;

    if (value !== null && typeof value === 'object' && '$value' in value) {
      out.push(`  --ggui-${prefix}-${key}: ${formatValue(value as DtcgToken<unknown>)};`);
    } else if (value !== null && typeof value === 'object') {
      walkTokens(value as DtcgTokenTree, `${prefix}-${key}`, out);
    }
  }
}

/**
 * Build CSS custom property declarations from a DtcgTheme.
 * Returns the raw lines (without :root wrapper).
 */
function buildCssVariables(theme: DtcgTheme): string {
  const lines: string[] = [];

  walkTokens(theme.color, 'color', lines);
  walkTokens(theme.font, 'font', lines);
  walkTokens(theme.spacing, 'spacing', lines);
  walkTokens(theme.shape, 'shape', lines);
  walkTokens(
    {
      duration: theme.motion.duration,
      easing: theme.motion.easing,
      transition: theme.motion.transition,
    },
    'motion',
    lines
  );
  walkTokens(theme.accessibility, 'accessibility', lines);
  walkTokens(theme.zIndex, 'zIndex', lines);

  // Canvas tokens
  lines.push(`  --ggui-canvas-mode: ${theme.canvas.mode.$value};`);
  lines.push(`  --ggui-canvas-speed: ${theme.canvas.speed.$value};`);
  lines.push(`  --ggui-canvas-background: ${theme.canvas.background.$value};`);

  return lines.join('\n');
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
 * @returns ParsedTheme with CSS strings and canvas config
 */
export function parseTheme(id: string, theme: DtcgTheme): ParsedTheme {
  const cssVariablesBody = buildCssVariables(theme);
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
    canvasConfig: {
      mode: theme.canvas.mode.$value,
      speed: theme.canvas.speed.$value,
      colors: theme.canvas.colors.$value,
      background: String(theme.canvas.background.$value),
    },
  };
}

// ───── Duck-typed walker helpers (used by file-format consumers) ─────
//
// These helpers walk any DTCG-shaped token tree (including the open
// `ThemeDocument` plain-DTCG file format from `@ggui-ai/project-config`)
// without requiring the strict `DtcgTheme` shape. They power the
// `loadTheme({ file })` path where operators ship Figma-Tokens /
// Style-Dictionary output that may not include `motion`/`canvas`.

/**
 * Convert DTCG token path to CSS variable name.
 * Example: `['color','primary','600']` → `--ggui-color-primary-600`.
 */
function tokenPathToCssVar(path: string[]): string {
  return `--ggui-${path.join('-')}`;
}

/**
 * Recursively walk a DTCG-shaped tree and emit `:root { --ggui-*: value; }`
 * declarations. Accepts any tree of `{ $value, $type }` leaves and nested
 * groups (duck-typed) — used for plain DTCG documents that may not
 * conform to the full {@link DtcgTheme} shape.
 *
 * @param theme - Any DTCG-shaped token tree
 * @returns CSS string `:root { --ggui-*: value; }`
 */
export function generateCssVariables(theme: unknown): string {
  return wrapInSelector(':root', emitDuckTyped(theme));
}

/**
 * Same as {@link generateCssVariables} but wraps the declarations in
 * a caller-supplied selector. Useful for scoped previews.
 *
 * @param theme - Any DTCG-shaped token tree
 * @param selector - CSS selector to scope the variables to (e.g. `.preview`)
 */
export function generateScopedCssVariables(
  theme: unknown,
  selector: string,
): string {
  return wrapInSelector(selector, emitDuckTyped(theme));
}

/**
 * Convert a DTCG-shaped tree to a flat map of `var()` references keyed
 * by dot-notation token paths. Useful for TypeScript code that needs
 * to reference theme tokens programmatically.
 *
 * @returns `{ 'color.primary.600': 'var(--ggui-color-primary-600)' }`
 */
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

function emitDuckTyped(theme: unknown): string[] {
  const declarations: string[] = [];

  function traverse(obj: Record<string, unknown>, path: string[] = []) {
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('$')) continue;

      if (value !== null && typeof value === 'object' && '$value' in value) {
        const cssVar = tokenPathToCssVar([...path, key]);
        const formatted = formatValue(value as DtcgToken<unknown>);
        declarations.push(`  ${cssVar}: ${formatted};`);
      } else if (value !== null && typeof value === 'object') {
        traverse(value as Record<string, unknown>, [...path, key]);
      }
    }
  }

  if (theme !== null && typeof theme === 'object') {
    traverse(theme as Record<string, unknown>);
  }
  return declarations;
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
  const sections: string[] = [
    '# Design System CSS Variables',
    '',
    'Use these CSS variables in your component styles:',
    '',
  ];

  // Colors — handles both scales (Record<string,DtcgToken>) and singletons.
  sections.push('## Colors', '');
  for (const [key, value] of Object.entries(theme.color)) {
    if (value !== null && typeof value === 'object' && '$value' in value) {
      sections.push(`- var(--ggui-color-${key}) - ${formatValue(value as DtcgToken<unknown>)}`);
    } else if (value !== null && typeof value === 'object') {
      for (const [shade, token] of Object.entries(value as Record<string, DtcgToken>)) {
        sections.push(`- var(--ggui-color-${key}-${shade}) - ${token.$value}`);
      }
    }
  }

  sections.push('', '## Spacing', '');
  for (const [key, token] of Object.entries(theme.spacing)) {
    sections.push(`- var(--ggui-spacing-${key}) - ${token.$value}`);
  }

  sections.push('', '## Typography', '');
  sections.push('### Font Families');
  for (const [key, token] of Object.entries(theme.font.family)) {
    if (token) sections.push(`- var(--ggui-font-family-${key}) - ${token.$value}`);
  }
  sections.push('', '### Font Sizes');
  for (const [key, token] of Object.entries(theme.font.size)) {
    sections.push(`- var(--ggui-font-size-${key}) - ${token.$value}`);
  }
  sections.push('', '### Font Weights');
  for (const [key, token] of Object.entries(theme.font.weight)) {
    sections.push(`- var(--ggui-font-weight-${key}) - ${token.$value}`);
  }
  sections.push('', '### Line Heights');
  for (const [key, token] of Object.entries(theme.font.lineHeight)) {
    sections.push(`- var(--ggui-font-lineHeight-${key}) - ${token.$value}`);
  }

  sections.push('', '## Border Radius', '');
  for (const [key, token] of Object.entries(theme.shape.radius)) {
    sections.push(`- var(--ggui-shape-radius-${key}) - ${token.$value}`);
  }

  sections.push('', '## Shadows', '');
  for (const [key, token] of Object.entries(theme.shape.shadow)) {
    sections.push(`- var(--ggui-shape-shadow-${key}) - ${token.$value}`);
  }

  sections.push('', '## Durations', '');
  for (const [key, token] of Object.entries(theme.motion.duration)) {
    sections.push(`- var(--ggui-motion-duration-${key}) - ${token.$value}`);
  }

  sections.push('', '## Transitions', '');
  for (const [key, token] of Object.entries(theme.motion.transition)) {
    sections.push(`- var(--ggui-motion-transition-${key}) - ${token.$value}`);
  }

  sections.push('', '## Accessibility', '');
  sections.push('### Focus Ring');
  sections.push(`- var(--ggui-accessibility-focusRing-color) - ${theme.accessibility.focusRing.color.$value}`);
  sections.push(`- var(--ggui-accessibility-focusRing-width) - ${theme.accessibility.focusRing.width.$value}`);
  sections.push(`- var(--ggui-accessibility-focusRing-offset) - ${theme.accessibility.focusRing.offset.$value}`);
  sections.push('', '### Reduced Motion');
  sections.push(`- var(--ggui-accessibility-reducedMotion-duration) - ${theme.accessibility.reducedMotion.duration.$value}`);
  sections.push('', '### High Contrast');
  sections.push(`- var(--ggui-accessibility-highContrast-borderWidth) - ${theme.accessibility.highContrast.borderWidth.$value}`);
  sections.push(`- var(--ggui-accessibility-highContrast-textColor) - ${theme.accessibility.highContrast.textColor.$value}`);
  sections.push(`- var(--ggui-accessibility-highContrast-backgroundColor) - ${theme.accessibility.highContrast.backgroundColor.$value}`);
  sections.push(`- var(--ggui-accessibility-highContrast-linkColor) - ${theme.accessibility.highContrast.linkColor.$value}`);

  return sections.join('\n');
}
