/**
 * Semantic color slots that primitives expose as typed props.
 *
 * The LLM-generation contract: structure + intent come from the
 * component author; visuals come from the theme + primitive variants.
 * Primitives that historically accepted `color?: string` /
 * `background?: string` (Text, Heading, Box, Card, Divider, Icon,
 * Link, Spinner) gave the LLM an arbitrary-string escape that
 * defeated theming — the operator's preset selection had no effect
 * on a component that hardcoded `color: '#B8FF3A'`. Hex literals
 * are a tier-0 self-check `fail`, but the deeper fix is to NEVER
 * let the LLM pass arbitrary color strings through these props.
 * Typed slot unions force the choice to land on a token family the
 * theme controls.
 *
 * **Naming convention.** Slots are named for SEMANTIC ROLE, not for
 * a specific color value. `'muted'` is "secondary text"; the theme
 * decides what muted looks like (Indigo's #4a4954 vs Claudic's quiet
 * grey vs Neon-Noir's dim cyan). Components that use slot props
 * inherit the operator's chosen visual identity automatically.
 *
 * @public
 */

/**
 * Tone slots for text-content primitives (Text, Heading, Link, Icon).
 *
 * Maps to `color: var(--ggui-color-*)`. Each slot picks the canonical
 * onSurface-family token for that semantic role:
 *
 * | slot          | token                              | use case                                    |
 * | ------------- | ---------------------------------- | ------------------------------------------- |
 * | `default`     | `--ggui-color-onSurface`           | primary body text (most common)              |
 * | `muted`       | `--ggui-color-onSurfaceVariant`    | secondary / metadata / captions             |
 * | `subtle`      | `--ggui-color-neutral-500`         | very-low-emphasis labels, hint text          |
 * | `emphasized`  | `--ggui-color-primary-700`         | accent text (branded label, tagline)         |
 * | `loud`        | `--ggui-color-primary-500`         | the strongest accent (call-to-action label)  |
 * | `success`     | `--ggui-color-success`             | success status text (semantic flat token)    |
 * | `warning`     | `--ggui-color-warning`             | warning status text (semantic flat token)    |
 * | `error`       | `--ggui-color-error`               | error status text (semantic flat token)      |
 * | `info`        | `--ggui-color-info`                | info status text (semantic flat token)       |
 * | `inverse`     | `--ggui-color-surface`             | text rendered on a dark / inverted surface    |
 * | `inherit`     | `inherit`                          | use the parent's color (nested-render case)  |
 *
 * @public
 */
export type ToneSlot =
  | 'default'
  | 'muted'
  | 'subtle'
  | 'emphasized'
  | 'loud'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'inverse'
  | 'inherit';

/**
 * Resolve a {@link ToneSlot} to the canonical CSS color expression.
 * Always emits a `var(--ggui-color-*, #fallback)` reference so
 * un-themed contexts still paint, and so the existing CHECK regex's
 * "var(--ggui-" allowance lights up cleanly.
 *
 * @public
 */
export function resolveToneCss(tone: ToneSlot): string {
  switch (tone) {
    case 'default':
      return 'var(--ggui-color-onSurface, #18181b)';
    case 'muted':
      return 'var(--ggui-color-onSurfaceVariant, #52525b)';
    case 'subtle':
      // `subtle` resolves to `neutral-500` rather than `outline`
      // (intended for borders, ~2:1 contrast on dark surfaces —
      // failed WCAG for text). Both light and dark themes ship
      // `neutral-500` as the canonical tertiary-text grey: light =
      // #6e6d74 (~5:1 on paper), dark = #5e5c70 (~4:1 on midnight).
      // Stays "barely visible" for hint-text usage but readable.
      return 'var(--ggui-color-neutral-500, #71717a)';
    case 'emphasized':
      return 'var(--ggui-color-primary-700, #0369a1)';
    case 'loud':
      return 'var(--ggui-color-primary-500, #0ea5e9)';
    case 'success':
    case 'warning':
    case 'error':
    case 'info':
      // Semantic tones resolve to FLAT semantic tokens
      // (`var(--ggui-color-success)` etc.) rather than ladder lookups
      // (`success-700`). Themes ship semantic tokens as flat values
      // per palette mode (e.g., indigo-light success = #0e9d6e,
      // indigo-dark success = #34d399); ladder lookups never resolved
      // because parsers emit the flat token only, and the hardcoded
      // fallback (#15803d) was invisible on dark surfaces. Flat
      // resolution honors per-mode brightness.
      return `var(--ggui-color-${tone}, ${SEMANTIC_TONE_FALLBACK[tone]})`;
    case 'inverse':
      return 'var(--ggui-color-surface, #ffffff)';
    case 'inherit':
      return 'inherit';
  }
}

/**
 * Per-tone hardcoded fallback for the semantic slots. Used only when
 * the theme hasn't emitted a `--ggui-color-<tone>` token. Each picks
 * a value with adequate contrast on a light surface (the historical
 * default); dark-mode users without a theme bound see a less-readable
 * but still-distinguishable shade. Prefer binding a real theme.
 */
const SEMANTIC_TONE_FALLBACK: Readonly<Record<'success' | 'warning' | 'error' | 'info', string>> = {
  success: '#15803d',
  warning: '#b45309',
  error: '#b91c1c',
  info: '#0e7490',
};

/**
 * Surface slots for container primitives (Box, Card, Stack-when-bg).
 *
 * Maps to `backgroundColor: var(--ggui-color-*)`. Each slot picks the
 * canonical surface-family token for that semantic role:
 *
 * | slot         | token                          | use case                                 |
 * | ------------ | ------------------------------ | ---------------------------------------- |
 * | `default`    | `--ggui-color-surface`         | base container (most common)              |
 * | `elevated`   | `--ggui-color-surface`         | same fill, intended for shadow + raise    |
 * | `sunken`     | `--ggui-color-surfaceVariant`  | inset / quoted region, slightly recessed  |
 * | `accent`     | `--ggui-color-primary-50`      | branded fill — "highlighted" region        |
 * | `inverted`   | `--ggui-color-onSurface`       | dark surface in light mode (testimonial,    |
 * |              |                                | code-snippet card)                          |
 * | `transparent`| `transparent`                  | no fill (defer to parent)                  |
 *
 * @public
 */
export type SurfaceSlot =
  | 'default'
  | 'elevated'
  | 'sunken'
  | 'accent'
  | 'inverted'
  | 'transparent';

/**
 * Resolve a {@link SurfaceSlot} to the canonical CSS background-color
 * expression.
 *
 * @public
 */
export function resolveSurfaceCss(surface: SurfaceSlot): string {
  switch (surface) {
    case 'default':
    case 'elevated':
      return 'var(--ggui-color-surface, #ffffff)';
    case 'sunken':
      return 'var(--ggui-color-surfaceVariant, #f4f4f5)';
    case 'accent':
      return 'var(--ggui-color-primary-50, #f0f9ff)';
    case 'inverted':
      return 'var(--ggui-color-onSurface, #18181b)';
    case 'transparent':
      return 'transparent';
  }
}
