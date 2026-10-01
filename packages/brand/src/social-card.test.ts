import satori from 'satori';
import { describe, expect, it } from 'vitest';
import { socialCardFonts } from './fonts.js';
import type { CardChild, CardNode } from './node.js';
import { DEFAULT_EYEBROW, SOCIAL_CARD_SIZE, renderSocialCard, type SocialCardInput } from './social-card.js';

const DOCS = {
  surface: 'DOCS',
  title: 'Agents describe. Interfaces appear.',
  footer: { url: 'docs.ggui.ai', fact: 'OPEN PROTOCOL' },
} as const;

function isChildList(c: CardChild | readonly CardChild[]): c is readonly CardChild[] {
  return Array.isArray(c);
}

function kids(node: CardNode): readonly CardChild[] {
  const c = node.props.children;
  if (c === undefined) return [];
  return isChildList(c) ? c : [c];
}

function nodes(node: CardNode): CardNode[] {
  return kids(node).filter((c): c is CardNode => typeof c !== 'string');
}

function textOf(node: CardNode): string | undefined {
  const c = node.props.children;
  return typeof c === 'string' ? c : undefined;
}

describe('renderSocialCard — the reference placements', () => {
  const card = renderSocialCard(DOCS);
  const [frame, mark, badgeRow, column, footerLeft, footerRight] = nodes(card);

  it('is a 1200 × 630 paper ground with a 2 px line-2 hairline inset 28 px', () => {
    expect(card.props.style).toMatchObject({ width: 1200, height: 630, background: '#F4F3ED' });
    expect(frame!.props.style).toMatchObject({ top: 28, left: 28, width: 1144, height: 574, border: '2px solid #D6D4CB' });
  });

  it('places the mark at x 96, y 88, 448 × 100 (the 224-unit construction at 2×)', () => {
    expect(mark!.type).toBe('svg');
    expect(mark!.props.style).toMatchObject({ left: 96, top: 88, width: 448, height: 100 });
    expect(mark!.props.viewBox).toBe('0 0 224 50');
    expect(nodes(mark!)).toHaveLength(6);
  });

  it('sets the badge beside the mark at x 592, centred on it, paper on ink', () => {
    expect(badgeRow!.props.style).toMatchObject({ left: 592, top: 88, height: 100, alignItems: 'center' });
    const badge = nodes(badgeRow!)[0]!;
    expect(textOf(badge)).toBe('DOCS');
    expect(badge.props.style).toMatchObject({ background: '#292929', color: '#F4F3ED', fontFamily: 'Geist Mono', fontSize: 22, borderRadius: 2, textTransform: 'uppercase', lineHeight: 1 });
    // Measured on the reference card: a 44 px-tall badge, text + 48 wide.
    expect(badge.props.style?.padding).toBe('11px 24px');
  });

  it('sets the eyebrow, headline and footer on the contract grid', () => {
    expect(column!.props.style).toMatchObject({ position: 'absolute', left: 96, bottom: 148, width: 1008, flexDirection: 'column' });
    const [eyebrow, headline] = nodes(column!);
    expect(textOf(eyebrow!)).toBe(DEFAULT_EYEBROW);
    expect(eyebrow!.props.style).toMatchObject({ fontFamily: 'Geist Mono', fontSize: 20, color: '#5A5A5A' });
    expect(textOf(headline!)).toBe(DOCS.title);
    expect(headline!.props.style).toMatchObject({ fontFamily: 'Inter', fontWeight: 700, fontSize: 64, lineHeight: 1.1, color: '#292929', textWrap: 'balance' });
    expect(footerLeft!.props.style).toMatchObject({ left: 96, fontFamily: 'Geist Mono', fontSize: 24, color: '#3D3D3D' });
    expect(textOf(footerLeft!)).toBe('docs.ggui.ai');
    // Right-aligned to x 1104, in ink-3 like the eyebrow: 20 px text, so not
    // ink-4, which colour-roles keeps for non-text below 24 px (#1654).
    expect(footerRight!.props.style).toMatchObject({ right: SOCIAL_CARD_SIZE.width - 1104, fontSize: 20, color: '#5A5A5A' });
    expect(textOf(footerRight!)).toBe('OPEN PROTOCOL');
  });

  it('carries no badge when the surface is omitted (the landing card)', () => {
    const landing = renderSocialCard({ title: 'T', footer: { url: 'ggui.ai', fact: 'F' } });
    const textNodes = nodes(landing).flatMap((n) => [n, ...nodes(n)]);
    expect(textNodes.some((n) => n.props.style?.background === '#292929')).toBe(false);
  });

  it('adds the optional description under the headline, Inter Regular 30 in ink-3', () => {
    const withDesc = renderSocialCard({ ...DOCS, description: 'Open protocol, MCP-native, LLM-agnostic.' });
    const lines = nodes(nodes(withDesc)[3]!);
    expect(lines).toHaveLength(3);
    expect(lines[2]!.props.style).toMatchObject({ marginTop: 20, fontFamily: 'Inter', fontWeight: 400, fontSize: 30, lineHeight: 1.4, color: '#5A5A5A' });
    expect(nodes(nodes(renderSocialCard(DOCS))[3]!)).toHaveLength(2);
  });
});

