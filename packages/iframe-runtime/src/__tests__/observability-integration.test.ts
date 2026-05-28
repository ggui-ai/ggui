/**
 * C12 integration smoke — renderer postMessage → host onObserve →
 * console classifier.
 *
 * Stitches together the three C12 seams in one spec:
 *
 *   1. RENDERER EMIT — `postObservabilityToParent` fires an
 *      `ObservabilityMessage` envelope to `window.parent`.
 *   2. HOST RECEIVE — a mock listener on the parent window (standing
 *      in for C9's `<McpAppIframe onObserve>`) deserializes the
 *      envelope and forwards the typed `event` to a consumer
 *      callback.
 *   3. CONSUMER FILTER — a tiny re-implementation of console's
 *      `activityEventMatchesTab` classifier (kept local here so this
 *      spec doesn't take a dep on `@ggui-ai/console`) buckets the
 *      observation into the correct tab.
 *
 * The test intentionally does NOT import `@ggui-ai/console` — keeping
 * the renderer free of console is load-bearing (the renderer ships
 * inside user iframes and must stay small). Console's classifier is
 * covered in its own spec; this one proves the postMessage envelope
 * carries the event unchanged across the boundary.
 *
 * The host-side listener shape matches what
 * `<McpAppIframe onObserve>` wires in C9: `window.addEventListener(
 * 'message', …)` → check `data.type === 'ggui:observe'` → forward
 * `data.event`. Any deviation here would diverge C9 and C12.
 */
import { describe, it, expect } from 'vitest';
import {
  postObservabilityToParent,
  type ObservabilityEvent,
  type ObservabilityMessage,
} from '../observability.js';

// --- Consumer-side classifier (mirrors console/RenderInspector) ---

type ActivityTab = 'All' | 'Actions' | 'Errors' | 'Version' | 'Subscribe';

function observabilityCategoryOf(kind: string): ActivityTab | undefined {
  if (kind === 'wired-tool-invoked') return 'Actions';
  if (kind === 'contract-error-emitted') return 'Errors';
  if (kind === 'schema-version-mismatch') return 'Version';
  if (kind === 'subscribe-failed') return 'Subscribe';
  return undefined;
}

describe('C12 observability integration — renderer → host → classifier', () => {
  /**
   * Stand up a host-side postMessage listener, run a renderer-side
   * emit for each of the four canonical kinds, and assert every
   * event lands in its declared tab bucket.
   */
  it('every emitted kind reaches the classifier with the right category', async () => {
    const received: ObservabilityEvent[] = [];

    const hostListener = (event: MessageEvent): void => {
      const data = event.data as unknown;
      if (data === null || typeof data !== 'object') return;
      if ((data as { type?: unknown }).type !== 'ggui:observe') return;
      // This shape-match mirrors `<McpAppIframe onObserve>`'s contract
      // per C9's brief: filter by envelope type, forward the `event`
      // field opaquely.
      const envelope = data as ObservabilityMessage;
      received.push(envelope.event);
    };
    window.addEventListener('message', hostListener);

    try {
      const emissions: ObservabilityEvent[] = [
        {
          kind: 'wired-tool-invoked',
          toolName: 'tasks.create_tool',
          actionName: 'tasks.create',
          dispatchedAt: '2026-04-23T00:00:00.000Z',
        },
        {
          kind: 'contract-error-emitted',
          code: 'TOOL_THREW',
          toolName: 'tasks.create_tool',
          actionName: 'tasks.create',
        },
        {
          kind: 'schema-version-mismatch',
          observedVersion: '99.0.0',
          acceptedVersions: ['1.0.0'],
          observedBy: 'server',
        },
        {
          kind: 'subscribe-failed',
          reason: 'transport-reconnecting',
          message: 'test',
        },
      ];

      for (const emission of emissions) {
        postObservabilityToParent(emission);
      }

      // postMessage is asynchronous per the HTML spec — flush the
      // microtask queue so the listener gets a chance to run.
      await new Promise((r) => setTimeout(r, 0));

      expect(received.length).toBe(emissions.length);
      const pairs = received.map((e) => ({
        kind: e.kind,
        tab: observabilityCategoryOf(e.kind),
      }));
      expect(pairs).toEqual([
        { kind: 'wired-tool-invoked', tab: 'Actions' },
        { kind: 'contract-error-emitted', tab: 'Errors' },
        { kind: 'schema-version-mismatch', tab: 'Version' },
        { kind: 'subscribe-failed', tab: 'Subscribe' },
      ]);
    } finally {
      window.removeEventListener('message', hostListener);
    }
  });

  it('unknown-kind observations reach the host with opaque fields preserved', async () => {
    const received: ObservabilityEvent[] = [];
    const hostListener = (event: MessageEvent): void => {
      const data = event.data as unknown;
      if (
        data !== null &&
        typeof data === 'object' &&
        (data as { type?: unknown }).type === 'ggui:observe'
      ) {
        received.push((data as ObservabilityMessage).event);
      }
    };
    window.addEventListener('message', hostListener);

    try {
      // Cast justification: UnknownObservabilityEvent accepts any
      // extra fields; TS still sees the explicit literal as narrowing
      // to the known union if we omit the type annotation. Naming the
      // union keeps the producer shape honest.
      const unknown: ObservabilityEvent = {
        kind: 'future-renderer-kind',
        someField: 'some-value',
      };
      postObservabilityToParent(unknown);
      await new Promise((r) => setTimeout(r, 0));

      expect(received.length).toBe(1);
      const evt = received[0];
      expect(evt?.kind).toBe('future-renderer-kind');
      // Opaque fields survive the boundary unchanged.
      expect((evt as { someField?: unknown })?.someField).toBe('some-value');
      // Classifier correctly leaves unknown kinds unbucketed.
      expect(observabilityCategoryOf(evt?.kind ?? '')).toBeUndefined();
    } finally {
      window.removeEventListener('message', hostListener);
    }
  });
});
