/**
 * Pin (ggui#1083 cut 2, the expanded-frame direction v1.2): inside a host's
 * fullscreen canvas the panel carries the one chrome and the card fills it — on ONE rhythm.
 *
 * - The panel's OUTER radius is the theme's `xl` radius stop. The guuey widget pins its own panel
 *   table to the same rule (guuey `33afd73d0`, `panel-radius-sync.test.ts`); the ladders below are
 *   guuey's forwarded `RADIUS_LADDERS` and its `PANEL_RADIUS_PX`, verbatim, so this file is the
 *   ggui-side mirror of that guard.
 * - The frame's INSET is guuey's `panelGap` default, 16 px — a cross-fleet constant.
 * - The fill rule gives the fill surface that inset, makes a first-level surface concentric with
 *   the panel's corner, and lets a bleeding element take the inset back. Only under `fit: 'fill'`.
 *   A bleed moves the element's ground to the panel's edge, never its content (ggui#1556).
 * - What bleeds (the founder's pick (B)): an element that declares `bleed`, and a `surface="hero"`
 *   band that OPENS the card, so a card served before `bleed` existed keeps its band edge to edge.
 * - Card and Box mark themselves (`data-ggui-surface`, `data-ggui-bleed`) so the rule can see them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Box } from '../primitives/Box';
import { Card } from '../primitives/Card';
import { deriveThemeVariables } from '../themes/derive-theme-variables';
import type { DtcgTheme } from '../themes/types';
import {
  composeThemeCss,
  EXPANDED_FRAME,
  EXPANDED_FRAME_BLEEDS,
  EXPANDED_FRAME_INNER_RADIUS,
  fillFitRule,
  EXPANDED_FRAME_CHROME,
  expandedFramePanelDecls,
  expandedFramePanelRule,
  expandedFrameScrim,
  expandedFrameScrimDecls,
} from './css-tokens';

const HERE = dirname(fileURLToPath(import.meta.url));
const stored: DtcgTheme = JSON.parse(
  readFileSync(join(HERE, '..', 'themes', '__fixtures__', 'r1', 'stored-dtcg-light.json'), 'utf8'),
) as DtcgTheme;

/** guuey `RADIUS_LADDERS` (forwarded into the AppTheme) and `PANEL_RADIUS_PX` (the widget's panel), at guuey `33afd73d0`. */
const GUUEY = [
  { bucket: 'none', ladder: { sm: '0px', md: '0px', lg: '0px', xl: '0px' }, panelPx: 0 },
  { bucket: 'soft', ladder: { sm: '4px', md: '8px', lg: '12px', xl: '16px' }, panelPx: 16 },
  { bucket: 'round', ladder: { sm: '8px', md: '12px', lg: '18px', xl: '24px' }, panelPx: 24 },
] as const;

function withLadder(ladder: Readonly<Record<'sm' | 'md' | 'lg' | 'xl', string>>): DtcgTheme {
  const template = stored.shape.radius.md!;
  const radius = { ...stored.shape.radius };
  for (const [stop, value] of Object.entries(ladder)) radius[stop] = { ...template, $value: value };
  return { ...stored, shape: { ...stored.shape, radius } };
}

describe('the expanded frame — one definition (ggui#1083 cut 2)', () => {
  it("the panel's outer radius is the theme's xl stop: for guuey's three forwarded ladders the projected xl IS the widget's panel radius", () => {
    expect(EXPANDED_FRAME.outerRadiusVar).toBe('--ggui-shape-radius-xl');
    for (const g of GUUEY) {
      const v = deriveThemeVariables(withLadder(g.ladder), 'light');
      expect(Number.parseFloat(v[EXPANDED_FRAME.outerRadiusVar] ?? 'NaN'), g.bucket).toBe(g.panelPx);
    }
  });

  it("the inset is guuey's panelGap default, 16 px, and a first-level surface is concentric: max(0, xl − 16)", () => {
    expect(EXPANDED_FRAME.insetPx).toBe(16);
    expect(EXPANDED_FRAME_INNER_RADIUS).toBe('max(0px, calc(var(--ggui-shape-radius-xl) - 16px))');
  });
});

