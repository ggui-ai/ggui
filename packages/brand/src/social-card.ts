import { el, type CardChild, type CardNode } from './node.js';
import { BRAND_COLORS } from './tokens.js';
import { WORDMARK_SHAPES, WORDMARK_VIEWBOX, wordmarkFill } from './wordmark.js';

/** Every social card is this size (the `og:image` and `summary_large_image` shape). */
export const SOCIAL_CARD_SIZE = { width: 1200, height: 630 } as const;

/** The system's one eyebrow line, used when a surface does not pass its own. */
export const DEFAULT_EYEBROW = 'GENERATIVE GRAPHICAL USER INTERFACE · OPEN PROTOCOL';

export interface SocialCardInput {
  /** The badge word beside the mark (`DOCS`, `BLOG`, `REGISTRY`, …). Omit it for no badge, as on the landing card. */
  readonly surface?: string;
  /** One line of tracked caps above the headline. Defaults to {@link DEFAULT_EYEBROW}. */
  readonly eyebrow?: string;
  /**
   * The headline: at most two lines at the card's scale. Where it breaks is
   * design, so a `\n` places the break; without one, the line wraps where it
   * runs out of room.
   */
  readonly title: string;
  /** An optional line under the headline, at most two lines; a `\n` places the break. */
  readonly description?: string;
  /**
   * The footer. `url` is the surface's address (left, mono). `fact` is one
   * fact that only a deploy can change (right, tracked caps): a static card
   * is cached for days, so it never claims anything live.
   */
  readonly footer: { readonly url: string; readonly fact: string };
}

// Placements, measured from the reference card (1200 × 630). Text is placed
// by the top of its line box, derived from the contract's baselines and each
// face's metrics.
const INSET = 28;
const LEFT = 96;
const RIGHT_EDGE = 1104;
const MARK = { top: 88, width: 448, height: 100 } as const;
const BADGE_LEFT = 592;
const EYEBROW_TOP = 313; // baseline ≈ 330 at Geist Mono 20, line-height 1
const HEADLINE_TOP = 342; // first baseline ≈ 400 at Inter Bold 64, line-height 1.1
const FOOTER_LEFT_TOP = 542; // baseline ≈ 562 at Geist Mono 24
const FOOTER_RIGHT_TOP = 545; // same baseline at Geist Mono 20

/** Refuse text whose hard breaks alone make more than two lines. */
function assertAtMostTwoLines(field: 'title' | 'description', text: string): void {
  if (text.split('\n').length > 2) {
    throw new RangeError(`social card ${field} must be at most two lines; got ${text.split('\n').length}`);
  }
}

/** Tracking in em, as satori's pixel letter-spacing. */
function track(em: number, fontSize: number): number {
  return Math.round(em * fontSize * 100) / 100;
}

function mark(): CardNode {
  return el('svg', {
    viewBox: `0 0 ${WORDMARK_VIEWBOX.width} ${WORDMARK_VIEWBOX.height}`,
    width: MARK.width,
    height: MARK.height,
    style: { position: 'absolute', left: LEFT, top: MARK.top, width: MARK.width, height: MARK.height },
    children: WORDMARK_SHAPES.map((s) =>
      s.kind === 'path'
        ? el('path', { d: s.d, fill: wordmarkFill(s.tone) })
        : el('rect', { x: s.x, y: s.y, width: s.width, height: s.height, fill: wordmarkFill(s.tone) }),
    ),
  });
}

function badge(word: string): CardNode {
  // A row as tall as the mark, so the badge centres on it vertically.
  return el('div', {
    style: {
      position: 'absolute',
      left: BADGE_LEFT,
      top: MARK.top,
      height: MARK.height,
      display: 'flex',
      alignItems: 'center',
    },
    children: el('div', {
      style: {
        display: 'flex',
        background: BRAND_COLORS.ink,
        color: BRAND_COLORS.paper,
        fontFamily: 'Geist Mono',
        fontSize: 22,
        letterSpacing: track(0.16, 22),
        textTransform: 'uppercase',
        borderRadius: 2,
        // Measured on the reference card: 44 px tall, text + 48 wide.
        padding: '11px 24px',
        lineHeight: 1,
      },
      children: word,
    }),
  });
}

/**
 * The estate's social card as one element tree. Render it with satori (the
 * faces come from `socialCardFonts()`), or pass it to Next's `ImageResponse`.
 */
export function renderSocialCard(input: SocialCardInput): CardNode {
  assertAtMostTwoLines('title', input.title);
  if (input.description !== undefined) assertAtMostTwoLines('description', input.description);
  const body: CardChild[] = [
    el('div', {
      style: {
        display: 'flex',
        fontFamily: 'Inter',
        fontWeight: 700,
        fontSize: 64,
        lineHeight: 1.1,
        letterSpacing: track(-0.02, 64),
        color: BRAND_COLORS.ink,
        whiteSpace: 'pre-line',
      },
      children: input.title,
    }),
  ];
  if (input.description !== undefined) {
    body.push(
      el('div', {
        style: {
          display: 'flex',
          marginTop: 20,
          fontFamily: 'Inter',
          fontWeight: 400,
          fontSize: 30,
          lineHeight: 1.4,
          color: BRAND_COLORS.ink3,
          whiteSpace: 'pre-line',
        },
        children: input.description,
      }),
    );
  }

  const children: CardChild[] = [
    // The hairline frame.
    el('div', {
      style: {
        position: 'absolute',
        top: INSET,
        left: INSET,
        width: SOCIAL_CARD_SIZE.width - 2 * INSET,
        height: SOCIAL_CARD_SIZE.height - 2 * INSET,
        border: `2px solid ${BRAND_COLORS.line2}`,
      },
    }),
    mark(),
    ...(input.surface !== undefined ? [badge(input.surface)] : []),
    el('div', {
      style: {
        position: 'absolute',
        left: LEFT,
        top: EYEBROW_TOP,
        display: 'flex',
        fontFamily: 'Geist Mono',
        fontSize: 20,
        letterSpacing: track(0.2, 20),
        textTransform: 'uppercase',
        lineHeight: 1,
        color: BRAND_COLORS.ink3,
      },
      children: input.eyebrow ?? DEFAULT_EYEBROW,
    }),
    el('div', {
      style: {
        position: 'absolute',
        left: LEFT,
        top: HEADLINE_TOP,
        width: RIGHT_EDGE - LEFT,
        display: 'flex',
        flexDirection: 'column',
      },
      children: body,
    }),
    el('div', {
      style: {
        position: 'absolute',
        left: LEFT,
        top: FOOTER_LEFT_TOP,
        display: 'flex',
        fontFamily: 'Geist Mono',
        fontSize: 24,
        lineHeight: 1,
        color: BRAND_COLORS.ink2,
      },
      children: input.footer.url,
    }),
    el('div', {
      style: {
        position: 'absolute',
        right: SOCIAL_CARD_SIZE.width - RIGHT_EDGE,
        top: FOOTER_RIGHT_TOP,
        display: 'flex',
        fontFamily: 'Geist Mono',
        fontSize: 20,
        letterSpacing: track(0.16, 20),
        textTransform: 'uppercase',
        lineHeight: 1,
        color: BRAND_COLORS.ink4,
      },
      children: input.footer.fact,
    }),
  ];

  return el('div', {
    style: {
      display: 'flex',
      position: 'relative',
      width: SOCIAL_CARD_SIZE.width,
      height: SOCIAL_CARD_SIZE.height,
      background: BRAND_COLORS.paper,
    },
    children,
  });
}
