/**
 * Tests for the provisional (A2UI preview) renderer mount lifecycle.
 *
 * Uses the explicit `pushEnvelope` entry point the iframe-runtime
 * port ships (the host-SDK version read via React hook from a
 * live-channel bridge event). Locks:
 *
 *   1. Non-PREVIEW_CHANNEL envelopes are silently ignored.
 *   2. The default spinner fallback renders until the `root` fragment
 *      arrives via an `updateComponents` message.
 *   3. `suspend()` hides the surface; `resume()` un-hides.
 *   4. `unmount()` clears the container.
 *   5. Malformed A2UI payloads (non-spec shape) don't crash the
 *      render — the reducer drops them silently (matches
 *      ProvisionalRenderer.tsx).
 *
 * Not covered at this layer: full A2UI catalog adjacency-list
 * rendering (that's the design-package's test surface, not the
 * renderer's). We assert the glue.
 */
import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { PREVIEW_CHANNEL } from '@ggui-ai/protocol';
import type { StreamEnvelope } from '@ggui-ai/protocol';
import { mountProvisional } from '../provisional-renderer.js';

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/**
 * React 19 defers initial renders via the concurrent scheduler. In
 * jsdom specs we need to `act()` to flush the commit phase so DOM
 * assertions see the rendered tree.
 */
async function flush(fn?: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    if (fn) await fn();
  });
}

describe('mountProvisional — default fallback', () => {
  it('renders a spinner fallback until the root fragment arrives', async () => {
    const container = makeContainer();
    const mount = mountProvisional(container);
    await flush();

    // The default fallback renders a Spinner component. We don't
    // assert its exact internals (owned by @ggui-ai/design); just
    // that SOMETHING is in the container.
    expect(container.children.length).toBeGreaterThan(0);

    mount.unmount();
  });

  it('unmount clears the container', async () => {
    const container = makeContainer();
    const mount = mountProvisional(container);
    await flush();
    expect(container.children.length).toBeGreaterThan(0);
    mount.unmount();
    expect(container.children.length).toBe(0);
  });
});

describe('mountProvisional — envelope pushing', () => {
  it('ignores envelopes on channels other than _ggui:preview', async () => {
    const container = makeContainer();
    const mount = mountProvisional(container);
    await flush();

    const offChannel: StreamEnvelope = {
      sessionId: 'render_001',
      channel: 'progress',
      mode: 'append',
      payload: { percent: 50 },
    };

    // Must not throw; must not affect the surface.
    mount.pushEnvelope(offChannel);
    await flush();
    // Fallback still present.
    expect(container.children.length).toBeGreaterThan(0);

    mount.unmount();
  });

  it('survives malformed A2UI payloads — they drop silently', async () => {
    const container = makeContainer();
    const mount = mountProvisional(container);
    await flush();

    const malformed: StreamEnvelope = {
      sessionId: 'render_001',
      channel: PREVIEW_CHANNEL,
      mode: 'append',
      payload: { notAnA2uiMessage: true },
    };

    expect(() => mount.pushEnvelope(malformed)).not.toThrow();
    await flush();
    mount.unmount();
  });
});

describe('mountProvisional — suspend/resume', () => {
  it('suspend hides the surface; resume re-shows', async () => {
    const container = makeContainer();
    const mount = mountProvisional(container);
    await flush();

    const before = container.children.length;
    expect(before).toBeGreaterThan(0);

    mount.suspend();
    await flush();
    // Suspended render returns null — the root still has a container
    // but no user-visible content. jsdom's root mount leaves an
    // element even on null renders, so we verify by string content
    // rather than element count.
    const suspendedMarkup = container.innerHTML;
    expect(suspendedMarkup).toBe('');

    mount.resume();
    await flush();
    expect(container.innerHTML.length).toBeGreaterThan(0);

    mount.unmount();
  });
});

describe('mountProvisional — pre-mount pending queue', () => {
  it('queues envelopes pushed before the controller ref resolves', async () => {
    const container = makeContainer();
    const mount = mountProvisional(container);

    // Push envelope BEFORE flushing — controlRef is still null at
    // this instant.
    const env: StreamEnvelope = {
      sessionId: 'render_001',
      channel: PREVIEW_CHANNEL,
      mode: 'append',
      payload: { notAnA2uiMessage: true }, // malformed, but the
      // queue-drain path still exercises; a real A2UI message would
      // build visible DOM but we already cover that via the
      // reduce-level tests elsewhere.
    };
    expect(() => mount.pushEnvelope(env)).not.toThrow();

    await flush();
    mount.unmount();
  });

  it('drains queued envelopes into the rendered surface once the controller mounts', async () => {
    // Load-bearing regression test: pre-fix, `mountProvisional`
    // scheduled a one-shot `queueMicrotask(drainPending)` from inside
    // `pushEnvelope`. When the microtask fired BEFORE React's
    // `useEffect` populated `controlRef.current`, the queue was
    // abandoned silently and the surface stayed stuck on the
    // spinner — even though the envelopes had reached
    // `pushEnvelope`. The bug was visible end-to-end on
    // `e2e/ggui-oss/tests/provisional-preview.spec.ts` because the
    // iframe-runtime forwards reserved-channel WS frames to
    // `pushEnvelope` synchronously from the message handler, BEFORE
    // React commits.
    //
    // The fix routes the drain through an `onAttach` callback fired
    // from inside the controller's `useEffect`, so the queue is
    // ALWAYS drained at the moment React's controller mounts —
    // independent of microtask ordering.
    const container = makeContainer();
    const mount = mountProvisional(container);

    // Three valid A2UI frames pushed BEFORE any flush. Pre-fix this
    // path raced React; post-fix the drain happens on attach.
    const surfaceId = 'sx';
    const v0_9 = 'v0.9' as const;
    mount.pushEnvelope({
      sessionId: 'render_001',
      channel: PREVIEW_CHANNEL,
      mode: 'append',
      payload: {
        version: v0_9,
        createSurface: { surfaceId, catalogId: 'a2ui-v0.9-default' },
      },
    });
    mount.pushEnvelope({
      sessionId: 'render_001',
      channel: PREVIEW_CHANNEL,
      mode: 'append',
      payload: {
        version: v0_9,
        updateComponents: {
          surfaceId,
          components: [
            {
              id: 'root',
              component: 'Column',
              children: ['heading'],
              gap: '12',
              align: 'stretch',
            },
            {
              id: 'heading',
              component: 'Text',
              variant: 'h2',
              text: 'Pinned headline',
            },
          ],
        },
      },
    });

    await flush();

    // Controller mounted, drain ran, fragments reduced — the
    // PreviewSurface is rendered (data-ggui-preview attribute is the
    // load-bearing selector the Lane-1 spec waits on).
    const surface = container.querySelector('[data-ggui-preview]');
    expect(surface).not.toBeNull();
    expect(surface?.textContent ?? '').toContain('Pinned headline');

    mount.unmount();
  });
});
