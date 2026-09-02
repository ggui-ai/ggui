/**
 * ggui#670 G1 — `Button inert`: the NON-SUPPRESSING inert affordance.
 * `disabled` strips the handler and sets native `disabled` (the attempt
 * never happens — component-layer suppression, which kills the runtime's
 * self-heal sensor). `inert` is the opposite contract: visibly inert
 * (`aria-disabled`, dimmed, an explanation via `title`) while the click
 * STILL dispatches. Hidden from the taught surface (`@internal`) until
 * Phase 2 un-hides it under its pre-registered bench.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '../Button';

describe('Button inert (ggui#670 G1)', () => {
  it('renders aria-disabled + title, dims, and does NOT set native disabled', () => {
    const html = renderToStaticMarkup(
      createElement(Button, { inert: true, inertHint: 'Host cannot relay actions' }, 'Save'),
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('title="Host cannot relay actions"');
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(html).toMatch(/opacity:\s*0\.5/);
  });

  it('keeps the click handler wired — the attempt still dispatches', async () => {
    const onClick = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Button, { inert: true, onClick }, 'Save'));
    });
    const btn = container.querySelector('button')!;
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.hasAttribute('disabled')).toBe(false);
    await act(async () => { btn.click(); });
    expect(onClick).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('disabled still suppresses (unchanged contract) — inert does not override it', () => {
    const html = renderToStaticMarkup(
      createElement(Button, { disabled: true, inert: true }, 'Save'),
    );
    expect(html).toMatch(/\sdisabled(=|\s|>)/);
  });

  it('without inert, nothing changes: no aria-disabled, no title', () => {
    const html = renderToStaticMarkup(createElement(Button, null, 'Save'));
    expect(html).not.toContain('aria-disabled');
    expect(html).not.toContain('title=');
  });
});