describe("the fill rule carries the frame's rhythm — and only the fill rule", () => {
  const rule = fillFitRule('s1');

  // ggui#1765 — the block axis keeps the frame's 16 px; the inline axis is the card's own inset (the `lg` step).
  it('both fill surfaces (a many-child root, or the one child a wrapper hands the fill to) keep 16 px on the block axis and the card inset on the inline axis', () => {
    expect(rule).toContain('.s1 > :where(:not(style)):not(:has(> :only-child)) { padding: 16px var(--ggui-card-inset, var(--ggui-spacing-lg)) !important; }');
    expect(rule).toContain('.s1 > :where(:not(style)) > :where(:only-child) { padding: 16px var(--ggui-card-inset, var(--ggui-spacing-lg)) !important; }');
  });

  it('a first-level surface takes the concentric radius; a bleeding element takes the inset back and squares off', () => {
    expect(EXPANDED_FRAME_BLEEDS).toBe(
      '[data-ggui-bleed], [data-ggui-box][data-ggui-surface="hero"]:first-child, [data-ggui-card][data-ggui-surface="hero"]:only-child',
    );
    expect(rule).toContain(
      `> [data-ggui-surface]:not(${EXPANDED_FRAME_BLEEDS}) { border-radius: ${EXPANDED_FRAME_INNER_RADIUS} !important; }`,
    );
    expect(rule).toContain(
      `> :is(${EXPANDED_FRAME_BLEEDS}) { width: auto !important; align-self: stretch !important; margin-left: calc(-1 * var(--ggui-card-inset, var(--ggui-spacing-lg))) !important; margin-right: calc(-1 * var(--ggui-card-inset, var(--ggui-spacing-lg))) !important; border-left: var(--ggui-card-inset, var(--ggui-spacing-lg)) solid transparent !important; border-right: var(--ggui-card-inset, var(--ggui-spacing-lg)) solid transparent !important; padding-left: 0 !important; padding-right: 0 !important; background-origin: border-box !important; border-radius: 0 !important; }`,
    );
    expect(rule).toContain(`> :is(${EXPANDED_FRAME_BLEEDS}):first-child { margin-top: -16px !important; }`);
    expect(rule).toContain(`> :is(${EXPANDED_FRAME_BLEEDS}):last-child { margin-bottom: -16px !important; }`);
  });

  // ggui#1556 — a bleed moved the band's content out with its ground: an opening hero band's
  // heading sat at x 16 while the body and chips beside it kept the inset (x 32), on every
  // pane-width canvas. The ground still meets the edge; the content gets the inset back.
  it('a bleed moves the ground, never the content: on each inline side the transparent border hands back exactly the inset the margin takes', () => {
    const line = rule.split('\n').find((l) => l.includes(`> :is(${EXPANDED_FRAME_BLEEDS}) {`));
    expect(line).toBeDefined();
    const decl = (prop: string): string | undefined =>
      new RegExp(`(?:^|[{;]\\s*)${prop}: ([^;!]+) !important`).exec(line ?? '')?.[1]?.trim();
    // ggui#1765 — the inline inset is the card's own (`--ggui-card-inset`), and the band's own inline padding is
    // dropped, so its content lands on the body's edge measured from the card's edge, never inset twice.
    for (const side of ['left', 'right'] as const) {
      expect(decl(`margin-${side}`)).toBe('calc(-1 * var(--ggui-card-inset, var(--ggui-spacing-lg)))');
      expect(decl(`border-${side}`)).toBe('var(--ggui-card-inset, var(--ggui-spacing-lg)) solid transparent');
      expect(decl(`padding-${side}`)).toBe('0');
    }
    // The block axis is unchanged: no edge is shared there, and a served band keeps its rhythm.
    expect(line).not.toMatch(/border-(top|bottom):/);
  });

  // ggui#1986 — a sole-child hero Card that set `width: 100%` itself was pulled left by the bleed but held at the
  // content box's width, a strip of root ground down its right side. The bleed owns the inline axis: its width is
  // `auto` whatever the element sets inline, and it stretches across a root that centres its children.
  it('the bleed owns the inline axis: width auto and align-self stretch, both beating an inline style', () => {
    const line = rule.split('\n').find((l) => l.includes(`> :is(${EXPANDED_FRAME_BLEEDS}) {`));
    const decl = (prop: string): string | undefined =>
      new RegExp(`(?:^|[{;]\\s*)${prop}: ([^;!]+) !important`).exec(line ?? '')?.[1]?.trim();
    expect(decl('width')).toBe('auto');
    expect(decl('align-self')).toBe('stretch');
  });

  // A band's ground is often a gradient, set inline (`style={{ background: 'linear-gradient(…)' }}`): the
  // shorthand resets `background-origin` to the padding box, so without an !important origin the image is
  // positioned inside the strips and repeats into them, a hard seam `inset` px wide at both edges.
  it('a gradient or image ground spans the whole band, strips included: its origin is the border box, and it beats an inline shorthand', () => {
    const line = rule.split('\n').find((l) => l.includes(`> :is(${EXPANDED_FRAME_BLEEDS}) {`));
    expect(line).toContain('background-origin: border-box !important');
  });

  // ggui#1765 — an inline (non-fill) composition carries the card's one content edge (the root's inset and the
  // bleed hand-off) and none of the fill's rhythm (no concentric radius, no viewport height).
  it("an inline (non-fill) composition carries the card's content edge and none of the fill's rhythm", () => {
    for (const fit of [undefined, 'framed-card'] as const) {
      const inline = composeThemeCss({ layer: 'tree', scopeClass: 's1', ...(fit ? { fit } : {}) });
      expect(inline).toContain('.s1 > :where(:not(style)) { padding-left: var(--ggui-card-inset, var(--ggui-spacing-lg)) !important; padding-right: var(--ggui-card-inset, var(--ggui-spacing-lg)) !important; }');
      expect(inline).toContain(`.s1 > :where(:not(style)) > :is(${EXPANDED_FRAME_BLEEDS}) {`);
      expect(inline).not.toContain(EXPANDED_FRAME_INNER_RADIUS);
      expect(inline).not.toContain('min-height: 100vh');
    }
    expect(composeThemeCss({ layer: 'tree', scopeClass: 's1', fit: 'fill' })).toContain('data-ggui-bleed');
  });
});

