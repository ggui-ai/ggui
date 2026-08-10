/**
 * `deleteAuthorKey` op tests.
 */
import { describe, expect, it } from 'vitest';
import { deleteAuthorKey } from './delete-author-key.js';
import { inMemoryRegistryStorage } from '../impls/memory-registry-storage.js';
import type { RegistryStorage } from '../interfaces/registry-storage.js';

const AUTHN = { subject: 'sub-alice' };

describe('deleteAuthorKey', () => {
  it('removes an existing key and reports deleted: true', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putAuthorKey({
      subject: 'sub-alice',
      keyId: 'k-1',
      publicKeyBase64: 'AAAA',
    });
    const result = await deleteAuthorKey({ keyId: 'k-1' }, { storage, authn: AUTHN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ keyId: 'k-1', deleted: true });
    expect(await storage.getAuthorKey('sub-alice', 'k-1')).toBe(null);
  });

  it('is idempotent — deleting an absent keyId succeeds with deleted: false', async () => {
    const storage = inMemoryRegistryStorage();
    const result = await deleteAuthorKey(
      { keyId: 'k-never-existed' },
      { storage, authn: AUTHN },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ keyId: 'k-never-existed', deleted: false });
  });

  it('only deletes under the caller subject — another subject\'s same keyId survives and the response is indistinguishable from absent', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putAuthorKey({
      subject: 'sub-bob',
      keyId: 'k-shared',
      publicKeyBase64: 'BBBB',
    });
    const result = await deleteAuthorKey(
      { keyId: 'k-shared' },
      { storage, authn: AUTHN },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Same wire shape as the plain-absent case — existence of another
    // subject's key must not leak.
    expect(result.body).toEqual({ keyId: 'k-shared', deleted: false });
    expect(await storage.getAuthorKey('sub-bob', 'k-shared')).not.toBe(null);
  });

  it('rejects a missing/empty keyId with 400 invalid_request', async () => {
    const storage = inMemoryRegistryStorage();
    const result = await deleteAuthorKey({ keyId: '' }, { storage, authn: AUTHN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_request');
  });

  it('maps a storage throw to 500 server_error', async () => {
    const base = inMemoryRegistryStorage();
    const storage: RegistryStorage = {
      ...base,
      async deleteAuthorKey() {
        throw new Error('table on fire');
      },
    };
    const result = await deleteAuthorKey({ keyId: 'k-1' }, { storage, authn: AUTHN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(result.body.error).toBe('server_error');
  });
});
