import { describe, expect, it } from 'vitest';
import { ManifestBlueprintProvider } from './manifest-blueprint-provider.js';
import type { ManifestBlueprintSeed } from './manifest-blueprint-provider.js';

const now = () => new Date('2026-04-20T00:00:00Z').getTime();

function seed(partial: Partial<ManifestBlueprintSeed> & { id: string }): ManifestBlueprintSeed {
  return { name: partial.id, ...partial };
}

describe('ManifestBlueprintProvider — impl-specific', () => {
  it('is empty when no manifests are seeded', async () => {
    const p = new ManifestBlueprintProvider({ now });
    const entries = await p.list({});
    expect(entries).toEqual([]);
  });

  it('derives BlueprintEntry shape from a manifest seed', async () => {
    const p = new ManifestBlueprintProvider({
      now,
      manifests: [
        {
          id: 'weather-card',
          name: 'Weather',
          description: 'Shows a city forecast',
          category: 'data',
        },
      ],
    });
    const entries = await p.list({});
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'weather-card',
      name: 'Weather',
      description: 'Shows a city forecast',
      source: { kind: 'user' },
      tags: ['data'],
    });
    expect(entries[0]?.updatedAt).toBe('2026-04-20T00:00:00.000Z');
  });

  it('get(id) returns null for every known id (authored UIs have no ScreenBlueprint)', async () => {
    const p = new ManifestBlueprintProvider({
      now,
      manifests: [seed({ id: 'a' })],
    });
    const full = await p.get('a');
    expect(full).toBeNull();
  });

  it('orders list results by updatedAt DESC then id ASC', async () => {
    const p = new ManifestBlueprintProvider({
      now,
      manifests: [
        { id: 'b', name: 'B', updatedAt: '2026-04-18T00:00:00Z' },
        { id: 'c', name: 'C', updatedAt: '2026-04-20T00:00:00Z' },
        { id: 'a', name: 'A', updatedAt: '2026-04-20T00:00:00Z' },
      ],
    });
    const entries = await p.list({});
    expect(entries.map((e) => e.id)).toEqual(['a', 'c', 'b']);
  });

  it('filters by source kind', async () => {
    const p = new ManifestBlueprintProvider({
      now,
      manifests: [seed({ id: 'a' })],
    });
    const userEntries = await p.list({ sourceKind: 'user' });
    const curatedEntries = await p.list({ sourceKind: 'curated' });
    expect(userEntries).toHaveLength(1);
    expect(curatedEntries).toHaveLength(0);
  });

  it('generator filter never matches user-sourced entries', async () => {
    const p = new ManifestBlueprintProvider({
      now,
      manifests: [seed({ id: 'a' })],
    });
    const entries = await p.list({ generator: 'gen-a' });
    expect(entries).toEqual([]);
  });

  it('filters by tag when category present', async () => {
    const p = new ManifestBlueprintProvider({
      now,
      manifests: [
        seed({ id: 'a', category: 'data' }),
        seed({ id: 'b', category: 'form' }),
      ],
    });
    const dataEntries = await p.list({ tag: 'data' });
    expect(dataEntries.map((e) => e.id)).toEqual(['a']);
  });

  it('filters by query match against name + description', async () => {
    const p = new ManifestBlueprintProvider({
      now,
      manifests: [
        seed({ id: 'weather', name: 'Weather Card', description: 'Forecast' }),
        seed({ id: 'kanban', name: 'Kanban Board' }),
      ],
    });
    const hits = await p.list({ query: 'forecast' });
    expect(hits.map((e) => e.id)).toEqual(['weather']);
  });

  it('addManifest registers or replaces by id', async () => {
    const p = new ManifestBlueprintProvider({ now });
    p.addManifest(seed({ id: 'a', name: 'First' }));
    p.addManifest(seed({ id: 'a', name: 'Second' }));
    const entries = await p.list({});
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('Second');
  });

  it('paginates via limit + offset cursor', async () => {
    const p = new ManifestBlueprintProvider({
      now,
      manifests: Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        name: `M${i}`,
      })),
    });
    const page1 = await p.list({ limit: 2 });
    const page2 = await p.list({ limit: 2, cursor: 'offset:2' });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    const seen = [...page1, ...page2].map((e) => e.id);
    expect(new Set(seen).size).toBe(4);
  });

  it('omits tags array entirely when neither category nor tags given', async () => {
    const p = new ManifestBlueprintProvider({
      now,
      manifests: [{ id: 'a', name: 'A' }],
    });
    const entries = await p.list({});
    expect(entries[0]).not.toHaveProperty('tags');
  });

  it('omits description when not set on the manifest', async () => {
    const p = new ManifestBlueprintProvider({
      now,
      manifests: [{ id: 'a', name: 'A' }],
    });
    const entries = await p.list({});
    expect(entries[0]).not.toHaveProperty('description');
  });
});
