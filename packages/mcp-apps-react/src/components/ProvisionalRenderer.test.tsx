/**
 * ProvisionalRenderer — static-path behaviour tests: fallback
 * rendering, default Spinner, and the `suspended` latch. The live
 * A2UI preview pipeline lives in `@ggui-ai/iframe-runtime`; this
 * host-side placeholder has no live channel.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ProvisionalRenderer } from './ProvisionalRenderer.js';

describe('ProvisionalRenderer — static path', () => {
  it('renders the caller fallback', () => {
    const { container } = render(
      <ProvisionalRenderer fallback={<div data-testid="fallback">loading</div>} />,
    );
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull();
  });

  it('uses a default Spinner fallback when none is provided', () => {
    const { container } = render(<ProvisionalRenderer />);
    // Any rendered content at all IS the fallback.
    expect(container.firstChild).not.toBeNull();
  });
});

describe('ProvisionalRenderer — suspended prop', () => {
  it('renders nothing when suspended', () => {
    const { container } = render(<ProvisionalRenderer suspended />);
    expect(container.firstChild).toBeNull();
  });

  it('resumes rendering when suspended flips back to false', () => {
    const { container, rerender } = render(<ProvisionalRenderer suspended />);
    expect(container.firstChild).toBeNull();

    rerender(<ProvisionalRenderer />);
    expect(container.firstChild).not.toBeNull();
  });
});
