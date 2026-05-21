/**
 * Spacing scale that layout primitives expose as typed prop values.
 *
 * The LLM-generation contract: spacing decisions land on a small,
 * regular t-shirt scale — never an arbitrary pixel value. Historically
 * `gap` / `padding` / `margin` were typed `number | string` and the
 * resolver passed strings straight through, so `gap="sm"` emitted the
 * literal CSS `gap: sm` — invalid, silently dropped by the browser,
 * collapsing the gap to `0`. The system prompt taught the t-shirt
 * names as if they were real; the design package never honored them.
 *
 * This module closes that drift: a {@link SpacingScale} name resolves
 * to its `--ggui-spacing-*` token, exactly the way `shadow` / `radius`
 * resolve via their maps in `Card`. The runtime emits
 * `--ggui-spacing-{xs,sm,md,lg,xl,2xl}` from every theme's DTCG
 * `spacing` block, so the names always paint.
 *
 * `number` (treated as pixels) and arbitrary CSS strings
 * (`"var(--ggui-spacing-4)"`, `"1rem"`, `"clamp(...)"`) remain a valid
 * escape hatch — the resolver only maps the known scale names and
 * passes everything else through unchanged.
 *
 * @public
 */

/**
 * The spacing t-shirt scale. Each name maps to a `--ggui-spacing-*`
 * token. Values track the canonical DTCG spacing block:
 *
 * | name   | token                  | fallback |
 * | ------ | ---------------------- | -------- |
 * | `none` | —                      | `0`      |
 * | `xs`   | `--ggui-spacing-xs`    | `4px`    |
 * | `sm`   | `--ggui-spacing-sm`    | `8px`    |
 * | `md`   | `--ggui-spacing-md`    | `16px`   |
 * | `lg`   | `--ggui-spacing-lg`    | `24px`   |
 * | `xl`   | `--ggui-spacing-xl`    | `32px`   |
 * | `2xl`  | `--ggui-spacing-2xl`   | `48px`   |
 *
 * @public
 */
export type SpacingScale = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

/**
 * A spacing prop value: a {@link SpacingScale} name (preferred), a
 * `number` of pixels, or an arbitrary CSS length string (escape hatch).
 *
 * @public
 */
export type SpacingValue = SpacingScale | number | string;

const SPACING_SCALE_TOKEN: Readonly<Record<SpacingScale, string>> = {
  none: '0',
  xs: 'var(--ggui-spacing-xs, 4px)',
  sm: 'var(--ggui-spacing-sm, 8px)',
  md: 'var(--ggui-spacing-md, 16px)',
  lg: 'var(--ggui-spacing-lg, 24px)',
  xl: 'var(--ggui-spacing-xl, 32px)',
  '2xl': 'var(--ggui-spacing-2xl, 48px)',
};

const SPACING_SCALE_NAMES: ReadonlySet<string> = new Set(
  Object.keys(SPACING_SCALE_TOKEN),
);

/**
 * Resolve a spacing prop value to a CSS length expression.
 *
 * - a {@link SpacingScale} name → `var(--ggui-spacing-NAME, fallback)`
 * - a `number` → `${n}px`
 * - any other string → passed through verbatim (escape hatch)
 * - `undefined` → `undefined` (no declaration emitted)
 *
 * @public
 */
export function resolveSpacing(value: SpacingValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return `${value}px`;
  return SPACING_SCALE_NAMES.has(value)
    ? SPACING_SCALE_TOKEN[value as SpacingScale]
    : value;
}
