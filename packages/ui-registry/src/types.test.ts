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
  WriteResult,
} from './index.js';
import type { UiManifest } from '@ggui-ai/project-config';

function buildManifest(id: string): UiManifest {
  return {
    id,
    name: 'Fixture Card',
    contract: { intent: 'fixture' },
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
      capabilities: { writable: false, observable: false },
    };
    // Sanity: the read paths work without write / subscribe.
    expect(registry.capabilities.writable).toBe(false);
    expect(registry.capabilities.observable).toBe(false);
    expect(registry.write).toBeUndefined();
    expect(registry.subscribe).toBeUndefined();
  });

  it('a writable + observable registry implements the optional methods', async () => {
    const state = new Map<string, UiManifestEntry>();
    const registry: UiRegistry = {
      list: async () => Array.from(state.values()),
      get: async (id) => state.get(id),
      getBundle: async () => undefined,
      subscribe: () => () => undefined,
      write: async (entry) => {
        const existing = state.get(entry.id);
        if (existing && existing.contentHash !== entry.contentHash) {
          return {
            ok: false,
            reason: 'id-conflict',
            existingHash: existing.contentHash,
          };
        }
        state.set(entry.id, entry);
        return { ok: true, contentHash: entry.contentHash };
      },
      remove: async (id) => {
        state.delete(id);
      },
      capabilities: { writable: true, observable: true },
    };

    const entry: UiManifestEntry = {
      id: 'form',
      contentHash: 'v1',
      manifest: buildManifest('form'),
    };

    const first = await registry.write!(entry);
    expect(first).toEqual({ ok: true, contentHash: 'v1' });
    expect(await registry.get('form')).toEqual(entry);

    const conflict = await registry.write!({ ...entry, contentHash: 'v2' });
    expect(conflict).toEqual({
      ok: false,
      reason: 'id-conflict',
      existingHash: 'v1',
    });

    await registry.remove!('form');
    expect(await registry.get('form')).toBeUndefined();
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

  it('WriteResult tags cover ok + three failure modes', () => {
    const results: WriteResult[] = [
      { ok: true, contentHash: 'h' },
      { ok: false, reason: 'id-conflict', existingHash: 'h' },
      { ok: false, reason: 'validation-failed', issues: ['e'] },
      { ok: false, reason: 'not-supported' },
    ];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(3);
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
    const caps: UiRegistryCapabilities = { writable: true, observable: false };
    expect(caps).toEqual({ writable: true, observable: false });
  });
});