describe("what bleeds, on a card's real markup (the founder's pick (B))", () => {
  // jsdom evaluates the bleed selector itself; it does not evaluate the fill surface's `:has` /
  // `:where` prefix (every element reads false there), so the prefix is pinned as text above and
  // its behaviour is receipted on Chromium frames.
  function children(card: string): Element[] {
    document.body.innerHTML = `<div class="s1">${card}</div>`;
    return [...document.querySelectorAll('.s1 > * > *')];
  }
  const bleeds = (el: Element) => el.matches(`:is(${EXPANDED_FRAME_BLEEDS})`);

  it('an opening hero band bleeds without declaring it; a hero band further down does not', () => {
    const kids = children(
      renderToStaticMarkup(
        <Card>
          <Box surface="hero">opening band</Box>
          <Card>first-level card</Card>
          <Box surface="hero">a later hero block</Box>
        </Card>,
      ),
    );
    expect(kids.map(bleeds)).toEqual([true, false, false]);
  });

  it('ggui#1981: a hero Card first AMONG siblings does NOT bleed: it is a tile, never the band the inference heals', () => {
    const kids = children(
      renderToStaticMarkup(
        <Box surface="default">
          <Card surface="hero">hero card</Card>
          <Box>rest</Box>
        </Box>,
      ),
    );
    expect(kids.map(bleeds)).toEqual([false, false]);
  });

  it("ggui#1981: a hero Card that is the root's ONLY child is the card's body and keeps its bleed", () => {
    const sole = (surface: 'hero' | 'elevated') =>
      children(
        renderToStaticMarkup(
          <Box surface="default">
            <Card surface={surface}>the whole card</Card>
          </Box>,
        ),
      ).map(bleeds);
    expect(sole('hero')).toEqual([true]);
    // Any other surface on a sole-child Card keeps the inset.
    expect(sole('elevated')).toEqual([false]);
  });

  it('ggui#1981: a Card among siblings bleeds only when it declares bleed; a Card carries data-ggui-card, a surface Box data-ggui-box', () => {
    const kids = children(
      renderToStaticMarkup(
        <Box surface="default">
          <Card surface="hero" bleed>
            declared band
          </Card>
          <Card>tile</Card>
          <Box surface="hero">later hero box</Box>
        </Box>,
      ),
    );
    expect(kids.map(bleeds)).toEqual([true, false, false]);
    expect(kids.map((k) => k.hasAttribute('data-ggui-card'))).toEqual([true, true, false]);
    expect(kids.map((k) => k.hasAttribute('data-ggui-box'))).toEqual([false, false, true]);
  });

  it('an opening band on any other surface keeps the inset unless it declares bleed', () => {
    const kids = children(
      renderToStaticMarkup(
        <Card>
          <Box surface="accent">accent band</Box>
          <Box surface="elevated" bleed>
            declared band
          </Box>
        </Card>,
      ),
    );
    expect(kids.map(bleeds)).toEqual([false, true]);
  });
});

