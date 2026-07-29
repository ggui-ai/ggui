/**
 * Unit coverage for the provider-key handler family, focused on the
 * two-scope contract of set/remove: account scope (default) vs the
 * optional app scope behind the `AppScopedProviderKeyStore` seam.
 */
import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createRemoveProviderKeyHandler } from './remove-provider-key.js';
import { createSetProviderKeyHandler } from './set-provider-key.js';
import type {
  AppScopedProviderKeyStore,
  ProviderKeyStore,
  ProviderKeySummary,
  ProviderName,
  RemoveResult,
  SetProviderKeyInput,
} from './types.js';
import {
  AppScopedKeyAppNotFoundError,
  AppScopedKeysUnavailableError,
} from './types.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

/** Account-scope fake keyed on (userId, provider). */
class InMemoryProviderKeyStore implements ProviderKeyStore {
  readonly rows = new Map<string, ProviderKeySummary>();

  private key(userId: string, provider: ProviderName): string {
    return `${userId}::${provider}`;
  }

  async list(userId: string): Promise<readonly ProviderKeySummary[]> {
    return [...this.rows.entries()]
      .filter(([k]) => k.startsWith(`${userId}::`))
      .map(([, v]) => v);
  }

  async set(input: SetProviderKeyInput): Promise<ProviderKeySummary> {
    const summary: ProviderKeySummary = {
      provider: input.provider,
      lastFour: input.plaintextKey.slice(-4),
      ...(input.label !== undefined ? { label: input.label } : {}),
      createdAt: new Date(1).toISOString(),
    };
    this.rows.set(this.key(input.userId, input.provider), summary);
    return summary;
  }

  async remove(args: {
    userId: string;
    provider: ProviderName;
  }): Promise<RemoveResult> {
    const deleted = this.rows.delete(this.key(args.userId, args.provider));
    return { deleted, provider: args.provider };
  }
}

/**
 * App-scope fake honoring the seam invariant: verify ownership FIRST,
 * uniform `app_not_found` for missing/foreign apps.
 */
class InMemoryAppScopedStore implements AppScopedProviderKeyStore {
  readonly rows = new Map<string, ProviderKeySummary>();

  constructor(private readonly appOwners: Record<string, string>) {}

  private assertOwnership(appId: string, ownerSub: string): void {
    if (this.appOwners[appId] !== ownerSub) {
      throw new AppScopedKeyAppNotFoundError(appId);
    }
  }

  private key(appId: string, provider: ProviderName): string {
    return `${appId}::${provider}`;
  }

  async set(input: {
    ownerSub: string;
    appId: string;
    provider: ProviderName;
    plaintextKey: string;
    label?: string;
  }): Promise<ProviderKeySummary> {
    this.assertOwnership(input.appId, input.ownerSub);
    const summary: ProviderKeySummary = {
      provider: input.provider,
      lastFour: input.plaintextKey.slice(-4),
      ...(input.label !== undefined ? { label: input.label } : {}),
      createdAt: new Date(1).toISOString(),
    };
    this.rows.set(this.key(input.appId, input.provider), summary);
    return summary;
  }

  async remove(args: {
    ownerSub: string;
    appId: string;
    provider: ProviderName;
  }): Promise<RemoveResult> {
    this.assertOwnership(args.appId, args.ownerSub);
    const deleted = this.rows.delete(this.key(args.appId, args.provider));
    return { deleted, provider: args.provider };
  }
}

describe('set_provider_key — account scope (no appId)', () => {
  it('writes through the account store and never echoes plaintext', async () => {
    const store = new InMemoryProviderKeyStore();
    const handler = createSetProviderKeyHandler({ store });
    const result = await handler.handler(
      { provider: 'anthropic', plaintextKey: 'sk-ant-secret-1234' },
      makeCtx(),
    );
    expect(result.lastFour).toBe('1234');
    expect(JSON.stringify(result)).not.toContain('sk-ant-secret');
    expect(store.rows.size).toBe(1);
  });
});

