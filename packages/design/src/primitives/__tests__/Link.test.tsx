import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Link } from '../Link';
import { resolveToneCss } from '../color-slots';
import { Markdown } from '../../components/Markdown';

// ggui#983 — a host's link colour must reach a rendered card: the anchor
// reads the per-app `--ggui-color-link` first and falls back to the
// primary ladder only when no host or theme set it.
const LINK_COLOR = 'var(--ggui-color-link, var(--ggui-color-primary-600, #0284c7))';

describe('Link — the link colour slot (ggui#983)', () => {
  it('an untoned Link paints from --ggui-color-link, primary-600 beneath it', () => {
    const html = renderToStaticMarkup(<Link href="https://x.io">x</Link>);
    expect(html).toContain(`color:${LINK_COLOR}`);
  });

  it('a Markdown anchor goes through the same slot', () => {
    const html = renderToStaticMarkup(<Markdown markdown={'see [x](https://x.io)'} />);
    expect(html).toContain('<a');
    expect(html).toContain(`color:${LINK_COLOR}`);
  });

  it('a toned Link still resolves through the tone slots, not the link slot', () => {
    const html = renderToStaticMarkup(
      <Link href="https://x.io" tone="muted">
        x
      </Link>,
    );
    expect(html).toContain(`color:${resolveToneCss('muted')}`);
    expect(html).not.toContain('--ggui-color-link');
  });
});

describe('resolveToneCss — the flat error colour (ggui#983)', () => {
  it("'error' reads the flat --ggui-color-error a host or theme sets, the ladder's 500 stop beneath it", () => {
    expect(resolveToneCss('error')).toBe('var(--ggui-color-error, var(--ggui-color-error-500, #b91c1c))');
  });

  it('the other semantic tones stay on their ladder stop', () => {
    expect(resolveToneCss('success')).toBe('var(--ggui-color-success-500, #15803d)');
  });
});
