/**
 * @ggui-ai/brand: the ggui brand kit, as code.
 *
 * - The wordmark's canonical geometry ({@link WORDMARK_SHAPES}), and the
 *   letters as an SVG document ({@link wordmarkSvg}).
 * - The brand's colour tokens ({@link BRAND_COLORS}), and their CSS form
 *   ({@link brandTokensCss}), namespaced `--ggb-*`.
 * - The social card as one renderer ({@link renderSocialCard}), with its face
 *   bundle ({@link socialCardFonts}).
 * - Content keys for a card's image URL ({@link socialCardKey},
 *   {@link socialCardKeyFromImage}), so a card change reaches new shares.
 */
export { BRAND_COLORS, BRAND_CSS_PREFIX, brandTokensCss, type BrandColor } from './tokens.js';
export {
  WORDMARK_SHAPES,
  WORDMARK_VIEWBOX,
  wordmarkFill,
  wordmarkSvg,
  type WordmarkShape,
  type WordmarkTone,
} from './wordmark.js';
export { socialCardFonts, type SocialCardFont } from './fonts.js';
export {
  DEFAULT_EYEBROW,
  SOCIAL_CARD_SIZE,
  renderSocialCard,
  type SocialCardInput,
} from './social-card.js';
export {
  isSocialCardKey,
  SOCIAL_CARD_KEY_LENGTH,
  socialCardKey,
  socialCardKeyFromImage,
  type SocialCardKeyOptions,
} from './card-key.js';
export { SOCIAL_CARD_RENDERER_DIGEST } from './renderer-digest.js';
export type { CardChild, CardNode, CardNodeProps, CardStyle } from './node.js';
