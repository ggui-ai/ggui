import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Grid } from '../Grid';

describe('Grid — column modes', () => {
  it('fixed: a plain number renders that many equal columns inline', () => {
    const html = renderToStaticMarkup(
      <Grid columns={3}>
        <div />
      </Grid>,
    );
    expect(html).toContain('repeat(3, minmax(0, 1fr))');
    expect(html).not.toContain('@media');
  });

  it('fluid: minColumnWidth renders an auto-fill track and ignores columns', () => {
    const html = renderToStaticMarkup(
      <Grid columns={3} minColumnWidth={220}>
        <div />
      </Grid>,
    );
    expect(html).toContain('repeat(auto-fill, minmax(220px, 1fr))');
    expect(html).not.toContain('repeat(3,');
  });

  it('per-breakpoint: a columns map emits scoped media-query rules', () => {
    const html = renderToStaticMarkup(
      <Grid columns={{ base: 1, md: 3 }}>
        <div />
      </Grid>,
    );
    // base rule + a md media query, both scoped to the same generated class.
    const cls = html.match(/ggui-grid-[a-z0-9]+/)?.[0];
    expect(cls).toBeTruthy();
    expect(html).toContain(`.${cls}{grid-template-columns:repeat(1, minmax(0, 1fr))}`);
    expect(html).toContain(
      `@media (min-width:768px){.${cls}{grid-template-columns:repeat(3, minmax(0, 1fr))}}`,
    );
    // The class is applied to the grid element…
    expect(html).toContain(`class="${cls}"`);
    // …and grid-template-columns is NOT inlined (the class must win).
    expect(html).not.toMatch(/style="[^"]*grid-template-columns/);
  });

  it('per-breakpoint: base defaults to a single column when omitted', () => {
    const html = renderToStaticMarkup(
      <Grid columns={{ lg: 4 }}>
        <div />
      </Grid>,
    );
    expect(html).toMatch(/grid-template-columns:repeat\(1, minmax\(0, 1fr\)\)/);
    expect(html).toContain('@media (min-width:1024px)');
  });
});
