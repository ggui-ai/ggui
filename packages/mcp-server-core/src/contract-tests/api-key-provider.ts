/**
 * Contract test factory for {@link ApiKeyProvider} implementations.
 *
 * Normative semantics covered:
 *
 *   - `mint` returns `{record, secret}`; secret is non-empty and
 *     carries the `ggui_sk_` prefix.
 *   - `verify` hits the minted record; wrong secrets return null.
 *   - `verify` is constant-time — the test intentionally doesn't
 *     measure timing, but it asserts `timingSafeEqual`-compatible
 *     behavior at the structural level (different-length secrets
 *     do not throw).
 *   - `list` returns public records only — NEVER the secret.
 *   - `revoke` removes the key by id, idempotently.
 *   - Cross-app isolation: `list` on app A does not see app B's
 *     keys; `verify` still works regardless (global secret lookup).
 */
import { describe, expect, it } from 'vitest';
import type { ApiKeyProvider } from '../api-key-provider.js';

export function apiKeyProviderContract(
  label: string,
  makeProvider: () => Promise<ApiKeyProvider> | ApiKeyProvider,
): void {
  describe(`ApiKeyProvider contract — ${label}`, () => {
    it('mint returns a ggui_sk_ prefixed secret + public record', async () => {
      const provider = await makeProvider();
      const minted = await provider.mint({ appId: 'app-a' });
      expect(minted.secret).toMatch(/^ggui_sk_[a-f0-9]+$/);
      expect(minted.secret.length).toBeGreaterThan('ggui_sk_'.length + 16);
      expect(minted.record.appId).toBe('app-a');
      expect(typeof minted.record.id).toBe('string');
      expect(minted.record.id.length).toBeGreaterThan(0);
      expect(typeof minted.record.createdAt).toBe('number');
    });

    it('mint honors an optional label', async () => {
      const provider = await makeProvider();
      const minted = await provider.mint({ appId: 'app-a', label: 'laptop' });
      expect(minted.record.label).toBe('laptop');
    });

    it('verify returns the matching record for a valid secret', async () => {
      const provider = await makeProvider();
      const minted = await provider.mint({ appId: 'app-a', label: 'laptop' });
      const verified = await provider.verify(minted.secret);
      expect(verified?.id).toBe(minted.record.id);
      expect(verified?.appId).toBe('app-a');
      expect(verified?.label).toBe('laptop');
    });

    it('verify returns null for an unknown secret', async () => {
      const provider = await makeProvider();
      await provider.mint({ appId: 'app-a' });
      await expect(provider.verify('ggui_sk_not-a-real-key')).resolves.toBeNull();
    });

    it('verify returns null for secrets missing the ggui_sk_ prefix', async () => {
      const provider = await makeProvider();
      await expect(provider.verify('sk-ant-something')).resolves.toBeNull();
      await expect(provider.verify('')).resolves.toBeNull();
    });

    it('verify returns null for unusually long / short secrets without throwing', async () => {
      const provider = await makeProvider();
      await provider.mint({ appId: 'app-a' });
      await expect(provider.verify('ggui_sk_x')).resolves.toBeNull();
      await expect(
        provider.verify(`ggui_sk_${'x'.repeat(1024)}`),
      ).resolves.toBeNull();
    });

    it('list returns public records only — NEVER the secret', async () => {
      const provider = await makeProvider();
      const minted = await provider.mint({ appId: 'app-a', label: 'laptop' });
      const list = await provider.list('app-a');
      expect(list.length).toBe(1);
      const recordJson = JSON.stringify(list);
      // The plaintext secret MUST NOT appear anywhere in the
      // serialised list output.
      expect(recordJson).not.toContain(minted.secret);
      // Neither should the random tail (the part after the prefix).
      const tail = minted.secret.slice('ggui_sk_'.length);
      expect(recordJson).not.toContain(tail);
    });

    it('list isolates across apps', async () => {
      const provider = await makeProvider();
      const mintedA = await provider.mint({ appId: 'app-a' });
      const mintedB = await provider.mint({ appId: 'app-b' });
      const listA = await provider.list('app-a');
      const listB = await provider.list('app-b');
      expect(listA.map((k) => k.id)).toEqual([mintedA.record.id]);
      expect(listB.map((k) => k.id)).toEqual([mintedB.record.id]);
    });

    it('revoke removes the key and subsequent verify returns null', async () => {
      const provider = await makeProvider();
      const minted = await provider.mint({ appId: 'app-a' });
      await provider.revoke(minted.record.id);
      await expect(provider.verify(minted.secret)).resolves.toBeNull();
      await expect(provider.list('app-a')).resolves.toEqual([]);
    });

    it('revoke is idempotent', async () => {
      const provider = await makeProvider();
      await expect(provider.revoke('nope')).resolves.toBeUndefined();
      await expect(provider.revoke('nope')).resolves.toBeUndefined();
    });

    it('two mints produce distinct secrets and distinct ids', async () => {
      const provider = await makeProvider();
      const a = await provider.mint({ appId: 'app-a' });
      const b = await provider.mint({ appId: 'app-a' });
      expect(a.secret).not.toBe(b.secret);
      expect(a.record.id).not.toBe(b.record.id);
    });

    it('verify populates lastUsedAt on a hit', async () => {
      const provider = await makeProvider();
      const minted = await provider.mint({ appId: 'app-a' });
      expect(minted.record.lastUsedAt).toBeUndefined();
      await provider.verify(minted.secret);
      const [reread] = await provider.list('app-a');
      expect(typeof reread?.lastUsedAt).toBe('number');
    });
  });
}
