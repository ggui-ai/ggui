/**
 * The brand's colour tokens (ggui brand kit v1.0).
 *
 * These are the brand's own, and deliberately separate from
 * `@ggui-ai/design`'s `--ggui-*` tokens, which style generated interfaces
 * for a different audience. Their CSS form uses the {@link BRAND_CSS_PREFIX}
 * prefix, so the two sets can never collide on one page.
 */
export const BRAND_COLORS = {
  paper: '#F4F3ED',
  ink: '#292929',
  chrome: '#D9D9D9',
  line2: '#D6D4CB',
  ink2: '#3D3D3D',
  ink3: '#5A5A5A',
  ink4: '#8C8C93',
} as const;

export type BrandColor = keyof typeof BRAND_COLORS;

/** The CSS custom-property prefix for the brand tokens: `--ggb-paper`, `--ggb-ink`, … */
export const BRAND_CSS_PREFIX = '--ggb-';

/** The brand tokens as one `:root` block of CSS custom properties. */
export function brandTokensCss(): string {
  const lines = Object.entries(BRAND_COLORS).map(
    ([name, value]) => `  ${BRAND_CSS_PREFIX}${name}: ${value};`,
  );
  return `:root {\n${lines.join('\n')}\n}\n`;
}