describe('renderSocialCard — where a line breaks is the lane\'s', () => {
  it('honours a hard break in the title (pre-line), so the lane places it', () => {
    const card = renderSocialCard({ ...DOCS, title: 'Agents describe.\nInterfaces appear.' });
    const headline = nodes(nodes(card)[3]!)[1]!;
    expect(textOf(headline)).toBe('Agents describe.\nInterfaces appear.');
    expect(headline.props.style?.whiteSpace).toBe('pre-line');
  });

  it('honours a hard break in the description too', () => {
    const card = renderSocialCard({ ...DOCS, description: 'One.\nTwo.' });
    const desc = nodes(nodes(card)[3]!)[2]!;
    expect(desc.props.style?.whiteSpace).toBe('pre-line');
  });

  it('refuses a title or description that breaks into more than two lines', () => {
    expect(() => renderSocialCard({ ...DOCS, title: 'a\nb\nc' })).toThrow(/at most two lines/);
    expect(() => renderSocialCard({ ...DOCS, description: 'a\nb\nc' })).toThrow(/at most two lines/);
  });

  it('refuses a two-line title with a two-line description: three lines of text in all', () => {
    expect(() => renderSocialCard({ ...DOCS, title: 'a\nb', description: 'c\nd' })).toThrow(/at most three lines together; got 4/);
    expect(() => renderSocialCard({ ...DOCS, title: 'a\nb', description: 'c' })).not.toThrow();
    expect(() => renderSocialCard({ ...DOCS, title: 'a', description: 'c\nd' })).not.toThrow();
  });
});

describe('renderSocialCard — renders with satori and the bundled faces', () => {
  it('produces a 1200 × 630 SVG for a card with a badge and a description', async () => {
    const svg = await satori(renderSocialCard({ ...DOCS, title: 'Agents describe.\nInterfaces appear.', description: 'A second line.' }), {
      width: SOCIAL_CARD_SIZE.width,
      height: SOCIAL_CARD_SIZE.height,
      fonts: socialCardFonts(),
    });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
  });

  it('renders the landing card (no badge) too', async () => {
    const svg = await satori(renderSocialCard({ title: 'T', footer: { url: 'ggui.ai', fact: 'F' } }), {
      width: 1200,
      height: 630,
      fonts: socialCardFonts(),
    });
    expect(svg.startsWith('<svg')).toBe(true);
  });
});

// Where satori actually lays the text out: each text block gets a background
// of its own (a test-only copy of the tree), and the SVG's rects say where it
// landed. The mark ends at y 188 and the footer starts at y 542.
const MARK_BOTTOM = 188;
const FOOTER_TOP = 542;
const PROBE = { eyebrow: '#010101', title: '#020202', description: '#030303' } as const;
type Box = { top: number; bottom: number; width: number };

function tint(node: CardNode, fills: ReadonlyMap<string, string>): CardNode {
  const c = node.props.children;
  const children = c === undefined ? undefined : isChildList(c) ? c.map((k) => (typeof k === 'string' ? k : tint(k, fills))) : typeof c === 'string' ? c : tint(c, fills);
  const fill = typeof c === 'string' ? fills.get(c) : undefined;
  return {
    ...node,
    props: { ...node.props, ...(children !== undefined ? { children } : {}), ...(fill !== undefined ? { style: { ...node.props.style, background: fill } } : {}) },
  };
}