describe('set_provider_key — app scope', () => {
  it('routes through the app-scoped store when appId is present', async () => {
    const store = new InMemoryProviderKeyStore();
    const appScopedStore = new InMemoryAppScopedStore({ app_1: 'user-1' });
    const handler = createSetProviderKeyHandler({ store, appScopedStore });
    const result = await handler.handler(
      {
        provider: 'openai',
        plaintextKey: 'sk-oai-secret-5678',
        appId: 'app_1',
        label: 'per-app',
      },
      makeCtx(),
    );
    expect(result.lastFour).toBe('5678');
    expect(result.label).toBe('per-app');
    expect(appScopedStore.rows.size).toBe(1);
    // Account store untouched — the two scopes are separate rows.
    expect(store.rows.size).toBe(0);
  });

  it('rejects appId with a typed error when no app-scoped store is bound', async () => {
    const handler = createSetProviderKeyHandler({
      store: new InMemoryProviderKeyStore(),
    });
    await expect(
      handler.handler(
        { provider: 'openai', plaintextKey: 'sk-x', appId: 'app_1' },
        makeCtx(),
      ),
    ).rejects.toBeInstanceOf(AppScopedKeysUnavailableError);
  });

  it('cross-tenant appId answers the uniform app_not_found', async () => {
    const appScopedStore = new InMemoryAppScopedStore({ app_1: 'user-2' });
    const handler = createSetProviderKeyHandler({
      store: new InMemoryProviderKeyStore(),
      appScopedStore,
    });
    await expect(
      handler.handler(
        { provider: 'openai', plaintextKey: 'sk-x', appId: 'app_1' },
        makeCtx({ userId: 'user-1' }),
      ),
    ).rejects.toBeInstanceOf(AppScopedKeyAppNotFoundError);
    expect(appScopedStore.rows.size).toBe(0);
  });

  it('missing appId answers the SAME error class as a foreign one', async () => {
    const handler = createSetProviderKeyHandler({
      store: new InMemoryProviderKeyStore(),
      appScopedStore: new InMemoryAppScopedStore({}),
    });
    await expect(
      handler.handler(
        { provider: 'openai', plaintextKey: 'sk-x', appId: 'app_nope' },
        makeCtx(),
      ),
    ).rejects.toBeInstanceOf(AppScopedKeyAppNotFoundError);
  });
});

describe('remove_provider_key — account scope (no appId)', () => {
  it('removes through the account store, idempotently', async () => {
    const store = new InMemoryProviderKeyStore();
    await store.set({
      userId: 'user-1',
      provider: 'google',
      plaintextKey: 'g-key-0001',
    });
    const handler = createRemoveProviderKeyHandler({ store });
    const first = await handler.handler({ provider: 'google' }, makeCtx());
    expect(first.deleted).toBe(true);
    const second = await handler.handler({ provider: 'google' }, makeCtx());
    expect(second.deleted).toBe(false);
  });
});

describe('remove_provider_key — app scope', () => {
  it('routes through the app-scoped store when appId is present', async () => {
    const store = new InMemoryProviderKeyStore();
    const appScopedStore = new InMemoryAppScopedStore({ app_1: 'user-1' });
    await appScopedStore.set({
      ownerSub: 'user-1',
      appId: 'app_1',
      provider: 'openrouter',
      plaintextKey: 'or-key-0001',
    });
    const handler = createRemoveProviderKeyHandler({ store, appScopedStore });
    const result = await handler.handler(
      { provider: 'openrouter', appId: 'app_1' },
      makeCtx(),
    );
    expect(result.deleted).toBe(true);
    expect(appScopedStore.rows.size).toBe(0);
  });

  it('rejects appId with a typed error when no app-scoped store is bound', async () => {
    const handler = createRemoveProviderKeyHandler({
      store: new InMemoryProviderKeyStore(),
    });
    await expect(
      handler.handler({ provider: 'openai', appId: 'app_1' }, makeCtx()),
    ).rejects.toBeInstanceOf(AppScopedKeysUnavailableError);
  });

  it('cross-tenant appId answers the uniform app_not_found', async () => {
    const appScopedStore = new InMemoryAppScopedStore({ app_1: 'user-2' });
    await appScopedStore.set({
      ownerSub: 'user-2',
      appId: 'app_1',
      provider: 'openai',
      plaintextKey: 'sk-oai-theirs',
    });
    const handler = createRemoveProviderKeyHandler({
      store: new InMemoryProviderKeyStore(),
      appScopedStore,
    });
    await expect(
      handler.handler(
        { provider: 'openai', appId: 'app_1' },
        makeCtx({ userId: 'user-1' }),
      ),
    ).rejects.toBeInstanceOf(AppScopedKeyAppNotFoundError);
    // Foreign row untouched.
    expect(appScopedStore.rows.size).toBe(1);
  });
});
