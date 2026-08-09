/**
 * `CodeStore` cross-impl conformance suite.
 *
 * Portable battery every {@link CodeStore} implementation that REMOVES
 * content MUST satisfy. Mirrors the `blueprint-store.conformance`
 * pattern: a factory supplies a fresh store + optional teardown hook;
 * concrete impls plug in their own runner test.
 *
 * Covered surface — exactly the port's stated obligations:
 *
 *   - put / get round-trip preserves bytes exactly (including UTF-8).
 *   - put is idempotent — the same `(hash, code)` pair twice is a no-op.
 *   - get on a hash that was never stored returns `null`, never throws.
 *   - distinct codes occupy distinct entries.
 *   - `hashOf` is deterministic, is 64-char lowercase hex, and agrees
 *     with {@link sha256Hex} — cross-impl writes MUST land on the same
 *     key, so this one is not merely a local-consistency check.
 *   - delete removes the bundle, is idempotent, resolves for a hash
 *     that was never stored, and leaves every sibling hash intact.
 *   - a bundle can be re-put after deletion.
 *
 * ## Why there is no `removesContent` option
 *
 * The port permits `delete` to be a no-op for deployments that never
 * remove content, so a suite covering those too would need an option
 * gating the delete-then-get assertions. No such implementation exists
 * — all three reference impls remove. Adding the option now would ship
 * a branch nothing exercises and no test can reach, which is how a
 * conformance suite quietly stops describing reality. Add it in the
 * same change that adds the first non-removing store, where its false
 * branch has an exerciser.
 *
 * Deliberately NOT covered, because the port does not require it:
 * rejecting malformed hashes on `put`. Implementations that derive a
 * storage path from the hash MUST narrow it (and their own suites
 * assert that), but the port explicitly allows an impl to accept
 * shorter prefixes when safe path encoding is guaranteed.
 */

import { describe, expect, it } from 'vitest';
import { CODE_HASH_REGEX, sha256Hex, type CodeStore } from '../code-store.js';

/** Factory + optional cleanup. Mirrors `BlueprintStoreConformanceFactory`. */
export interface CodeStoreConformanceFactory {
  readonly create: () => Promise<CodeStore>;
  readonly cleanup?: (store: CodeStore) => Promise<void> | void;
}

const SAMPLE = 'export default function Card(){return null;}';
const OTHER = 'export default function List(){return null;}';
const UNICODE = 'const greeting = "Привет 你好 🚀";';

/**
 * Run the conformance suite under a descriptive label.
 * Call inside a `describe(...)` block in the concrete impl's runner.
 */
export function runCodeStoreConformance(
  label: string,
  factory: CodeStoreConformanceFactory,
): void {
  async function withStore<T>(fn: (store: CodeStore) => Promise<T>): Promise<T> {
    const store = await factory.create();
    try {
      return await fn(store);
    } finally {
      if (factory.cleanup) await factory.cleanup(store);
    }
  }

  describe(`${label} — conformance`, () => {
    describe('hashOf', () => {
      it('is deterministic and agrees with sha256Hex', async () => {
        await withStore(async (store) => {
          expect(store.hashOf(SAMPLE)).toBe(sha256Hex(SAMPLE));
          expect(store.hashOf(SAMPLE)).toBe(store.hashOf(SAMPLE));
        });
      });

      it('produces 64-char lowercase hex', async () => {
        await withStore(async (store) => {
          expect(store.hashOf(SAMPLE)).toMatch(CODE_HASH_REGEX);
        });
      });

      it('changes when the code changes', async () => {
        await withStore(async (store) => {
          expect(store.hashOf(SAMPLE)).not.toBe(store.hashOf(OTHER));
        });
      });
    });

    describe('put + get', () => {
      it('returns null for a hash that was never stored', async () => {
        await withStore(async (store) => {
          expect(await store.get(sha256Hex(SAMPLE))).toBeNull();
        });
      });

      it('round-trips bytes exactly', async () => {
        await withStore(async (store) => {
          const hash = store.hashOf(SAMPLE);
          await store.put(hash, SAMPLE);
          expect(await store.get(hash)).toBe(SAMPLE);
        });
      });

      it('preserves UTF-8 exactly', async () => {
        await withStore(async (store) => {
          const hash = store.hashOf(UNICODE);
          await store.put(hash, UNICODE);
          expect(await store.get(hash)).toBe(UNICODE);
        });
      });

      it('is idempotent — the same pair twice is a no-op', async () => {
        await withStore(async (store) => {
          const hash = store.hashOf(SAMPLE);
          await store.put(hash, SAMPLE);
          await store.put(hash, SAMPLE);
          expect(await store.get(hash)).toBe(SAMPLE);
        });
      });

      it('keeps distinct codes in distinct entries', async () => {
        await withStore(async (store) => {
          await store.put(store.hashOf(SAMPLE), SAMPLE);
          await store.put(store.hashOf(OTHER), OTHER);
          expect(await store.get(store.hashOf(SAMPLE))).toBe(SAMPLE);
          expect(await store.get(store.hashOf(OTHER))).toBe(OTHER);
        });
      });
    });

    describe('delete', () => {
      it('removes the bundle — get returns null afterwards', async () => {
        await withStore(async (store) => {
          const hash = store.hashOf(SAMPLE);
          await store.put(hash, SAMPLE);
          await store.delete(hash);
          expect(await store.get(hash)).toBeNull();
        });
      });

      it('is idempotent — a second delete of the same hash resolves', async () => {
        await withStore(async (store) => {
          const hash = store.hashOf(SAMPLE);
          await store.put(hash, SAMPLE);
          await store.delete(hash);
          await expect(store.delete(hash)).resolves.toBeUndefined();
        });
      });

      it('resolves for a hash that was never stored', async () => {
        await withStore(async (store) => {
          await expect(
            store.delete(store.hashOf(SAMPLE)),
          ).resolves.toBeUndefined();
        });
      });

      it('leaves sibling bundles intact', async () => {
        await withStore(async (store) => {
          await store.put(store.hashOf(SAMPLE), SAMPLE);
          await store.put(store.hashOf(OTHER), OTHER);
          await store.delete(store.hashOf(SAMPLE));
          expect(await store.get(store.hashOf(OTHER))).toBe(OTHER);
        });
      });

      it('allows the bundle to be re-put afterwards', async () => {
        await withStore(async (store) => {
          const hash = store.hashOf(SAMPLE);
          await store.put(hash, SAMPLE);
          await store.delete(hash);
          await store.put(hash, SAMPLE);
          expect(await store.get(hash)).toBe(SAMPLE);
        });
      });
    });
  });
}
