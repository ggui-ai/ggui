/**
 * DTCG Token Parser
 *
 * Converts DTCG tokens to CSS variables and provides utilities
 * for token reference resolution.
 */

import type { DTCGTheme, DTCGToken, DTCGTokenGroup, ShadowValue, TransitionValue } from './types';

/**
 * Convert DTCG token path to CSS variable name
 * Example: color.primary.600 → --ggui-color-primary-600
 */
function tokenPathToCssVar(path: string[]): string {
  return `--ggui-${path.join('-')}`;
}

/**
 * Format token value for CSS
 */
function formatTokenValue(token: DTCGToken): string {
  switch (token.$type) {
    case 'color':
      return token.$value as string;
    case 'dimension':
      return token.$value as string;
    case 'shadow': {
      const shadow = token.$value as ShadowValue;
      return `${shadow.offsetX} ${shadow.offsetY} ${shadow.blur} ${shadow.spread} ${shadow.color}`;
    }
    case 'fontFamily':
      return Array.isArray(token.$value)
        ? (token.$value as string[]).map((f) => `"${f}"`).join(', ')
        : (token.$value as string);
    case 'duration':
      return token.$value as string;
    case 'number':
      return String(token.$value);
    case 'transition': {
      if (typeof token.$value === 'string') return token.$value;
      const t = token.$value as TransitionValue;
      const prop = t.property ? `${t.property} ` : '';
      return `${prop}${t.duration} ${t.timingFunction}`;
    }
    default:
      return String(token.$value);
  }
}

/**
 * Parse a DTCG theme and generate `:root` CSS variable declarations.
 *
 * Recursively traverses the theme token tree, converting each token to
 * a `--ggui-*` CSS custom property. Groups are flattened into the
 * variable name using hyphens (e.g., `color.primary.600` becomes
 * `--ggui-color-primary-600`).
 *
 * The parameter is typed as {@link DTCGTokenGroup} rather than the
 * narrower {@link DTCGTheme} — the walker is duck-typed at runtime
 * (checks `$value` presence to distinguish token-leaf from group),
 * so the accepting type matches actual behavior. This lets open
 * file-format consumers (`@ggui-ai/project-config`'s
 * `ThemeDocumentV1`) pass their own structurally-DTCG document
 * without a type-laundering cast.
 *
 * @param theme - The DTCG-shaped token tree to parse. Accepts any
 *   {@link DTCGTokenGroup} — `DTCGTheme` is a compatible subtype.
 * @returns CSS string with `:root { --ggui-*: value; }` declarations
 */
export function generateCssVariables(theme: DTCGTokenGroup): string {
  const declarations: string[] = [];

  function traverse(obj: DTCGTokenGroup, path: string[] = []) {
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('$')) continue; // Skip meta properties

      if (value && typeof value === 'object' && '$value' in value) {
        // This is a token - convert to CSS variable
        const token = value as DTCGToken;
        const cssVar = tokenPathToCssVar([...path, key]);
        const cssValue = formatTokenValue(token);
        declarations.push(`  ${cssVar}: ${cssValue};`);
      } else if (value && typeof value === 'object') {
        // This is a group - recurse
        traverse(value as DTCGTokenGroup, [...path, key]);
      }
    }
  }

  traverse(theme);
  return `:root {\n${declarations.join('\n')}\n}`;
}

/**
 * Generate CSS variables scoped to a specific selector instead of `:root`.
 *
 * Useful for scoped theme previews (e.g., ThemePreview in Studio) where
 * theme tokens should only apply within a container element.
 *
 * @param theme - The DTCG theme definition to parse
 * @param selector - CSS selector to scope the variables to (e.g., `'.preview'`)
 * @returns CSS string with `selector { --ggui-*: value; }` declarations
 */
export function generateScopedCssVariables(theme: DTCGTokenGroup, selector: string): string {
  const declarations: string[] = [];

  function traverse(obj: DTCGTokenGroup, path: string[] = []) {
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('$')) continue;

      if (value && typeof value === 'object' && '$value' in value) {
        const token = value as DTCGToken;
        const cssVar = tokenPathToCssVar([...path, key]);
        const cssValue = formatTokenValue(token);
        declarations.push(`  ${cssVar}: ${cssValue};`);
      } else if (value && typeof value === 'object') {
        traverse(value as DTCGTokenGroup, [...path, key]);
      }
    }
  }

  traverse(theme);
  return `${selector} {\n${declarations.join('\n')}\n}`;
}

