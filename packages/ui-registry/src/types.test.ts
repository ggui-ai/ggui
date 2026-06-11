/**
 * Type-shape smoke tests — deliberately minimal. The contract is
 * mostly structural, so the real "test" is downstream consumers
 * typechecking against it. These cases pin the shapes that would
 * otherwise drift silently.
 */
import { describe, expect, it } from 'vitest';
import type {
  UiBundle,
  UiManifestEntry,
  UiRegistry,
  UiRegistryCapabilities,
  UiRegistryEvent,
} from './index.js';
import type { UiManifest } from '@ggui-ai/project-config';

function buildManifest(id: string): UiManifest {
  return {
    id,
    name: 'Fixture Card',
    contract: {
      contextSpec: {
        view: { schema: { type: 'string' }, default: 'fixture' },
      },
    },
  };
}

describe('UiRegistry contract — structural shape', () => {
  it('a minimal read-only registry satisfies the interface', () => {
    const entry: UiManifestEntry = {
      id: 'weather-card',
      contentHash: 'abc123',
      manifest: buildManifest('weather-card'),
    };
    const registry: UiRegistry = {
      list: async () => [entry],
      get: async (id) => (id === entry.id ? entry : undefined),
      getBundle: async (id) =>
        id === entry.id
          ? {
              code: 'export default () => null;',
              contentType: 'application/javascript+react',
            }
          : undefined,
      capabilities: { observable: false },
    };
    // Sanity: the read paths work without subscribe.
    expect(registry.capabilities.observable).toBe(false);
    expect(registry.subscribe).toBeUndefined();
  });

  it('an observable registry implements the optional subscribe method', () => {
    const handlers = new Set<(event: UiRegistryEvent) => void>();
    const registry: UiRegistry = {
      list: async () => [],
      get: async () => undefined,
      getBundle: async () => undefined,
      subscribe: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      capabilities: { observable: true },
    };

    const seen: UiRegistryEvent[] = [];
    const unsubscribe = registry.subscribe!((event) => seen.push(event));
    for (const handler of handlers) {
      handler({ type: 'changed', id: 'form', contentHash: 'v2' });
    }
    unsubscribe();

    expect(seen).toEqual([{ type: 'changed', id: 'form', contentHash: 'v2' }]);
    expect(handlers.size).toBe(0);
  });

  it('UiRegistryEvent is a discriminated union on `type`', () => {
    const events: UiRegistryEvent[] = [
      { type: 'added', id: 'a' },
      { type: 'changed', id: 'b', contentHash: 'h' },
      { type: 'removed', id: 'c' },
    ];
    // Narrowing check — if the union ever drifts, this assignment
    // fails compilation.
    for (const event of events) {
      if (event.type === 'changed') {
        expect(typeof event.contentHash).toBe('string');
      } else {
        expect(typeof event.id).toBe('string');
      }
    }
  });

  it('UiBundle.code accepts both string and ReadableStream', async () => {
    const inline: UiBundle = {
      code: 'export default () => null;',
      contentType: 'application/javascript',
    };
    expect(typeof inline.code).toBe('string');

    // Small ReadableStream — not actually read, just type-assigned.
    const stream: UiBundle = {
      code: new ReadableStream({
        start(controller) {
          controller.enqueue('x');
          controller.close();
        },
      }),
      contentType: 'application/javascript',
    };
    expect(stream.code).toBeInstanceOf(ReadableStream);
  });

  it('UiRegistryCapabilities is a plain flag probe', () => {
    const caps: UiRegistryCapabilities = { observable: false };
    expect(caps).toEqual({ observable: false });
  });
});
