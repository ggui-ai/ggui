/**
 * Solid-accent components consume the on-accent PAIR tokens, never a
 * hardcoded foreground literal (ggui#589 round 7 — white-on-slime
 * store-frame rejection: Button's primary variant hardcoded #ffffff,
 * so a theme whose primary is bright had unreadable labels; the token
 * pair is the only theme-safe contract). #594 mechanizes the
 * theme-side half (the AA sweep in guuey-brand.test.ts); this file
 * pins the COMPONENT-side half.
 *
 * `renderToStaticMarkup` keeps the pin dependency-free: inline styles
 * serialize into the markup, so the assertion is a plain string
 * containment on the token reference.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '../Button';
import { Checkbox } from '../Checkbox';
import { Tabs } from '../Tabs';

describe('solid-accent foreground = the on-accent token (never a literal)', () => {
  it('Button primary label reads var(--ggui-color-onPrimary)', () => {
    const html = renderToStaticMarkup(<Button variant="primary">Book now</Button>);
    expect(html).toContain('--ggui-color-onPrimary');
  });

  it('Button danger label reads var(--ggui-color-onError)', () => {
    const html = renderToStaticMarkup(<Button variant="danger">Delete</Button>);
    expect(html).toContain('--ggui-color-onError');
  });

  it('Tabs pills active label reads var(--ggui-color-onPrimary)', () => {
    const html = renderToStaticMarkup(
      <Tabs
        variant="pills"
        activeKey="a"
        items={[
          { key: 'a', label: 'One', content: null },
          { key: 'b', label: 'Two', content: null },
        ]}
      />,
    );
    expect(html).toContain('--ggui-color-onPrimary');
  });

  it('Checkbox mark reads var(--ggui-color-onPrimary)', () => {
    const html = renderToStaticMarkup(<Checkbox checked onChange={() => {}} label="done" />);
    expect(html).toContain('--ggui-color-onPrimary');
  });
});
