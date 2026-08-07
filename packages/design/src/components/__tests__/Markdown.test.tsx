import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, renderRichTextInlines } from '../Markdown';
import { parseInlineRichText } from '../../richtext';

describe('Markdown — block renderer over the design richtext model', () => {
  it('renders headings through the Heading primitive at the written level', () => {
    const html = renderToStaticMarkup(<Markdown markdown={'## Section\n\nbody'} />);
    expect(html).toContain('<h2');
    expect(html).toContain('Section');
    expect(html).toContain('body');
  });

  it('renders inline emphasis as semantic elements with literal content', () => {
    const html = renderToStaticMarkup(<Markdown markdown={'**bold** and *soft* and `x < 1`'} />);
    expect(html).toContain('<strong');
    expect(html).toContain('bold');
    expect(html).toContain('<em');
    // Literal-content rule: the code span's text is escaped, never markup.
    expect(html).toContain('&lt; 1');
  });

  it('renders lists with ordered start preserved', () => {
    const html = renderToStaticMarkup(<Markdown markdown={'3. three\n4. four'} />);
    expect(html).toContain('<ol start="3"');
    expect(html.match(/<li/g)).toHaveLength(2);
  });

  it('renders fenced code blocks as pre/code with the language stamped', () => {
    const html = renderToStaticMarkup(<Markdown markdown={'```ts\nconst a = 1;\n```'} />);
    expect(html).toContain('<pre');
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain('const a = 1;');
  });

  it('only navigable hrefs become anchors — rejected schemes render styled text with NO href anywhere', () => {
    const html = renderToStaticMarkup(
      <Markdown markdown={'[ok](https://ggui.ai) [bad](javascript:alert(1))'} />,
    );
    expect(html).toContain('href="https://ggui.ai"');
    expect(html).not.toContain('javascript:');
    // The rejected link still shows its text, link-styled but inert.
    expect(html).toContain('bad');
  });

  it('maps explicit line breaks to <br/>, never to a joined line', () => {
    const html = renderToStaticMarkup(<Markdown markdown={'line one\nline two'} />);
    expect(html).toContain('<br/>');
  });

  it('fails soft on mid-stream input (unclosed constructs render, nothing throws)', () => {
    const html = renderToStaticMarkup(<Markdown markdown={'**bol'} />);
    expect(html).toContain('bol');
  });
});

describe('renderRichTextInlines — inline-only helper (A2UI Text path)', () => {
  it('renders an inline run without introducing block elements', () => {
    const html = renderToStaticMarkup(
      <span>{renderRichTextInlines(parseInlineRichText('a **b** c'))}</span>,
    );
    expect(html).toContain('<strong');
    expect(html).not.toContain('<p');
  });
});