/**
 * Convert a DTCG theme to a flat map of CSS `var()` references.
 *
 * Returns an object keyed by dot-notation token paths, with values like
 * `var(--ggui-color-primary-600)`. Useful for TypeScript code that needs
 * to reference theme tokens programmatically.
 *
 * @param theme - The DTCG theme definition to convert
 * @returns Flat map of `{ 'color.primary.600': 'var(--ggui-color-primary-600)' }`
 */
export function themeToCssVarReferences(theme: DTCGTokenGroup): Record<string, string> {
  const refs: Record<string, string> = {};

  function traverse(obj: DTCGTokenGroup, path: string[] = []) {
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('$')) continue;

      if (value && typeof value === 'object' && '$value' in value) {
        const fullPath = [...path, key].join('.');
        const cssVar = tokenPathToCssVar([...path, key]);
        refs[fullPath] = `var(${cssVar})`;
      } else if (value && typeof value === 'object') {
        traverse(value as DTCGTokenGroup, [...path, key]);
      }
    }
  }

  traverse(theme);
  return refs;
}

/**
 * Generate human-readable CSS variable documentation for the LLM pipeline.
 *
 * Produces a markdown-formatted reference listing all available CSS
 * variables organized by category (Colors, Spacing, Typography, etc.).
 * This output is injected into the Claude generation prompt so the LLM
 * knows which design tokens are available.
 *
 * @param theme - The DTCG theme definition to document
 * @returns Markdown string listing all CSS variables with their values
 */
export function generateCssVariableDocumentation(theme: DTCGTheme): string {
  const sections: string[] = [
    '# Design System CSS Variables',
    '',
    'Use these CSS variables in your component styles:',
    '',
  ];

  // Colors
  sections.push('## Colors', '');
  Object.entries(theme.color).forEach(([key, value]) => {
    if (typeof value === 'object' && '$value' in value) {
      const token = value as DTCGToken;
      sections.push(`- var(--ggui-color-${key}) - ${token.$value}`);
    } else if (typeof value === 'object') {
      Object.entries(value).forEach(([shade, token]) => {
        if ('$value' in token) {
          sections.push(`- var(--ggui-color-${key}-${shade}) - ${token.$value}`);
        }
      });
    }
  });

  // Spacing
  sections.push('', '## Spacing', '');
  Object.entries(theme.spacing).forEach(([key, token]) => {
    sections.push(`- var(--ggui-spacing-${key}) - ${token.$value}`);
  });

  // Typography
  sections.push('', '## Typography', '');
  sections.push('### Font Families');
  Object.entries(theme.typography.fontFamily).forEach(([key, token]) => {
    const families = Array.isArray(token.$value) ? token.$value.join(', ') : token.$value;
    sections.push(`- var(--ggui-font-family-${key}) - ${families}`);
  });
  sections.push('', '### Font Sizes');
  Object.entries(theme.typography.fontSize).forEach(([key, token]) => {
    sections.push(`- var(--ggui-font-size-${key}) - ${token.$value}`);
  });
  sections.push('', '### Font Weights');
  Object.entries(theme.typography.fontWeight).forEach(([key, token]) => {
    sections.push(`- var(--ggui-font-weight-${key}) - ${token.$value}`);
  });
  sections.push('', '### Line Heights');
  Object.entries(theme.typography.lineHeight).forEach(([key, token]) => {
    sections.push(`- var(--ggui-font-lineHeight-${key}) - ${token.$value}`);
  });

  // Radius
  sections.push('', '## Border Radius', '');
  Object.entries(theme.radius).forEach(([key, token]) => {
    sections.push(`- var(--ggui-radius-${key}) - ${token.$value}`);
  });

  // Shadows
  sections.push('', '## Shadows', '');
  Object.entries(theme.shadow).forEach(([key, token]) => {
    const shadow = token.$value;
    sections.push(
      `- var(--ggui-shadow-${key}) - ${shadow.offsetX} ${shadow.offsetY} ${shadow.blur} ${shadow.spread} ${shadow.color}`
    );
  });

  // Transitions
  if (theme.duration) {
    sections.push('', '## Durations', '');
    Object.entries(theme.duration).forEach(([key, token]) => {
      sections.push(`- var(--ggui-duration-${key}) - ${token.$value}`);
    });
  }

  if (theme.transition) {
    sections.push('', '## Transitions', '');
    Object.entries(theme.transition).forEach(([key, token]) => {
      const val = token.$value;
      const display = typeof val === 'string' ? val : `${(val as TransitionValue).duration} ${(val as TransitionValue).timingFunction}`;
      sections.push(`- var(--ggui-transition-${key}) - ${display}`);
    });
  }

  if (theme.accessibility) {
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
  }

  return sections.join('\n');
}
