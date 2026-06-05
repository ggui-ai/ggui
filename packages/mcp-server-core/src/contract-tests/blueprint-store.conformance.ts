/**
 * `BlueprintStore` cross-impl conformance suite.
 *
 * Portable battery every {@link BlueprintStore} implementation MUST
 * satisfy. Mirrors the `render-store.conformance` pattern: a factory
 * supplies a fresh store + optional teardown hook; concrete impls plug
 * in their own runner test.
 *
 * Covered surface:
 *
 *   - put / get round-trip preserves every field of {@link Blueprint}.
 *   - put twice with same id throws {@link BlueprintAlreadyExistsError}.
 *   - list returns rows scoped to `(appId, contractHash)`.
 *   - list does NOT cross-leak between apps that share a contractHash.
 *   - setOperatorDefault sets the flag AND clears the flag on any
 *     prior default for the same `(appId, contractHash)` group.
 *   - setOperatorDefault on unknown id throws BlueprintNotFoundError.
 *   - setOperatorDefault is idempotent: same target twice = same state.
 *   - delete removes the row + is idempotent on second delete.
 *   - delete clears the row from list output.
 *
 * Implementations layer their own adapter-specific tests on top (e.g.
 * the DDB+S3 adapter additionally asserts the code body in S3 is
 * cleaned up on delete when no other row references the hash).
 */

import type { Blueprint } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';
import {
  BlueprintAlreadyExistsError,
  BlueprintNotFoundError,
  type BlueprintStore,
} from '../blueprint-store.js';

/** Factory + optional cleanup. Mirrors `GguiSessionStoreConformanceFactory`. */
export interface BlueprintStoreConformanceFactory {
  readonly create: () => Promise<BlueprintStore>;
  readonly cleanup?: (store: BlueprintStore) => Promise<void> | void;
}

function makeBlueprint(overrides: Partial<Blueprint> & { blueprintId: string }): Blueprint {
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
  };
}

/**
 * Run the conformance suite under a descriptive label.
 * Call inside a `describe(...)` block in the concrete impl's runner.
 */
