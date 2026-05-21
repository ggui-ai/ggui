import { describe, expect, it } from 'vitest';
import type { ScreenBlueprint } from '@ggui-ai/protocol';
import { blueprintProviderContract } from '../contract-tests/blueprint-provider.js';
import {
  InMemoryBlueprintProvider,
  type BlueprintSeed,
} from './blueprint-provider.js';

blueprintProviderContract(
  'InMemoryBlueprintProvider',
  () => new InMemoryBlueprintProvider(),
  {
    // eslint-disable-next-line @typescript-eslint/require-await
    seed: async (provider, blueprints) => {
      const impl = provider as InMemoryBlueprintProvider;
      for (const bp of blueprints) impl.add(bp);
    },
  },
);

describe('InMemoryBlueprintProvider — impl-specific', () => {
  const wx: ScreenBlueprint = {
    id: 'weather-card',
    server: 'test',
    displayName: 'Weather Card',
    intent: 'Show current weather',
    data: {},
    source: 'curated',
  };
  const kanban: ScreenBlueprint = {
    id: 'kanban-board',
    server: 'test',
    displayName: 'Kanban Board',
    intent: 'Track tasks in columns',
    data: {},
    source: 'llm',
  };

  it('accepts plain ScreenBlueprint values as seeds', async () => {
    const p = new InMemoryBlueprintProvider({ seeds: [wx, kanban] });
    const list = await p.list({});
    expect(list.map((r) => r.id).sort()).toEqual(['kanban-board', 'weather-card']);
  });

  it('defaults source to "curated" when blueprint omits it', async () => {
    const p = new InMemoryBlueprintProvider({
      seeds: [{ ...wx, source: undefined }],
    });
    const list = await p.list({});
    expect(list[0]?.source).toBe('curated');
  });

  it('applies seed-provided updatedAt + tags', async () => {
    const p = new InMemoryBlueprintProvider({
      seeds: [
        {
          blueprint: wx,
          updatedAt: '2026-01-01T00:00:00.000Z',
          tags: ['forecast', 'city'],
        },
      ],
    });
    const list = await p.list({});
    expect(list[0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(list[0]?.tags).toEqual(['forecast', 'city']);
  });

  it('list filters by tag', async () => {
    const p = new InMemoryBlueprintProvider({
      seeds: [
        { blueprint: wx, tags: ['weather'] },
        { blueprint: kanban, tags: ['productivity'] },
      ],
    });
    const weather = await p.list({ tag: 'weather' });
    expect(weather.map((r) => r.id)).toEqual(['weather-card']);
  });

  it('list query matches name + description (case-insensitive)', async () => {
    const p = new InMemoryBlueprintProvider({ seeds: [wx, kanban] });
    const match = await p.list({ query: 'TASKS' });
    expect(match.map((r) => r.id)).toEqual(['kanban-board']);
  });

  it('list uses updatedAt DESC for stable ordering', async () => {
    const p = new InMemoryBlueprintProvider({
      seeds: [
        { blueprint: wx, updatedAt: '2026-01-01T00:00:00.000Z' },
        { blueprint: kanban, updatedAt: '2026-02-01T00:00:00.000Z' },
      ],
    });
    const list = await p.list({});
    expect(list.map((r) => r.id)).toEqual(['kanban-board', 'weather-card']);
  });

  it('cursor paginates', async () => {
    const blueprints = Array.from({ length: 5 }, (_, i): ScreenBlueprint => ({
      id: `bp-${i}`,
      server: 'test',
      displayName: `BP ${i}`,
      intent: 'test',
      data: {},
      source: 'curated',
    }));
    const p = new InMemoryBlueprintProvider({
      seeds: blueprints.map((b, i): BlueprintSeed => ({
        blueprint: b,
        updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      })),
    });
    const page1 = await p.list({ limit: 2 });
    const page2 = await p.list({ limit: 2, cursor: 'offset:2' });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page1[0]?.id).not.toBe(page2[0]?.id);
  });

  it('add overwrites a previously registered blueprint', async () => {
    const p = new InMemoryBlueprintProvider({ seeds: [wx] });
    p.add({ ...wx, displayName: 'Weather Card (v2)' });
    const full = await p.get('weather-card');
    expect(full?.displayName).toBe('Weather Card (v2)');
  });
});
