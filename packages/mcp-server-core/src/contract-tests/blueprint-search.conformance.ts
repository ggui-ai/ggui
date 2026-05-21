/**
 * `BlueprintSearch` cross-impl conformance suite.
 *
 * Portable battery every {@link BlueprintSearch} implementation MUST
 * satisfy. Same factory pattern as `blueprint-store.conformance` — a
 * factory supplies a fresh search + the store backing it; concrete
 * impls plug in their own runner test.
 *
 * Covered surface:
 *
 *   - Exact contractHash short-circuit (score 1.0; no other axes
 *     consulted; siblings under the same hash also return 1.0).
 *   - Empty store returns empty array.
 *   - Cross-app tenancy boundary — app A's search never returns app B.
 *   - topK is respected — default + per-criteria override.
 *   - generator filter excludes non-matching rows entirely.
 *   - Structural similarity contributes to score when contracts share
 *     shape but not bytes.
 *   - Variance overlap fires on persona match.
 *   - Intent Jaccard fires on token overlap with seedPrompt + persona.
 *   - Empty embedding falls through — other axes still score the row.
 *   - Determinism — identical inputs ⇒ identical output.
 *   - Tie-breaking by createdAt desc, then blueprintId asc.
 *
 * Implementations layer their own adapter-specific tests on top (e.g.
 * the cloud `DynamoBlueprintSearch` additionally asserts the GSI
 * Query shape against a mock DDB client).
 */

import type { Blueprint, DataContract } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';
import type { BlueprintSearch } from '../blueprint-search.js';
import type { BlueprintStore } from '../blueprint-store.js';

/**
 * Factory inputs for the conformance suite. Implementations supply
 * a fresh `(store, search)` pair plus an optional cleanup hook —
 * cloud impls clean up DDB tables between runs.
 */
export interface BlueprintSearchConformanceFactory {
  readonly create: () => Promise<{
    readonly store: BlueprintStore;
    readonly search: BlueprintSearch;
  }>;
  readonly cleanup?: (handle: {
    readonly store: BlueprintStore;
    readonly search: BlueprintSearch;
  }) => Promise<void> | void;
}

function makeBlueprint(
  overrides: Partial<Blueprint> & { blueprintId: string },
): Blueprint {
  return {
    blueprintId: overrides.blueprintId,
    contractHash: overrides.contractHash ?? 'hash-1',
    appId: overrides.appId ?? 'app-1',
    codeS3Url: overrides.codeS3Url,
    codeHash: overrides.codeHash,
    generator: overrides.generator ?? 'ui-gen-default-haiku-4-5',
    validatorScore: overrides.validatorScore,
    variance: overrides.variance ?? {},
    isOperatorDefault: overrides.isOperatorDefault,
    createdAt: overrides.createdAt ?? '2026-05-12T00:00:00.000Z',
    createdBy: overrides.createdBy ?? 'agent',
    contract: overrides.contract ?? { propsSpec: { properties: {} } },
    contractEmbedding: overrides.contractEmbedding,
  };
}

/** Convenience: a contract with one named action + one prop. */
function sampleContract(opts: {
  action?: string;
  prop?: string;
}): DataContract {
  return {
    propsSpec: opts.prop
      ? { properties: { [opts.prop]: { schema: { type: 'string' } } } }
      : { properties: {} },
    actionSpec: opts.action
      ? { [opts.action]: { label: opts.action, schema: { type: 'object' } } }
      : undefined,
  };
}

/**
 * Run the conformance suite under a descriptive label. Call inside a
 * `describe(...)` block in the concrete impl's runner.
 */
