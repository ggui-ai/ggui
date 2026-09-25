import satori from 'satori';
import { describe, expect, it } from 'vitest';
import { socialCardFonts } from './fonts.js';
import type { CardChild, CardNode } from './node.js';
import { DEFAULT_EYEBROW, SOCIAL_CARD_SIZE, renderSocialCard } from './social-card.js';

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
  const [frame, mark, badgeRow, eyebrow, body, footerLeft, footerRight] = nodes(card);

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
    expect(badge.props.style).toMatchObject({ background: '#292929', color: '#F4F3ED', fontFamily: 'Geist Mono', fontSize: 22, borderRadius: 2, textTransform: 'uppercase' });
  });

  it('sets the eyebrow, headline and footer on the contract grid', () => {
    expect(textOf(eyebrow!)).toBe(DEFAULT_EYEBROW);
    expect(eyebrow!.props.style).toMatchObject({ left: 96, fontFamily: 'Geist Mono', fontSize: 20, color: '#5A5A5A' });
    const headline = nodes(body!)[0]!;
    expect(textOf(headline)).toBe(DOCS.title);
    expect(headline.props.style).toMatchObject({ fontFamily: 'Inter', fontWeight: 700, fontSize: 64, lineHeight: 1.1, color: '#292929' });
    expect(footerLeft!.props.style).toMatchObject({ left: 96, fontFamily: 'Geist Mono', fontSize: 24, color: '#3D3D3D' });
    expect(textOf(footerLeft!)).toBe('docs.ggui.ai');
    // Right-aligned to x 1104.
    expect(footerRight!.props.style).toMatchObject({ right: SOCIAL_CARD_SIZE.width - 1104, fontSize: 20, color: '#8C8C93' });
    expect(textOf(footerRight!)).toBe('OPEN PROTOCOL');
  });

  it('carries no badge when the surface is omitted (the landing card)', () => {
    const landing = renderSocialCard({ title: 'T', footer: { url: 'ggui.ai', fact: 'F' } });
    const textNodes = nodes(landing).flatMap((n) => [n, ...nodes(n)]);
    expect(textNodes.some((n) => n.props.style?.background === '#292929')).toBe(false);
  });

  it('adds the optional description under the headline, Inter Regular 30 in ink-3', () => {
    const withDesc = renderSocialCard({ ...DOCS, description: 'Open protocol, MCP-native, LLM-agnostic.' });
    const lines = nodes(nodes(withDesc)[4]!);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.props.style).toMatchObject({ fontFamily: 'Inter', fontWeight: 400, fontSize: 30, lineHeight: 1.4, color: '#5A5A5A' });
    expect(nodes(nodes(renderSocialCard(DOCS))[4]!)).toHaveLength(1);
  });
});

describe('renderSocialCard — renders with satori and the bundled faces', () => {
  it('produces a 1200 × 630 SVG for a card with a badge and a description', async () => {
    const svg = await satori(renderSocialCard({ ...DOCS, description: 'A second line.' }), {
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
