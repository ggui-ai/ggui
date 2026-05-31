/**
 * Contract test factory for {@link BlueprintIndex} implementations.
 *
 * Pass a factory that produces a fresh index per test. The suite
 * registers a `describe` block covering the normative semantics
 * declared on the interface:
 *
 *   - `getId` returns `null` for an unbound `(scope, exactKey)`.
 *   - `putId` → `getId` roundtrips the bound UUID.
 *   - `putId` is **first-write-wins** — a second write of the same
 *     `(scope, exactKey)` MUST keep the FIRST uuid. This is the dedup
 *     primitive; an overwrite is a contract violation.
 *   - Scope isolation — the same `exactKey` in two scopes is independent.
 *   - `deleteId` on a missing binding is a no-op.
 *   - `deleteId` followed by `getId` returns `null`.
 *
 * Usage (vitest):
 * ```ts
 * import { runBlueprintIndexConformance } from '@ggui-ai/mcp-server-core/contract-tests';
 * import { MyBlueprintIndex } from './my-blueprint-index';
 * runBlueprintIndexConformance('MyBlueprintIndex', () => new MyBlueprintIndex());
 * ```
 *
 * The factory runs its own `describe`; callers don't need to wrap.
 * Adapter authors: add this one line to your test suite and you have
 * conformance coverage. Any breakage is a real regression, not a
 * contract-surprise.
 */
import { describe, expect, it } from 'vitest';
import type { BlueprintIndex } from '../blueprint-index.js';

export type BlueprintIndexConformanceFactory = () =>
  | Promise<BlueprintIndex>
  | BlueprintIndex;

export function runBlueprintIndexConformance(
  label: string,
  makeIndex: BlueprintIndexConformanceFactory,
): void {
  describe(`BlueprintIndex contract — ${label}`, () => {
    it('getId returns null when the (scope, exactKey) is unbound', async () => {
      const ix = await makeIndex();
      await expect(ix.getId('app-a', 'never-bound')).resolves.toBeNull();
    });

    it('putId followed by getId roundtrips the bound UUID', async () => {
      const ix = await makeIndex();
      await ix.putId('app-a', 'k1', 'uuid-1');
      await expect(ix.getId('app-a', 'k1')).resolves.toBe('uuid-1');
    });

    it('putId is first-write-wins — a second write keeps the FIRST uuid (dedup primitive)', async () => {
      const ix = await makeIndex();
      await ix.putId('app-a', 'k1', 'uuid-first');
      // Second write of the SAME (scope, exactKey) MUST NOT overwrite.
      await ix.putId('app-a', 'k1', 'uuid-second');
      await expect(ix.getId('app-a', 'k1')).resolves.toBe('uuid-first');
    });

    it('scopes are independent — same exactKey in two scopes binds separately', async () => {
      const ix = await makeIndex();
      await ix.putId('app-a', 'shared', 'uuid-a');
      await ix.putId('app-b', 'shared', 'uuid-b');
      await expect(ix.getId('app-a', 'shared')).resolves.toBe('uuid-a');
      await expect(ix.getId('app-b', 'shared')).resolves.toBe('uuid-b');
    });

    it('deleteId on a missing binding is a no-op', async () => {
      const ix = await makeIndex();
      await expect(
        ix.deleteId('app-a', 'never-bound'),
      ).resolves.toBeUndefined();
    });

    it('deleteId then getId returns null', async () => {
      const ix = await makeIndex();
      await ix.putId('app-a', 'k1', 'uuid-1');
      await ix.deleteId('app-a', 'k1');
      await expect(ix.getId('app-a', 'k1')).resolves.toBeNull();
    });

    it('deleteId removes only the specified (scope, exactKey)', async () => {
      const ix = await makeIndex();
      await ix.putId('app-a', 'k1', 'uuid-1');
      await ix.putId('app-a', 'k2', 'uuid-2');
      await ix.deleteId('app-a', 'k1');
      await expect(ix.getId('app-a', 'k1')).resolves.toBeNull();
      await expect(ix.getId('app-a', 'k2')).resolves.toBe('uuid-2');
    });

    it('after deleteId a fresh putId may bind a new uuid (delete clears first-write-wins)', async () => {
      const ix = await makeIndex();
      await ix.putId('app-a', 'k1', 'uuid-first');
      await ix.deleteId('app-a', 'k1');
      await ix.putId('app-a', 'k1', 'uuid-second');
      await expect(ix.getId('app-a', 'k1')).resolves.toBe('uuid-second');
    });
  });
}