export function runBlueprintStoreConformance(
  label: string,
  factory: BlueprintStoreConformanceFactory,
): void {
  async function withStore<T>(
    fn: (store: BlueprintStore) => Promise<T>,
  ): Promise<T> {
    const store = await factory.create();
    try {
      return await fn(store);
    } finally {
      if (factory.cleanup) await factory.cleanup(store);
    }
  }

  describe(`${label} — conformance`, () => {
    describe('put + get round-trip', () => {
      it('preserves every Blueprint field on insert', async () => {
        await withStore(async (store) => {
          const bp = makeBlueprint({
            blueprintId: 'bp-1',
            codeS3Url: 's3://bucket/blueprints/code/abcd',
            codeHash: 'abcd',
            validatorScore: 0.92,
            variance: {
              persona: 'minimalist',
              seedPrompt: 'make it sparse',
            },
            createdBy: 'operator',
          });
          await store.put(bp);
          const got = await store.get('bp-1');
          expect(got).not.toBeNull();
          expect(got).toEqual(bp);
        });
      });

      it('returns null for unknown id', async () => {
        await withStore(async (store) => {
          expect(await store.get('bp-missing')).toBeNull();
        });
      });

      it('throws BlueprintAlreadyExistsError on duplicate id', async () => {
        await withStore(async (store) => {
          await store.put(makeBlueprint({ blueprintId: 'bp-1' }));
          await expect(
            store.put(makeBlueprint({ blueprintId: 'bp-1' })),
          ).rejects.toBeInstanceOf(BlueprintAlreadyExistsError);
        });
      });
    });

    describe('list scope by (appId, contractHash)', () => {
      it('returns empty array when no rows match', async () => {
        await withStore(async (store) => {
          expect(await store.list('app-1', 'hash-1')).toEqual([]);
        });
      });

      it('returns every row in the matching group', async () => {
        await withStore(async (store) => {
          await store.put(makeBlueprint({ blueprintId: 'bp-1' }));
          await store.put(makeBlueprint({ blueprintId: 'bp-2' }));
          const got = await store.list('app-1', 'hash-1');
          expect(got).toHaveLength(2);
          expect(new Set(got.map((b) => b.blueprintId))).toEqual(
            new Set(['bp-1', 'bp-2']),
          );
        });
      });

      it('excludes rows from a different appId (tenancy boundary)', async () => {
        await withStore(async (store) => {
          await store.put(
            makeBlueprint({ blueprintId: 'bp-app1', appId: 'app-1' }),
          );
          await store.put(
            makeBlueprint({ blueprintId: 'bp-app2', appId: 'app-2' }),
          );
          const got1 = await store.list('app-1', 'hash-1');
          expect(got1.map((b) => b.blueprintId)).toEqual(['bp-app1']);
          const got2 = await store.list('app-2', 'hash-1');
          expect(got2.map((b) => b.blueprintId)).toEqual(['bp-app2']);
        });
      });

      it('excludes rows from a different contractHash', async () => {
        await withStore(async (store) => {
          await store.put(
            makeBlueprint({ blueprintId: 'bp-h1', contractHash: 'hash-1' }),
          );
          await store.put(
            makeBlueprint({ blueprintId: 'bp-h2', contractHash: 'hash-2' }),
          );
          const got = await store.list('app-1', 'hash-1');
          expect(got.map((b) => b.blueprintId)).toEqual(['bp-h1']);
        });
      });
    });

    describe('setOperatorDefault', () => {
      it('sets the flag on the target row', async () => {
        await withStore(async (store) => {
          await store.put(makeBlueprint({ blueprintId: 'bp-1' }));
          await store.setOperatorDefault('bp-1');
          const got = await store.get('bp-1');
          expect(got?.isOperatorDefault).toBe(true);
        });
      });

      it('clears the flag on a prior default in the same group', async () => {
        await withStore(async (store) => {
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-old',
              isOperatorDefault: true,
            }),
          );
          await store.put(makeBlueprint({ blueprintId: 'bp-new' }));
          await store.setOperatorDefault('bp-new');
          const old = await store.get('bp-old');
          const fresh = await store.get('bp-new');
          expect(old?.isOperatorDefault).toBeUndefined();
          expect(fresh?.isOperatorDefault).toBe(true);
        });
      });

      it('does NOT touch defaults in other groups', async () => {
        await withStore(async (store) => {
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-other-app',
              appId: 'app-2',
              isOperatorDefault: true,
            }),
          );
          await store.put(makeBlueprint({ blueprintId: 'bp-target' }));
          await store.setOperatorDefault('bp-target');
          const other = await store.get('bp-other-app');
          expect(other?.isOperatorDefault).toBe(true);
        });
      });

      it('is idempotent on the same target', async () => {
        await withStore(async (store) => {
          await store.put(makeBlueprint({ blueprintId: 'bp-1' }));
          await store.setOperatorDefault('bp-1');
          await store.setOperatorDefault('bp-1');
          const got = await store.get('bp-1');
          expect(got?.isOperatorDefault).toBe(true);
        });
      });

      it('throws BlueprintNotFoundError on unknown id', async () => {
        await withStore(async (store) => {
          await expect(
            store.setOperatorDefault('bp-missing'),
          ).rejects.toBeInstanceOf(BlueprintNotFoundError);
        });
      });
    });

    describe('delete', () => {
      it('removes the row from get + list', async () => {
        await withStore(async (store) => {
          await store.put(makeBlueprint({ blueprintId: 'bp-1' }));
          await store.delete('bp-1');
          expect(await store.get('bp-1')).toBeNull();
          expect(await store.list('app-1', 'hash-1')).toEqual([]);
        });
      });

      it('is idempotent on the second call', async () => {
        await withStore(async (store) => {
          await store.put(makeBlueprint({ blueprintId: 'bp-1' }));
          await store.delete('bp-1');
          await expect(store.delete('bp-1')).resolves.toBeUndefined();
        });
      });

      it('is a no-op on unknown id', async () => {
        await withStore(async (store) => {
          await expect(store.delete('bp-missing')).resolves.toBeUndefined();
        });
      });
    });
  });
}
