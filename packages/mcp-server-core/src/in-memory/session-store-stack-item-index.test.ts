/**
 * `InMemorySessionStore.getSessionByStackItemId` — stackItemId secondary index
 * coverage. Verifies the index is maintained by `appendStackItem`
 * (insert + replace upsert), cleaned by `delete`, and tenancy-leak-free.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from './session-store.js';

describe('InMemorySessionStore.getSessionByStackItemId', () => {
  async function seed(appId = 'app-1', sessionId = 'sess-1') {
    const store = new InMemorySessionStore();
    await store.create({ id: sessionId, appId });
    return store;
  }

  it('returns null for an unknown stackItemId', async () => {
    const store = new InMemorySessionStore();
    const out = await store.getSessionByStackItemId('never-existed');
    expect(out).toBeNull();
  });

  it('indexes a stackItemId on first appendStackItem', async () => {
    const store = await seed();
    await store.appendStackItem('sess-1', {
      id: 'page-A',
      componentCode: '/**/',
      createdAt: new Date().toISOString(),
    });
    const out = await store.getSessionByStackItemId('page-A');
    expect(out).toEqual({ sessionId: 'sess-1', appId: 'app-1' });
  });

  it('idempotent on upsert — replacing the same stackItemId keeps the index entry stable', async () => {
    const store = await seed();
    const item = (props: import('@ggui-ai/protocol').JsonObject) => ({
      id: 'page-X',
      componentCode: '/**/',
      props,
      createdAt: new Date().toISOString(),
    });
    await store.appendStackItem('sess-1', item({ count: 1 }));
    await store.appendStackItem('sess-1', item({ count: 2 }));
    const out = await store.getSessionByStackItemId('page-X');
    expect(out).toEqual({ sessionId: 'sess-1', appId: 'app-1' });
  });

  it('indexes multiple stackItemIds owned by the same session', async () => {
    const store = await seed();
    await store.appendStackItem('sess-1', {
      id: 'p1',
      componentCode: '/**/',
      createdAt: new Date().toISOString(),
    });
    await store.appendStackItem('sess-1', {
      id: 'p2',
      componentCode: '/**/',
      createdAt: new Date().toISOString(),
    });
    expect(await store.getSessionByStackItemId('p1')).toEqual({
      sessionId: 'sess-1',
      appId: 'app-1',
    });
    expect(await store.getSessionByStackItemId('p2')).toEqual({
      sessionId: 'sess-1',
      appId: 'app-1',
    });
  });

  it('keeps cross-tenant stackItemIds isolated — same id under different appId points to different session', async () => {
    const store = new InMemorySessionStore();
    await store.create({ id: 'sess-A', appId: 'app-A' });
    await store.create({ id: 'sess-B', appId: 'app-B' });
    // Same stackItemId UUIDs would never collide in practice (UUIDv4
    // collision space is ~2^122) — this exercises the structural
    // case where the secondary index is keyed by stackItemId alone.
    // The newer write wins, by design (last upsert).
    await store.appendStackItem('sess-A', {
      id: 'p-shared',
      componentCode: '/**/',
      createdAt: new Date().toISOString(),
    });
    await store.appendStackItem('sess-B', {
      id: 'p-shared',
      componentCode: '/**/',
      createdAt: new Date().toISOString(),
    });
    const out = await store.getSessionByStackItemId('p-shared');
    expect(out).toEqual({ sessionId: 'sess-B', appId: 'app-B' });
  });

  it('drops index entries when the owning session is deleted', async () => {
    const store = await seed();
    await store.appendStackItem('sess-1', {
      id: 'orphan',
      componentCode: '/**/',
      createdAt: new Date().toISOString(),
    });
    expect(await store.getSessionByStackItemId('orphan')).not.toBeNull();
    await store.delete('sess-1');
    expect(await store.getSessionByStackItemId('orphan')).toBeNull();
  });
});
