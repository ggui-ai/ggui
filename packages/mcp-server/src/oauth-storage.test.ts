/**
 * Storage-contract tests for `OAuthStorage` — Phase 1 client-management
 * additions (`listClients` + `deleteClient`).
 *
 * These pin the seam the console's "Connected Apps" tab consumes. The
 * pre-Phase-1 surface (`putAuthCode` / `consumeAuthCode` / `putClient`
 * / `getClient`) is intentionally not retested here — the existing
 * OAuth integration tests cover that path; this file owns only the
 * client-management additions.
 */
import { describe, expect, it } from 'vitest';
import type { ClientRecord } from './oauth.js';
import { InMemoryOAuthStorage } from './oauth.js';

function makeClient(
  overrides: Partial<ClientRecord> = {},
): ClientRecord {
  return {
    clientId: 'client-x',
    redirectUris: ['https://example.com/cb'],
    createdAt: 0,
    ...overrides,
  };
}

describe('InMemoryOAuthStorage — Phase 1 client management', () => {
  describe('listClients', () => {
    it('returns an empty array when no clients have registered', async () => {
      const storage = new InMemoryOAuthStorage();
      const clients = await storage.listClients();
      expect(clients).toEqual([]);
    });

    it('returns every registered client', async () => {
      const storage = new InMemoryOAuthStorage();
      await storage.putClient(makeClient({ clientId: 'a', createdAt: 1 }));
      await storage.putClient(makeClient({ clientId: 'b', createdAt: 2 }));
      const clients = await storage.listClients();
      expect(clients.map((c) => c.clientId).sort()).toEqual(['a', 'b']);
    });

    it('sorts oldest-first by createdAt', async () => {
      const storage = new InMemoryOAuthStorage();
      // Insert out of order; consumer relies on the sort, not insertion order.
      await storage.putClient(makeClient({ clientId: 'newest', createdAt: 3000 }));
      await storage.putClient(makeClient({ clientId: 'oldest', createdAt: 1000 }));
      await storage.putClient(makeClient({ clientId: 'middle', createdAt: 2000 }));
      const ids = (await storage.listClients()).map((c) => c.clientId);
      expect(ids).toEqual(['oldest', 'middle', 'newest']);
    });
  });

  describe('deleteClient', () => {
    it('removes a registered client so getClient returns null', async () => {
      const storage = new InMemoryOAuthStorage();
      await storage.putClient(makeClient({ clientId: 'doomed' }));
      expect(await storage.getClient('doomed')).not.toBeNull();
      await storage.deleteClient('doomed');
      expect(await storage.getClient('doomed')).toBeNull();
    });

    it('removes the entry from listClients output', async () => {
      const storage = new InMemoryOAuthStorage();
      await storage.putClient(makeClient({ clientId: 'a', createdAt: 1 }));
      await storage.putClient(makeClient({ clientId: 'b', createdAt: 2 }));
      await storage.deleteClient('a');
      const ids = (await storage.listClients()).map((c) => c.clientId);
      expect(ids).toEqual(['b']);
    });

    it('is idempotent — deleting an unknown id resolves cleanly', async () => {
      const storage = new InMemoryOAuthStorage();
      // No throw, no rejection.
      await expect(storage.deleteClient('never-registered')).resolves.toBeUndefined();
    });

    it('does not affect other clients', async () => {
      const storage = new InMemoryOAuthStorage();
      await storage.putClient(makeClient({ clientId: 'keep', createdAt: 1 }));
      await storage.putClient(makeClient({ clientId: 'doomed', createdAt: 2 }));
      await storage.deleteClient('doomed');
      const survivor = await storage.getClient('keep');
      expect(survivor?.clientId).toBe('keep');
    });
  });
});
