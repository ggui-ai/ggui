/**
 * Contract test factory for {@link BlueprintProvider} implementations.
 *
 * Narrowed surface (2026-04-18) — two read methods:
 *
 *   - `list(filter)` browses the catalog. Filters on `source`, `tag`,
 *     and `query` (optional — providers MAY ignore query). Paginates
 *     via opaque cursor.
 *   - `get(id)` returns the full `ScreenBlueprint` or null.
 *
 * Decision quality (did it rank the right blueprint?) is NOT part of
 * this contract — blueprint ranking is the negotiator's responsibility.
 * A provider that returns catalog entries in any stable order passes.
 *
 * Providers that can't accept ad-hoc seeds (e.g. a read-through cache
 * of a remote catalog) omit the `seed` option — filter tests then skip.
 */
import { describe, expect, it } from 'vitest';
import type { ScreenBlueprint } from '@ggui-ai/protocol';
import type { BlueprintProvider } from '../blueprint-provider.js';

export interface BlueprintProviderContractOptions {
  /**
   * Populate the provider with a catalog. Omit if the provider is
   * read-only against an external source; catalog-dependent tests
   * then skip.
   */
  seed?: (provider: BlueprintProvider, blueprints: ScreenBlueprint[]) => Promise<void>;
}

export function blueprintProviderContract(
  label: string,
  makeProvider: () => Promise<BlueprintProvider> | BlueprintProvider,
  opts: BlueprintProviderContractOptions = {},
): void {
  describe(`BlueprintProvider contract — ${label}`, () => {
    it('get on an unknown id returns null', async () => {
      const p = await makeProvider();
      await expect(p.get('nope')).resolves.toBeNull();
    });

    if (opts.seed) {
      const seed = opts.seed;

      it('list returns every seeded blueprint when no filter is applied', async () => {
        const p = await makeProvider();
        await seed(p, [
          blueprint('weather-card', 'Weather Card'),
          blueprint('kanban-board', 'Kanban Board'),
        ]);
        const rows = await p.list({});
        expect(rows.map((r) => r.id).sort()).toEqual([
          'kanban-board',
          'weather-card',
        ]);
      });

      it('get returns the full blueprint after seed', async () => {
        const p = await makeProvider();
        await seed(p, [blueprint('weather-card', 'Weather Card')]);
        const full = await p.get('weather-card');
        expect(full).not.toBeNull();
        expect(full?.id).toBe('weather-card');
        expect(full?.displayName).toBe('Weather Card');
      });

      it('list filters by source', async () => {
        const p = await makeProvider();
        await seed(p, [
          blueprint('a', 'A', { source: 'curated' }),
          blueprint('b', 'B', { source: 'llm' }),
        ]);
        const curated = await p.list({ source: 'curated' });
        expect(curated.map((r) => r.id)).toEqual(['a']);
        const llm = await p.list({ source: 'llm' });
        expect(llm.map((r) => r.id)).toEqual(['b']);
      });

      it('list limit caps the result set', async () => {
        const p = await makeProvider();
        await seed(p, [
          blueprint('a', 'A'),
          blueprint('b', 'B'),
          blueprint('c', 'C'),
        ]);
        const rows = await p.list({ limit: 2 });
        expect(rows.length).toBe(2);
      });

      it('get returns an independent object — caller mutations do not poison the store', async () => {
        const p = await makeProvider();
        await seed(p, [blueprint('weather-card', 'Weather Card')]);
        const a = await p.get('weather-card');
        if (a) (a as ScreenBlueprint & { displayName: string }).displayName = 'CHANGED';
        const b = await p.get('weather-card');
        expect(b?.displayName).toBe('Weather Card');
      });
    }
  });
}

function blueprint(
  id: string,
  displayName: string,
  overrides: Partial<ScreenBlueprint> = {},
): ScreenBlueprint {
  return {
    id,
    server: 'test-server',
    displayName,
    intent: `Show a ${displayName}`,
    data: {},
    ...overrides,
  };
}
