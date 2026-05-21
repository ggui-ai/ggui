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
 * Format a token value for CSS output.
 * Arrays are joined with commas; everything else is coerced to string.
 */
function formatValue(token: DtcgToken<unknown>): string {
  const v = token.$value;
  if (Array.isArray(v)) {
    return v.join(', ');
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
  walkTokens({ duration: theme.motion.duration, easing: theme.motion.easing }, 'motion', lines);

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
