// Pin (ggui#1096): the runtime's mount target is created without the browser's
// list defaults — no 16 px margins, no 40 px indent, no bullets — so a compact
// card sits at the pane edge and fits its box. A root the document already
// carries is the host's and is left as it is.
import { describe, expect, it } from 'vitest';
import { ensureStatusDom } from '../status-dom.js';

describe('ensureStatusDom — the mount list carries no list defaults', () => {
  it('creates <ul data-ggui-session-root> with margin 0, padding 0, list-style none', () => {
    document.body.innerHTML = '';
    const { renderRoot } = ensureStatusDom(document);
    expect(renderRoot.tagName).toBe('UL');
    expect(renderRoot.hasAttribute('data-ggui-session-root')).toBe(true);
    expect(renderRoot.style.margin).toBe('0px');
    expect(renderRoot.style.padding).toBe('0px');
    expect(renderRoot.style.listStyle).toBe('none');
  });

  it('reuses a pre-existing root untouched', () => {
    document.body.innerHTML = '<div data-ggui-session-root style="padding: 4px"></div>';
    const { renderRoot } = ensureStatusDom(document);
    expect(renderRoot.tagName).toBe('DIV');
    expect(renderRoot.style.padding).toBe('4px');
  });
});
