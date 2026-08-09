// Live-region lifecycle guard for Toast (ggui#464).
//
// The defect class: a live region created in the same tick as its
// message may never be announced — politeness is read when the region
// registers, and `role="alert"` insertion-announcement is AT/browser-
// dependent, not guaranteed. The fix keeps the region mounted while
// hidden; these tests pin the property that actually matters — NODE
// IDENTITY across the visible flip — because a has-content assertion
// passes just as well against the broken unmount/remount version.

import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Toast } from '../Toast';

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

describe('Toast — the live region persists while hidden', () => {
  it('renders an empty, visually collapsed alert region when not visible', () => {
    const html = renderToStaticMarkup(<Toast message="saved" visible={false} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).not.toContain('saved');
  });

  it('keeps the SAME DOM node across hidden → visible — the flip is a mutation, not a mount', async () => {
    const { container, root } = mount();
    await act(async () => {
      root.render(<Toast message="saved" visible={false} />);
    });
    const before = container.querySelector('[role="alert"]');
    expect(before).not.toBeNull();
    expect(before?.textContent).toBe('');

    await act(async () => {
      root.render(<Toast message="saved" visible={true} />);
    });
    const after = container.querySelector('[role="alert"]');
    // Identity, not presence: the broken version (return null while
    // hidden) also produces a region with the text — but a DIFFERENT
    // node, created alongside its content.
    expect(after).toBe(before);
    expect(after?.textContent).toContain('saved');
    root.unmount();
  });

  it('hiding empties the region on the same node — no stale announcement left standing', async () => {
    const { container, root } = mount();
    await act(async () => {
      root.render(<Toast message="saved" visible={true} />);
    });
    const shown = container.querySelector('[role="alert"]');
    expect(shown?.textContent).toContain('saved');

    await act(async () => {
      root.render(<Toast message="saved" visible={false} />);
    });
    const hidden = container.querySelector('[role="alert"]');
    expect(hidden).toBe(shown);
    expect(hidden?.textContent).toBe('');
    root.unmount();
  });

  it('keeps the baked-in ARIA the ui-gen evaluator table documents, in both states', () => {
    // llm-evaluator.ts's primitive table: `Toast` — `role="alert"` +
    // `aria-live`. Losing either in EITHER state stales that table.
    for (const visible of [true, false]) {
      const html = renderToStaticMarkup(<Toast message="m" visible={visible} />);
      expect(html).toContain('role="alert"');
      expect(html).toContain('aria-live="assertive"');
    }
  });
});
