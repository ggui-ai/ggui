/**
 * `BlueprintStore` cross-impl conformance suite.
 *
 * Portable battery every {@link BlueprintStore} implementation MUST
 * satisfy. Mirrors the `ggui-session-store.conformance` pattern: a factory
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
 *   - `contractHash` round-trips in its declared domain: the 16-char
 *     `blueprintKey(contract)` value, not some other contract digest.
 *   - the store indexes on the `contractHash` it was handed, never on
 *     a `blueprintKey` it recomputes from the row's `contract` copy
 *     (pinned with a deliberately mismatched pair — see that case).
 *
 * Implementations layer their own adapter-specific tests on top (e.g.
 * the DDB+S3 adapter additionally asserts the code body in S3 is
 * cleaned up on delete when no other row references the hash).
 */

import type { Blueprint, DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import { describe, expect, it } from 'vitest';
import {
  BlueprintAlreadyExistsError,
  BlueprintNotFoundError,
  type BlueprintStore,
} from '../blueprint-store.js';

/** Factory + optional cleanup. Mirrors `GguiSessionStoreConformanceFactory`. */
export interface BlueprintStoreConformanceFactory {
  /**
   * #457 — what the harness KNOWS this store to be; the suite grades
   * the store's own `durability` declaration against it.
   */
  readonly expectedDurability: 'durable' | 'ephemeral';
  readonly create: () => Promise<BlueprintStore>;
  readonly cleanup?: (store: BlueprintStore) => Promise<void> | void;
}

/**
 * Two contract shapes whose canonical forms differ, so
 * `blueprintKey` maps them to different keys. Used by the
 * `contractHash` domain pin below.
 */
const CONTRACT_A: DataContract = {
  propsSpec: {
    properties: {
      title: { schema: { type: 'string' }, required: true },
    },
  },
};

const CONTRACT_B: DataContract = {
  propsSpec: {
    properties: {
      total: { schema: { type: 'number' }, required: true },
    },
  },
};

/** Shape every value in the `contractHash` domain has: 16 lowercase hex. */
const BLUEPRINT_KEY_REGEX = /^[0-9a-f]{16}$/;

function makeBlueprint(overrides: Partial<Blueprint> & { blueprintId: string }): Blueprint {
  return {
    blueprintId: overrides.blueprintId,
    contractHash: overrides.contractHash ?? 'hash-1',
    appId: overrides.appId ?? 'app-1',
    codeS3Url: overrides.codeS3Url,
    codeHash: overrides.codeHash,
    source: overrides.source ?? {
      kind: 'llm',
      generator: 'ui-gen-default-haiku-4-5',
      model: 'claude-haiku-4-5',
    },
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
      it(`declares durability: the harness-known answer, graded not trusted (#457)`, async () => {
      await withStore(async (store) => {
        expect(store.durability).toBe(factory.expectedDurability);
      });
    });

    it('preserves every Blueprint field on insert, except the derived codeS3Url', async () => {
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

          // `codeS3Url` is excluded because the port permits an
          // implementation to recompute it from `codeHash` against its
          // own bucket rather than storing the caller's string — a row
          // outlives the bucket it was written against, so the content
          // address is the durable fact and the URL is one
          // deployment's rendering of it. Every other field is held to
          // exact round-trip.
          const { codeS3Url: _sentUrl, ...sentRest } = bp;
          const { codeS3Url: gotUrl, ...gotRest } = got ?? {};
          expect(gotRest).toEqual(sentRest);

          // What the carve-out does NOT license: losing the address,
          // or claiming a body that was never stored.
          expect(got?.codeHash).toBe('abcd');
          expect(gotUrl === undefined || typeof gotUrl === 'string').toBe(true);
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

      it('excludes rows from a different appId (app boundary)', async () => {
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

    // The `contractHash` parameter names a specific domain: the
    // 16-char `blueprintKey(contract)` value. Nothing in the type
    // system says so — `string` accepts any digest — so the domain is
    // pinned here, where every implementation runs it. A store that
    // truncates, re-cases, or re-hashes the key on the write path
    // fails the round-trip; a caller that starts passing some other
    // contract digest fails the shape assertion.
    describe('contractHash domain — 16-char blueprintKey', () => {
      it('blueprintKey yields 16 lowercase hex chars', () => {
        expect(blueprintKey(CONTRACT_A)).toMatch(BLUEPRINT_KEY_REGEX);
        expect(blueprintKey(CONTRACT_B)).toMatch(BLUEPRINT_KEY_REGEX);
      });

      it('distinct contract shapes yield distinct keys', () => {
        expect(blueprintKey(CONTRACT_A)).not.toBe(blueprintKey(CONTRACT_B));
      });

      it('round-trips a real blueprintKey through put + get + list', async () => {
        await withStore(async (store) => {
          const key = blueprintKey(CONTRACT_A);
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-key-a',
              contractHash: key,
              contract: CONTRACT_A,
            }),
          );

          const got = await store.get('bp-key-a');
          expect(got?.contractHash).toBe(key);
          expect(got?.contractHash).toMatch(BLUEPRINT_KEY_REGEX);

          const listed = await store.list('app-1', key);
          expect(listed.map((b) => b.blueprintId)).toEqual(['bp-key-a']);
        });
      });

      it('keeps rows under distinct keys in distinct groups', async () => {
        await withStore(async (store) => {
          const keyA = blueprintKey(CONTRACT_A);
          const keyB = blueprintKey(CONTRACT_B);
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-key-a',
              contractHash: keyA,
              contract: CONTRACT_A,
            }),
          );
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-key-b',
              contractHash: keyB,
              contract: CONTRACT_B,
            }),
          );

          expect((await store.list('app-1', keyA)).map((b) => b.blueprintId)).toEqual(
            ['bp-key-a'],
          );
          expect((await store.list('app-1', keyB)).map((b) => b.blueprintId)).toEqual(
            ['bp-key-b'],
          );
        });
      });

      it('indexes the row by its stored contractHash, never by a re-derivation from its contract', async () => {
        await withStore(async (store) => {
          const keyA = blueprintKey(CONTRACT_A);
          const keyB = blueprintKey(CONTRACT_B);

          // The mismatch is deliberate, and it is the only shape that
          // catches the bug: a row whose stored `contract` is A but
          // whose `contractHash` says B. Every consistent fixture
          // passes for a store that ignores the field and recomputes
          // `blueprintKey(row.contract)` on the write path — the two
          // values agree, so both routes land on the same group. Here
          // they disagree, so a recomputing store files this row under
          // keyA and both assertions below flip.
          await store.put(
            makeBlueprint({
              blueprintId: 'bp-mismatched',
              contractHash: keyB,
              contract: CONTRACT_A,
            }),
          );

          expect(
            (await store.list('app-1', keyB)).map((b) => b.blueprintId),
          ).toEqual(['bp-mismatched']);
          expect(await store.list('app-1', keyA)).toEqual([]);
        });
      });
    });
  });
}
