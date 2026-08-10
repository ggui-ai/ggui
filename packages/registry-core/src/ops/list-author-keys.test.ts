/**
 * `listAuthorKeys` op tests.
 */
import { describe, expect, it } from 'vitest';
import { listAuthorKeys } from './list-author-keys.js';
import { inMemoryRegistryStorage } from '../impls/memory-registry-storage.js';
import type { RegistryStorage } from '../interfaces/registry-storage.js';

const AUTHN = { subject: 'sub-alice' };

describe('listAuthorKeys', () => {
  it('returns only the caller subject\'s keys', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putAuthorKey({
      subject: 'sub-alice',
      keyId: 'k-a1',
      publicKeyBase64: 'AAAA',
      createdAt: '2026-08-01T00:00:00.000Z',
      label: 'laptop',
    });
    await storage.putAuthorKey({
      subject: 'sub-bob',
      keyId: 'k-b1',
      publicKeyBase64: 'BBBB',
    });

    const result = await listAuthorKeys({ storage, authn: AUTHN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.body.subject).toBe('sub-alice');
    expect(result.body.keys).toEqual([
      {
        keyId: 'k-a1',
        publicKeyBase64: 'AAAA',
        createdAt: '2026-08-01T00:00:00.000Z',
        label: 'laptop',
      },
    ]);
  });

  it('returns an empty list (200, not 404) for a subject with no keys', async () => {
    const storage = inMemoryRegistryStorage();
    const result = await listAuthorKeys({ storage, authn: AUTHN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toEqual({ subject: 'sub-alice', keys: [] });
  });

  it('sorts newest-first by createdAt; rows without createdAt sort last; keyId tie-break', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putAuthorKey({
      subject: 'sub-alice',
      keyId: 'k-old',
      publicKeyBase64: 'AAAA',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await storage.putAuthorKey({
      subject: 'sub-alice',
      keyId: 'k-legacy-b',
      publicKeyBase64: 'BBBB',
    });
    await storage.putAuthorKey({
      subject: 'sub-alice',
      keyId: 'k-new',
      publicKeyBase64: 'CCCC',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await storage.putAuthorKey({
      subject: 'sub-alice',
      keyId: 'k-legacy-a',
      publicKeyBase64: 'DDDD',
    });

    const result = await listAuthorKeys({ storage, authn: AUTHN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.keys.map((k) => k.keyId)).toEqual([
      'k-new',
      'k-old',
      'k-legacy-a',
      'k-legacy-b',
    ]);
  });

  it('maps a storage throw to 500 server_error', async () => {
    const base = inMemoryRegistryStorage();
    const storage: RegistryStorage = {
      ...base,
      async listAuthorKeys() {
        throw new Error('table on fire');
      },
    };
    const result = await listAuthorKeys({ storage, authn: AUTHN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(result.body.error).toBe('server_error');
  });
});