describe('Card and Box mark themselves for the frame', () => {
  it('a painted Card is a surface; a transparent one is not', () => {
    expect(renderToStaticMarkup(<Card>x</Card>)).toContain('data-ggui-surface="default"');
    expect(renderToStaticMarkup(<Card surface="hero">x</Card>)).toContain('data-ggui-surface="hero"');
    expect(renderToStaticMarkup(<Card surface="transparent">x</Card>)).not.toContain('data-ggui-surface');
  });

  it('a Box is a surface only when it paints one; bleed rides any Box and is absent by default', () => {
    const band = renderToStaticMarkup(
      <Box surface="hero" bleed>
        x
      </Box>,
    );
    expect(band).toContain('data-ggui-surface="hero"');
    expect(band).toContain('data-ggui-bleed=""');
    expect(renderToStaticMarkup(<Box bleed>x</Box>)).toContain('data-ggui-bleed=""');
    const plain = renderToStaticMarkup(<Box>x</Box>);
    expect(plain).not.toContain('data-ggui-surface');
    expect(plain).not.toContain('data-ggui-bleed');
    expect(renderToStaticMarkup(<Box surface="transparent">x</Box>)).not.toContain('data-ggui-surface');
  });
});

describe('the panel chrome — one definition for every host stand-in (ggui#1083 cut 3)', () => {
  it("the chrome's radius is the frame's outer radius, its hairline the theme's ink at 6 %, its elevation the sm stop, its ground neutral-50, and it clips", () => {
    expect(EXPANDED_FRAME_CHROME.radius).toBe(`var(${EXPANDED_FRAME.outerRadiusVar})`);
    expect(expandedFramePanelDecls()).toBe(
      'border-radius: var(--ggui-shape-radius-xl); box-shadow: 0 0 0 1px color-mix(in srgb, var(--ggui-color-onGround) 6%, transparent), var(--ggui-shape-shadow-sm); background: var(--ggui-color-neutral-50); overflow: clip;',
    );
  });

  it('every variable the chrome and the scrim name is provided by the projection, in both modes', () => {
    const named = ['--ggui-shape-radius-xl', '--ggui-color-onGround', '--ggui-shape-shadow-sm', '--ggui-color-neutral-50', '--ggui-scrim-tint', '--ggui-scrim-opacity'];
    for (const mode of ['light', 'dark'] as const) {
      const v = deriveThemeVariables(stored, mode);
      for (const name of named) expect(v[name], `${mode} ${name}`).toBeDefined();
    }
  });

  it("for the shell's three ladders the panel's radius IS the widget's panel radius, and the elevation is the theme's own sm stop", () => {
    for (const g of GUUEY) {
      const v = deriveThemeVariables(withLadder(g.ladder), 'light');
      expect(Number.parseFloat(v['--ggui-shape-radius-xl'] ?? 'NaN'), g.bucket).toBe(g.panelPx);
      // The stored theme states its `sm` shadow; the panel's elevation is that stop, not the ladder default.
      expect(v['--ggui-shape-shadow-sm']).toBe(stored.shape.shadow!.sm!.$value);
    }
  });

  it("a judge page's panel rule: the panel sits the gap in from the page, and the scope's anchor inside it is the panel's height — a viewport length, never a percentage", () => {
    const rule = expandedFramePanelRule('p1', 's1');
    expect(rule).toContain(`.p1 { ${expandedFramePanelDecls()} }`);
    expect(rule).toContain('body > .p1 { margin: 16px; }');
    expect(rule).toContain('.p1 > .s1 { min-height: calc(100vh - 32px); }');
    expect(rule).not.toContain('min-height: 100%');
    // clip, never a scroll container: the judge measures the document's overflow.
    expect(rule).not.toMatch(/overflow:\s*(hidden|auto|scroll)/);
  });

  it("rule 0: the runtime's composition carries no chrome — neither the tree under fill nor the page layer", () => {
    for (const css of [composeThemeCss({ layer: 'tree', scopeClass: 's1', fit: 'fill' }), composeThemeCss({ layer: 'page' })]) {
      expect(css).not.toContain(expandedFramePanelDecls());
      expect(css).not.toContain('--ggui-shape-shadow-sm)');
    }
  });

  it("the scrim: the tint at its opacity over a ground — a judge page's body mixes over neutral-50, a replica over transparent", () => {
    expect(expandedFrameScrimDecls()).toBe(
      'background: color-mix(in oklch, var(--ggui-scrim-tint, var(--ggui-color-ground, #ffffff)) calc(var(--ggui-scrim-opacity, 0.45) * 100%), var(--ggui-color-neutral-50, #ffffff));',
    );
    expect(expandedFrameScrim('transparent')).toBe(
      'color-mix(in oklch, var(--ggui-scrim-tint, var(--ggui-color-ground, #ffffff)) calc(var(--ggui-scrim-opacity, 0.45) * 100%), transparent)',
    );
  });
});
