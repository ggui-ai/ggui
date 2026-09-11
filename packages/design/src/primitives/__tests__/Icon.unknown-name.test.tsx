/**
 * Pin (ggui#1015): the Icon primitive renders ONLY its curated Lucide
 * subset. An unknown name renders an empty box of `size` — never the
 * former "?" placeholder, which painted grey boxes on greeting screens in
 * the field — and the exported `LUCIDE_ICON_NAMES` is the single list
 * the generator's icon tool and its check leg read, so the greeting
 * glyphs the mints reach for must be in it.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from '../Icon';
import { LUCIDE_ICONS, LUCIDE_ICON_NAMES } from '../icon-data';

describe('Icon unknown-name path (ggui#1015)', () => {
  it('renders an empty sized box, never a placeholder glyph', () => {
    const html = renderToStaticMarkup(<Icon name="not-a-real-icon" size={20} />);
    expect(html).not.toContain('?');
    expect(html).not.toContain('<svg');
    expect(html).toContain('data-ggui-icon-unknown="not-a-real-icon"');
    expect(html).toContain('width:20px');
    expect(html).toContain('aria-hidden="true"');
  });

  it('the greeting / chip glyphs the hello mints reach for are in the subset and render', () => {
    for (const n of [
      'sparkles', 'sparkle', 'bot', 'wand-sparkles', 'hand', 'party-popper',
      'arrow-up-right', 'arrow-right', 'message-circle', 'send',
    ]) {
      expect(LUCIDE_ICON_NAMES).toContain(n);
      expect(renderToStaticMarkup(<Icon name={n} />)).toContain('<svg');
    }
  });

  it('LUCIDE_ICON_NAMES is the sorted kebab-case key set of LUCIDE_ICONS (Lucide spelling: trash-2, bar-chart-3)', () => {
    expect(LUCIDE_ICON_NAMES.length).toBe(Object.keys(LUCIDE_ICONS).length);
    expect([...LUCIDE_ICON_NAMES]).toEqual([...LUCIDE_ICON_NAMES].sort());
    expect(LUCIDE_ICON_NAMES).toContain('trash-2');
    expect(LUCIDE_ICON_NAMES).toContain('bar-chart-3');
    // every listed name resolves through the primitive's own lookup
    for (const n of LUCIDE_ICON_NAMES) {
      expect(renderToStaticMarkup(<Icon name={n} />)).toContain('<svg');
    }
  });
});
