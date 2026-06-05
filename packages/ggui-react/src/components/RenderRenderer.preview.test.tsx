/**
 * GguiSessionRenderer — provisional-branch tests.
 *
 * Verifies the small conditional added in
 * `DynamicComponent.tsx` that routes renders with empty
 * `componentCode` through `ProvisionalRenderer` instead of the
 * ESM-loading path. The goal is behavioural-preservation plus the
 * forward-compatible upgrade when `_ggui:preview` envelopes arrive.
 *
 * Post-Phase-B: `StackItemRenderer` was renamed to `GguiSessionRenderer` and
 * the prop shape collapsed from `{ stackItem: {...} }` to a flat
 * `{ render: {...} }` carrying the single mounted render.
 */
import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import { BRIDGE_EVENTS, PREVIEW_CHANNEL } from '@ggui-ai/protocol';
import type { StreamEnvelope } from '@ggui-ai/protocol';
import { GguiSessionRenderer } from './DynamicComponent.js';

function sendPreview(payload: unknown): void {
  const envelope: StreamEnvelope = {
    renderId: 'render-preview',
    channel: PREVIEW_CHANNEL,
    mode: 'append',
    payload: payload as StreamEnvelope['payload'],
  };
  act(() => {
    window.dispatchEvent(
      new CustomEvent(BRIDGE_EVENTS.AGENT_DATA, { detail: envelope }),
    );
  });
}

describe('GguiSessionRenderer — provisional branching', () => {
  it('routes empty componentCode through ProvisionalRenderer and shows the caller fallback', () => {
    const { container } = render(
      <GguiSessionRenderer
        render={{ id: 'pending', componentCode: '' }}
        fallback={<div data-testid="loading">loading…</div>}
      />,
    );
    // No preview envelopes yet → caller's fallback is shown exactly
    // like the pre-branching behaviour.
    expect(container.querySelector('[data-testid="loading"]')).not.toBeNull();
    expect(container.querySelector('[data-ggui-preview]')).toBeNull();
  });

  it('paints the provisional surface once preview envelopes arrive', () => {
    const { container } = render(
      <GguiSessionRenderer
        render={{ id: 'pending', componentCode: '' }}
      />,
    );
    sendPreview({
      version: 'v0.9',
      createSurface: { surfaceId: 'pending', catalogId: 'ggui.preview.v1' },
    });
    sendPreview({
      version: 'v0.9',
      updateComponents: {
        surfaceId: 'pending',
        components: [
          {
            id: 'root',
            component: 'Text',
            text: 'Assembling your UI…',
          },
        ],
      },
    });
    expect(container.querySelector('[data-ggui-preview]')).not.toBeNull();
    expect(container.textContent).toContain('Assembling your UI…');
  });

  it('does NOT route through the preview path when componentCode is present', () => {
    const { container } = render(
      <GguiSessionRenderer
        render={{
          id: 'ready',
          componentCode: 'export default function C() { return null; }',
        }}
        fallback={<div data-testid="loading">loading…</div>}
      />,
    );
    // With real code the ReactComponentRenderer path fires — no
    // provisional surface appears, and no preview envelopes leak
    // into this branch.
    expect(container.querySelector('[data-ggui-preview]')).toBeNull();
    sendPreview({
      version: 'v0.9',
      createSurface: { surfaceId: 'ready', catalogId: 'ggui.preview.v1' },
    });
    sendPreview({
      version: 'v0.9',
      updateComponents: {
        surfaceId: 'ready',
        components: [
          { id: 'root', component: 'Text', text: 'should not appear' },
        ],
      },
    });
    expect(container.textContent).not.toContain('should not appear');
  });
});
