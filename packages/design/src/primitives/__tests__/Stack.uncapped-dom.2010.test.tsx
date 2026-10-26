/**
 * Pin (ggui#2010): the row cap touches only a capped group. A `<Row wrap>` / `<Stack>` WITHOUT `maxRows` renders the
 * same element it rendered before the cap existed (the opening tags below are copied from the render at `60e2bb6a1`,
 * the commit before the cap), with its children's own markup passed through unchanged: no attribute, wrapper or style
 * is added for an uncapped group.
 */
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from '../Button';
import { Row } from '../Row';
import { Stack } from '../Stack';

const kids = ['Alpha', 'Beta gamma', 'Delta'].map((l) => h(Button, { key: l, variant: 'outline', size: 'sm' }, l));
const childMarkup = renderToStaticMarkup(h('div', null, kids)).replace(/^<div>/, '').replace(/<\/div>$/, '');

const BASE_OPENING_TAG = {
  rowWrap: "<div style=\"display:flex;flex-direction:row;gap:var(--ggui-spacing-sm, 8px);align-items:center;justify-content:flex-start;flex-wrap:wrap\">",
  rowNoWrap: "<div style=\"display:flex;flex-direction:row;gap:var(--ggui-spacing-sm, 8px);align-items:stretch;justify-content:flex-start;flex-wrap:nowrap\">",
  stackVerticalWrap: "<div style=\"display:flex;flex-direction:column;gap:var(--ggui-spacing-sm, 8px);align-items:stretch;justify-content:flex-start;flex-wrap:wrap\">",
} as const;

describe('an uncapped group renders as before the row cap (ggui#2010)', () => {
  it.each([
    ['rowWrap', h(Row, { gap: 'sm', wrap: true, align: 'center' }, kids)],
    ['rowNoWrap', h(Row, { gap: 'sm' }, kids)],
    ['stackVerticalWrap', h(Stack, { gap: 'sm', wrap: true }, kids)],
  ] as const)('%s: base element, children unchanged', (name, el) => {
    expect(renderToStaticMarkup(el)).toBe(`${BASE_OPENING_TAG[name]}${childMarkup}</div>`);
  });
});