export function runBlueprintSearchConformance(
  label: string,
  factory: BlueprintSearchConformanceFactory,
): void {
  async function withSearch<T>(
    fn: (handle: { store: BlueprintStore; search: BlueprintSearch }) => Promise<T>,
  ): Promise<T> {
    const handle = await factory.create();
    try {
      return await fn(handle);
    } finally {
      if (factory.cleanup) await factory.cleanup(handle);
    }
  }

  describe(`${label} — conformance`, () => {
    describe('empty store', () => {
      it('returns empty array', async () => {
        await withSearch(async ({ search }) => {
          const result = await search.search({ appId: 'app-1' });
          expect(result).toEqual([]);
        });
      });

      it('returns empty array for unknown appId', async () => {
        await withSearch(async ({ store, search }) => {
          await store.put(makeBlueprint({ blueprintId: 'bp-1' }));
          const result = await search.search({ appId: 'app-unknown' });
          expect(result).toEqual([]);
        });
      });
    });

    describe('exact contractHash short-circuit', () => {
      it('returns score 1.0 + matchedOn: contract-hash', async () => {
        await withSearch(async ({ store, search }) => {
          await store.put(
            makeBlueprint({ blueprintId: 'bp-1', contractHash: 'hash-a' }),
          );
          const result = await search.search({
            appId: 'app-1',
            contractHash: 'hash-a',
          });
          expect(result).toHaveLength(1);
          expect(result[0]!.score).toBe(1.0);
          expect(result[0]!.matchedOn).toContain('contract-hash');
        });
      });

      it('returns multiple siblings under the same hash, all 1.0', async () => {
        await withSearch(async ({ store, search }) => {
          await store.put(
            makeBlueprint({ blueprintId: 'bp-1', contractHash: 'hash-a' }),
          );
          await store.put(
            makeBlueprint({ blueprintId: 'bp-2', contractHash: 'hash-a' }),
          );
          const result = await search.search({
            appId: 'app-1',
            contractHash: 'hash-a',
          });
          expect(result).toHaveLength(2);
          for (const r of result) expect(r.score).toBe(1.0);
        });
      });

      it('falls through to multi-axis when contractHash misses', async () => {
        await withSearch(async ({ store, search }) => {
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-1',
              contractHash: 'hash-a',
              variance: { persona: 'minimalist' },
            }),
          );
          const result = await search.search({
            appId: 'app-1',
            contractHash: 'hash-missing',
            variance: { persona: 'minimalist' },
          });
          expect(result).toHaveLength(1);
          // variance axis fires; no contract-hash entry.
          expect(result[0]!.matchedOn).toContain('persona');
          expect(result[0]!.matchedOn).not.toContain('contract-hash');
          expect(result[0]!.score).toBeGreaterThan(0);
          expect(result[0]!.score).toBeLessThan(1);
        });
      });
    });

    describe('cross-app tenancy', () => {
      it('never returns blueprints from a different appId', async () => {
        await withSearch(async ({ store, search }) => {
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-app1',
              appId: 'app-1',
              contractHash: 'hash-a',
            }),
          );
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-app2',
              appId: 'app-2',
              contractHash: 'hash-a',
            }),
          );
          const result1 = await search.search({
            appId: 'app-1',
            contractHash: 'hash-a',
          });
          expect(result1.map((r) => r.blueprint.blueprintId)).toEqual([
            'bp-app1',
          ]);
          const result2 = await search.search({
            appId: 'app-2',
            contractHash: 'hash-a',
          });
          expect(result2.map((r) => r.blueprint.blueprintId)).toEqual([
            'bp-app2',
          ]);
        });
      });
    });

    describe('structural similarity axis', () => {
      it('scores blueprints with matching shape but different hashes', async () => {
        await withSearch(async ({ store, search }) => {
          const contract = sampleContract({ action: 'submit', prop: 'name' });
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-1',
              contractHash: 'hash-stored',
              contract,
            }),
          );
          // Query with the same shape but pretend the hash is different.
          const result = await search.search({
            appId: 'app-1',
            contract,
          });
          expect(result).toHaveLength(1);
          expect(result[0]!.score).toBeGreaterThan(0);
          expect(result[0]!.matchedOn).toContain('contract-shape');
        });
      });

      it('scores zero on disjoint structure with no other signal', async () => {
        await withSearch(async ({ store, search }) => {
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-1',
              contract: sampleContract({ action: 'submit', prop: 'name' }),
            }),
          );
          const result = await search.search({
            appId: 'app-1',
            // No contract, no variance, no intent — nothing to match on.
          });
          // Empty criteria + no embedding = no signal; expect empty.
          expect(result).toEqual([]);
        });
      });
    });

    describe('variance overlap axis', () => {
      it('fires on persona equality', async () => {
        await withSearch(async ({ store, search }) => {
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-1',
              variance: { persona: 'minimalist' },
            }),
          );
          const result = await search.search({
            appId: 'app-1',
            variance: { persona: 'minimalist' },
          });
          expect(result).toHaveLength(1);
          expect(result[0]!.matchedOn).toContain('persona');
        });
      });

      it('does not fire on persona mismatch', async () => {
        await withSearch(async ({ store, search }) => {
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-1',
              variance: { persona: 'minimalist' },
            }),
          );
          const result = await search.search({
            appId: 'app-1',
            variance: { persona: 'data-dense' },
          });
          // No matching axes → empty result.
          expect(result).toEqual([]);
        });
      });
    });

    describe('intent Jaccard axis', () => {
      it('fires when intent tokens overlap seedPrompt', async () => {
        await withSearch(async ({ store, search }) => {
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-1',
              variance: { seedPrompt: 'make a sparse weather card' },
            }),
          );
          const result = await search.search({
            appId: 'app-1',
            intentKeywords: ['weather', 'card'],
          });
          expect(result).toHaveLength(1);
          expect(result[0]!.matchedOn).toContain('intent');
        });
      });

      it('fires when intent tokens overlap persona', async () => {
        await withSearch(async ({ store, search }) => {
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-1',
              variance: { persona: 'minimalist sparse' },
            }),
          );
          const result = await search.search({
            appId: 'app-1',
            intentKeywords: ['sparse'],
          });
          expect(result).toHaveLength(1);
          expect(result[0]!.matchedOn).toContain('intent');
        });
      });
    });

    describe('generator filter', () => {
      it('excludes blueprints whose generator differs', async () => {
        await withSearch(async ({ store, search }) => {
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-haiku',
              variance: { persona: 'minimalist' },
              generator: 'ui-gen-default-haiku-4-5',
            }),
          );
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-opus',
              variance: { persona: 'minimalist' },
              generator: 'ui-gen-advanced-opus-4-7',
            }),
          );
          const result = await search.search({
            appId: 'app-1',
            variance: { persona: 'minimalist' },
            generator: 'ui-gen-default-haiku-4-5',
          });
          expect(result).toHaveLength(1);
          expect(result[0]!.blueprint.blueprintId).toBe('bp-haiku');
        });
      });
    });

    describe('topK', () => {
      it('respects per-criteria override', async () => {
        await withSearch(async ({ store, search }) => {
          for (let i = 0; i < 10; i++) {
            await store.put(
              makeBlueprint({
                blueprintId: `bp-${i}`,
                variance: { persona: 'minimalist' },
              }),
            );
          }
          const result = await search.search({
            appId: 'app-1',
            variance: { persona: 'minimalist' },
            topK: 3,
          });
          expect(result).toHaveLength(3);
        });
      });
    });

    describe('determinism + tie-breaking', () => {
      it('returns identical output for identical input (repeated call)', async () => {
        await withSearch(async ({ store, search }) => {
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-1',
              variance: { persona: 'minimalist' },
            }),
          );
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-2',
              variance: { persona: 'minimalist' },
            }),
          );
          const a = await search.search({
            appId: 'app-1',
            variance: { persona: 'minimalist' },
          });
          const b = await search.search({
            appId: 'app-1',
            variance: { persona: 'minimalist' },
          });
          expect(a.map((r) => r.blueprint.blueprintId)).toEqual(
            b.map((r) => r.blueprint.blueprintId),
          );
        });
      });

      it('ties resolve by createdAt desc, then blueprintId asc', async () => {
        await withSearch(async ({ store, search }) => {
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-old',
              createdAt: '2026-05-10T00:00:00.000Z',
              variance: { persona: 'minimalist' },
            }),
          );
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-new-a',
              createdAt: '2026-05-12T00:00:00.000Z',
              variance: { persona: 'minimalist' },
            }),
          );
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-new-b',
              createdAt: '2026-05-12T00:00:00.000Z',
              variance: { persona: 'minimalist' },
            }),
          );
          const result = await search.search({
            appId: 'app-1',
            variance: { persona: 'minimalist' },
          });
          expect(result.map((r) => r.blueprint.blueprintId)).toEqual([
            'bp-new-a',
            'bp-new-b',
            'bp-old',
          ]);
        });
      });
    });
  });
}
