/**
 * Contract test factory for {@link ProviderKeyStore} implementations.
 *
 * Normative semantics covered:
 *
 *   - `get` missing → null; hit → plaintext `ProviderKeyRef`.
 *   - `set` overwrites; a subsequent `get` sees the new value.
 *   - `delete` is idempotent (removing missing → no throw).
 *   - `listProviders` returns provider names only — NEVER keys.
 *   - Cross-app isolation: app A cannot read app B's keys.
 *   - Cross-provider isolation: setting anthropic does not leak to
 *     openai for the same app.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderKeyStore } from '../provider-key-store.js';
import type { LlmProvider } from '../ui-generator.js';

export function providerKeyStoreContract(
  label: string,
  makeStore: () => Promise<ProviderKeyStore> | ProviderKeyStore,
): void {
  describe(`ProviderKeyStore contract — ${label}`, () => {
    it('get on a missing (appId, provider) returns null', async () => {
      const store = await makeStore();
      await expect(store.get('app-a', 'anthropic')).resolves.toBeNull();
    });

    it('set then get round-trips the plaintext key', async () => {
      const store = await makeStore();
      const ref = await store.set('app-a', 'anthropic', 'sk-ant-secret-A');
      expect(ref).toEqual({ provider: 'anthropic', key: 'sk-ant-secret-A' });
      const fetched = await store.get('app-a', 'anthropic');
      expect(fetched).toEqual({ provider: 'anthropic', key: 'sk-ant-secret-A' });
    });

    it('set overwrites a prior value for the same (appId, provider)', async () => {
      const store = await makeStore();
      await store.set('app-a', 'anthropic', 'old-key');
      await store.set('app-a', 'anthropic', 'new-key');
      const fetched = await store.get('app-a', 'anthropic');
      expect(fetched?.key).toBe('new-key');
    });

    it('isolates keys across apps', async () => {
      const store = await makeStore();
      await store.set('app-a', 'anthropic', 'key-for-A');
      await store.set('app-b', 'anthropic', 'key-for-B');
      const fromA = await store.get('app-a', 'anthropic');
      const fromB = await store.get('app-b', 'anthropic');
      expect(fromA?.key).toBe('key-for-A');
      expect(fromB?.key).toBe('key-for-B');
    });

    it('isolates providers within the same app', async () => {
      const store = await makeStore();
      await store.set('app-a', 'anthropic', 'anthropic-key');
      const fetchedOpenai = await store.get('app-a', 'openai');
      expect(fetchedOpenai).toBeNull();
      const fetchedAnthropic = await store.get('app-a', 'anthropic');
      expect(fetchedAnthropic?.key).toBe('anthropic-key');
    });

    it('delete removes the key', async () => {
      const store = await makeStore();
      await store.set('app-a', 'anthropic', 'key');
      await store.delete('app-a', 'anthropic');
      await expect(store.get('app-a', 'anthropic')).resolves.toBeNull();
    });

    it('delete is idempotent', async () => {
      const store = await makeStore();
      await expect(store.delete('nope', 'anthropic')).resolves.toBeUndefined();
      await expect(store.delete('nope', 'anthropic')).resolves.toBeUndefined();
    });

    it('listProviders returns provider names (no key material)', async () => {
      const store = await makeStore();
      await store.set('app-a', 'anthropic', 'key-anthropic');
      await store.set('app-a', 'openai', 'key-openai');
      await store.set('app-a', 'google', 'key-google');
      const providers = await store.listProviders('app-a');
      const sorted = [...providers].sort();
      expect(sorted).toEqual(['anthropic', 'google', 'openai']);
      // Guard: nothing in the returned array matches the stored keys.
      for (const p of providers) {
        const s = p as string;
        expect(s.includes('key-anthropic')).toBe(false);
        expect(s.includes('key-openai')).toBe(false);
        expect(s.includes('key-google')).toBe(false);
      }
    });

    it('listProviders on an app with no keys returns an empty array', async () => {
      const store = await makeStore();
      await expect(store.listProviders('nope')).resolves.toEqual([]);
    });

    it('listProviders reflects deletes', async () => {
      const store = await makeStore();
      await store.set('app-a', 'anthropic', 'key');
      await store.set('app-a', 'openai', 'key');
      await store.delete('app-a', 'anthropic');
      const providers = await store.listProviders('app-a');
      expect(providers).toEqual(['openai']);
    });

    it('supports the full LlmProvider enum round-trip', async () => {
      // Every value in the LlmProvider union must store + retrieve.
      // If a new provider lands and someone forgets to extend an
      // implementation, this test surfaces it.
      const store = await makeStore();
      const providers: LlmProvider[] = [
        'anthropic',
        'openai',
        'google',
        'bedrock',
        'openrouter',
      ];
      for (const p of providers) {
        await store.set('app-a', p, `key-${p}`);
      }
      for (const p of providers) {
        const ref = await store.get('app-a', p);
        expect(ref?.key).toBe(`key-${p}`);
      }
    });
  });
}
