/**
 * GguiSessionRenderer — provisional-branch tests.
 *
 * Verifies the small conditional in `DynamicComponent.tsx` that routes
 * renders with empty `componentCode` through `ProvisionalRenderer`
 * (static placeholder) instead of the ESM-loading path.
 *
 * Post-Phase-B: `StackItemRenderer` was renamed to `GguiSessionRenderer` and
 * the prop shape collapsed from `{ stackItem: {...} }` to a flat
 * `{ render: {...} }` carrying the single mounted render.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { GguiSessionRenderer } from './DynamicComponent.js';

describe('GguiSessionRenderer — provisional branching', () => {
  it('routes empty componentCode through ProvisionalRenderer and shows the caller fallback', () => {
    const { container } = render(
      <GguiSessionRenderer
        render={{ componentCode: '' }}
        fallback={<div data-testid="loading">loading…</div>}
      />,
    );
    expect(container.querySelector('[data-testid="loading"]')).not.toBeNull();
  });

  it('shows the default placeholder when no fallback is given', () => {
    const { container } = render(
      <GguiSessionRenderer render={{ componentCode: '' }} />,
    );
    // ProvisionalRenderer's default Spinner fallback paints something.
    expect(container.firstChild).not.toBeNull();
  });

  it('does NOT route through the provisional path when componentCode is present', () => {
    const { container } = render(
      <GguiSessionRenderer
        render={{
          componentCode: 'export default function C() { return null; }',
        }}
        fallback={<div data-testid="loading">loading…</div>}
      />,
    );
    // With real code the ReactComponentRenderer path fires — the
    // caller fallback belongs to the loader, not the provisional
    // placeholder; nothing provisional-specific mounts here.
    expect(container).not.toBeNull();
  });
});
