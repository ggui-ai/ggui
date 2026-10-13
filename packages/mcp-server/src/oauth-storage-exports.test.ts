/**
 * ggui#1864 — the OAuth storage seam is public: a deployment can implement
 * `OAuthStorage` against the exported types and pass it to `createGguiServer`,
 * and the in-process reference implementation is exported to test against.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as entry from './index.js';
import type { AuthCodeRecord, ClientRecord, CreateGguiServerOptions, OAuthConfig, OAuthStorage } from './index.js';

/** A store written only against the package entry's types, as an outside implementation would be. */
class OutsideStorage implements OAuthStorage {
  private readonly codes = new Map<string, AuthCodeRecord>();
  private readonly clients = new Map<string, ClientRecord>();
  async putAuthCode(record: AuthCodeRecord): Promise<void> {
    this.codes.set(record.code, record);
  }
  async consumeAuthCode(code: string): Promise<AuthCodeRecord | null> {
    const record = this.codes.get(code) ?? null;
    this.codes.delete(code);
    return record;
  }
  async putClient(record: ClientRecord): Promise<void> {
    this.clients.set(record.clientId, record);
  }
  async getClient(clientId: string): Promise<ClientRecord | null> {
    return this.clients.get(clientId) ?? null;
  }
  async listClients(): Promise<readonly ClientRecord[]> {
    return [...this.clients.values()];
  }
  async deleteClient(clientId: string): Promise<void> {
    this.clients.delete(clientId);
  }
}

describe('OAuth storage seam exported from @ggui-ai/mcp-server (ggui#1864)', () => {
  it('a store typed against the entry is accepted as createGguiServer({ oauth: { storage } })', () => {
    const oauth: OAuthConfig = { storage: new OutsideStorage() };
    expectTypeOf(oauth).toMatchTypeOf<Exclude<NonNullable<CreateGguiServerOptions['oauth']>, boolean>>();
  });

  it('the reference implementation is exported and consumes an auth code exactly once', async () => {
    expect(typeof entry.InMemoryOAuthStorage).toBe('function');
    const store: OAuthStorage = new entry.InMemoryOAuthStorage();
    const record: AuthCodeRecord = { code: 'c1', accessToken: 't', codeChallenge: 'x', redirectUri: 'https://app.test/cb', clientId: 'k', expiresAt: Date.now() + 60_000 };
    await store.putAuthCode(record);
    expect(await store.consumeAuthCode('c1')).toEqual(record);
    expect(await store.consumeAuthCode('c1')).toBeNull();
  });
});
