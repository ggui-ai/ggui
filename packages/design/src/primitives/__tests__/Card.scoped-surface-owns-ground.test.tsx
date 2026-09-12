/**
 * Pin (ggui#1047): a SCOPED surface (`inverted`, `hero`) owns its ground — the
 * author's style may not repaint it, and the scope remaps the page's
 * `ground` / `onGround` for its subtree. RED fixture — the served Mosaic hello
 * on candidate 15 (QA, 2026-09-12): an inverted card whose hero text computed
 * `#141914` on `#141914` = 1:1 while its chips read 15.55:1 — the swapped inks
 * over a ground the scope did not own. Non-scoped surfaces keep the author's
 * background, last, as before.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Card } from '../Card';
import { Box } from '../Box';
import { HERO_SCOPE_CSS, INVERTED_SCOPE_CSS, withoutBackground } from '../color-slots';

describe('a scoped surface owns its ground (ggui#1047)', () => {
  it('withoutBackground strips background / backgroundColor / backgroundImage and nothing else', () => {
    expect(withoutBackground({ background: 'red', backgroundColor: 'blue', backgroundImage: 'url(x)', padding: 4, color: 'ink' })).toEqual({ padding: 4, color: 'ink' });
    expect(withoutBackground(undefined)).toBeUndefined();
  });

  it('an inverted Card paints the inverted ground even when the author style repaints it with the page ground', () => {
    const html = renderToStaticMarkup(<Card surface="inverted" style={{ background: 'var(--ggui-color-ground)', padding: 8 }}>x</Card>);
    expect(html).toContain('background-color:var(--ggui-color-onContainer, #18181b)');
    expect(html).not.toContain('background:var(--ggui-color-ground)');
    expect(html).toContain('padding:8px');
  });

  it('a hero Box paints the hero ground over an author backgroundColor; a default Card still honours the author background', () => {
    const hero = renderToStaticMarkup(<Box surface="hero" style={{ backgroundColor: '#123456' }}>x</Box>);
    expect(hero).toContain('background:var(--ggui-color-heroGround, #e0f2fe)');
    expect(hero).not.toContain('#123456');
    const plain = renderToStaticMarkup(<Card style={{ background: 'var(--ggui-color-ground)' }}>x</Card>);
    expect(plain).toContain('background:var(--ggui-color-ground)');
  });

  it('the scopes remap ground / onGround for their subtree', () => {
    expect(INVERTED_SCOPE_CSS).toContain('--ggui-color-ground:var(--ggui-surface-inverted-bg);--ggui-color-onGround:var(--ggui-surface-inverted-ink);');
    expect(HERO_SCOPE_CSS).toContain('--ggui-color-ground:var(--ggui-surface-hero-bg);--ggui-color-onGround:var(--ggui-surface-hero-ink);');
  });
});
