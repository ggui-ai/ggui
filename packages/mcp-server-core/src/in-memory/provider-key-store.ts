/**
 * InMemoryProviderKeyStore — reference {@link ProviderKeyStore}
 * implementation. Ephemeral; tests + dev only.
 *
 * Keyed by `${appId}::${provider}` internally so the same (appId,
 * provider) pair always collides. Key material is stored as
 * plaintext — callers concerned about leaks use the on-disk
 * adapter (`plaintext/`) or a production binding.
 */
import type {
  LlmProvider,
  ProviderKeyRef,
} from '../ui-generator.js';
import type { ProviderKeyStore } from '../provider-key-store.js';

export class InMemoryProviderKeyStore implements ProviderKeyStore {
  private readonly keys = new Map<string, string>();

  async get(
    appId: string,
    provider: LlmProvider,
  ): Promise<ProviderKeyRef | null> {
    const key = this.keys.get(compositeKey(appId, provider));
    if (key === undefined) return null;
    return { provider, key };
  }

  async set(
    appId: string,
    provider: LlmProvider,
    key: string,
  ): Promise<ProviderKeyRef> {
    this.keys.set(compositeKey(appId, provider), key);
    return { provider, key };
  }

  async delete(appId: string, provider: LlmProvider): Promise<void> {
    this.keys.delete(compositeKey(appId, provider));
  }

  async listProviders(appId: string): Promise<LlmProvider[]> {
    const out: LlmProvider[] = [];
    const prefix = `${appId}::`;
    for (const k of this.keys.keys()) {
      if (k.startsWith(prefix)) {
        out.push(k.slice(prefix.length) as LlmProvider);
      }
    }
    out.sort();
    return out;
  }
}

function compositeKey(appId: string, provider: LlmProvider): string {
  return `${appId}::${provider}`;
}