async function laidOut(input: SocialCardInput): Promise<Partial<Record<keyof typeof PROBE, Box>>> {
  const fills = new Map<string, string>([
    [input.eyebrow ?? DEFAULT_EYEBROW, PROBE.eyebrow],
    [input.title, PROBE.title],
    ...(input.description !== undefined ? [[input.description, PROBE.description] as const] : []),
  ]);
  const svg = await satori(tint(renderSocialCard(input), fills), { ...SOCIAL_CARD_SIZE, fonts: socialCardFonts() });
  const boxes: Partial<Record<keyof typeof PROBE, Box>> = {};
  for (const [name, fill] of Object.entries(PROBE) as [keyof typeof PROBE, string][]) {
    const m = new RegExp(`<rect x="[\\d.]+" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)" fill="${fill}"`).exec(svg);
    if (m !== null) boxes[name] = { top: Number(m[1]), bottom: Number(m[1]) + Number(m[3]), width: Number(m[2]) };
  }
  return boxes;
}

describe('renderSocialCard — the text column is anchored above the footer (#1462)', () => {
  const TWO = 'Agents describe.\nInterfaces appear.';

  it('lays the reference card (two-line headline, no description) out where it always was', async () => {
    const { eyebrow, title } = await laidOut({ ...DOCS, title: TWO });
    expect(eyebrow).toMatchObject({ top: 313, bottom: 333 });
    expect(title).toMatchObject({ top: 342, bottom: 482 });
  });

  it('keeps the renderer\'s own two-line headline with a description clear of the footer', async () => {
    const { title, description } = await laidOut({ ...DOCS, title: TWO, description: 'A second line.' });
    expect(description!.bottom).toBeLessThanOrEqual(482);
    expect(description!.bottom).toBeLessThan(FOOTER_TOP);
    expect(description!.top).toBe(title!.bottom + 20);
  });

  it.each([
    ['1 + 0', { title: 'Agents describe.' }],
    ['1 + 1', { title: 'Agents describe.', description: 'A second line.' }],
    ['1 + 2', { title: 'Agents describe.', description: 'One.\nTwo.' }],
    ['2 + 0', { title: TWO }],
    ['2 + 1', { title: TWO, description: 'A second line.' }],
    ['2 + 1, the headline wrapping on its own', { title: 'Withhold the material, keep the name', description: 'Deep-dive · Sep 30, 2026' }],
  ])('%s ends at y 482 and keeps the eyebrow at least 60 under the mark', async (_name, text) => {
    const boxes = await laidOut({ ...DOCS, ...text });
    const last = boxes.description ?? boxes.title;
    expect(last!.bottom).toBe(482);
    expect(boxes.eyebrow!.top).toBeGreaterThanOrEqual(MARK_BOTTOM + 60);
    expect(boxes.title!.top - boxes.eyebrow!.top).toBe(29);
  });

  it('balances a headline that wraps on its own, so line 2 is not one word alone', async () => {
    // Shrink-wrapped, a balanced headline is as wide as its longer line; an
    // unbalanced one fills the column with "Withhold the material, keep the".
    const title = 'Withhold the material, keep the name';
    const headline = nodes(nodes(renderSocialCard({ ...DOCS, title }))[3]!)[1]!;
    const width = async (style: CardNode['props']['style']) => {
      const probe: CardNode = {
        type: 'div',
        key: null,
        props: { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: 1008 }, children: { ...headline, props: { ...headline.props, style: { ...style, background: PROBE.title } } } },
      };
      const svg = await satori(probe, { width: 1008, fonts: socialCardFonts() });
      return Number(new RegExp(`<rect x="[\\d.]+" y="[\\d.]+" width="([\\d.]+)" height="140" fill="${PROBE.title}"`).exec(svg)?.[1]);
    };
    const { textWrap: _balance, ...unbalanced } = headline.props.style!;
    const balanced = await width(headline.props.style);
    expect(balanced).toBeLessThan(0.75 * (await width(unbalanced)));
  });
});
