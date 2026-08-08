import { describe, expect, it } from 'vitest';
import { InMemoryRenderIdentityStore } from './in-memory/render-identity-store.js';
import type { RenderIdentityRecord } from './render-identity-store.js';

/**
 * Fixture discipline every later task copies: `contractKey` is the
 * 16-char blueprint-key domain, NEVER the 64-char validators-bundle
 * hash. The length pin below is the cheap guard that catches a
 * wrong-domain value at the seam where it is first written.
 */
const CONTRACT_KEY = 'a1b2c3d4e5f60718';

function makeRecord(
  overrides: Partial<RenderIdentityRecord> = {},
): RenderIdentityRecord {
  return {
    sessionId: 'render-1',
    appId: 'app-1',
    userId: 'user-1',
    blueprintId: null,
    contractKey: CONTRACT_KEY,
    variantKey: 'default',
    props: { city: 'Seoul', temperature: 15 },
    seqAtLastCommit: 7,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

/** Narrow a `get` result so the assertions below need no casts. */
function expectStored(
  record: RenderIdentityRecord | null,
): RenderIdentityRecord {
  if (record === null) {
    throw new Error('expected a stored render-identity record, got null');
  }
  return record;
}

describe('InMemoryRenderIdentityStore', () => {
  it('get returns null for an unknown sessionId', async () => {
    const store = new InMemoryRenderIdentityStore();
    expect(await store.get('nope')).toBeNull();
  });

  it('put + get round-trips every field verbatim', async () => {
    const store = new InMemoryRenderIdentityStore();
    const record = makeRecord();
    await store.put(record);
    expect(await store.get('render-1')).toEqual(record);
  });

  it('preserves a null blueprintId — the pre-backfill state is not a miss', async () => {
    // Cold gen writes the record before registration resolves an id,
    // then re-puts with the id backfilled. A store that dropped or
    // coerced `null` would make that backfill unobservable.
    const store = new InMemoryRenderIdentityStore();
    await store.put(makeRecord({ blueprintId: null }));
    expect(expectStored(await store.get('render-1')).blueprintId).toBeNull();
  });

  it('put is an upsert by sessionId — the later write wins whole-record', async () => {
    const store = new InMemoryRenderIdentityStore();
    await store.put(makeRecord());
    const replacement = makeRecord({
      blueprintId: 'bp-42',
      props: { city: 'Lisbon' },
      seqAtLastCommit: 12,
      updatedAt: 2_000,
    });
    await store.put(replacement);
    expect(await store.get('render-1')).toEqual(replacement);
  });

  it('keeps records for different sessionIds independent', async () => {
    const store = new InMemoryRenderIdentityStore();
    await store.put(makeRecord());
    await store.put(
      makeRecord({ sessionId: 'render-2', variantKey: 'compact' }),
    );
    expect(expectStored(await store.get('render-1')).variantKey).toBe(
      'default',
    );
    expect(expectStored(await store.get('render-2')).variantKey).toBe(
      'compact',
    );
  });

  it('round-trips a record with no userId — an unscoped render still has an identity', async () => {
    const store = new InMemoryRenderIdentityStore();
    const anonymous: RenderIdentityRecord = {
      sessionId: 'render-1',
      appId: 'app-1',
      blueprintId: null,
      contractKey: CONTRACT_KEY,
      variantKey: 'default',
      props: { city: 'Seoul' },
      seqAtLastCommit: 1,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    await store.put(anonymous);
    const stored = expectStored(await store.get('render-1'));
    expect(stored).toEqual(anonymous);
    expect(stored.userId).toBeUndefined();
  });

  it('round-trips absent props — a render need not carry any', async () => {
    const store = new InMemoryRenderIdentityStore();
    await store.put(makeRecord({ props: undefined }));
    expect(expectStored(await store.get('render-1')).props).toBeUndefined();
  });

  it('pins contractKey to the 16-char blueprint-key domain', async () => {
    const store = new InMemoryRenderIdentityStore();
    await store.put(makeRecord());
    const stored = expectStored(await store.get('render-1'));
    expect(stored.contractKey).toHaveLength(16);
    expect(stored.contractKey).toBe(CONTRACT_KEY);
  });

  it('does not alias the caller record — mutating the input after put is invisible', async () => {
    const store = new InMemoryRenderIdentityStore();
    const record = makeRecord();
    await store.put(record);
    if (record.props === undefined) throw new Error('fixture lost its props');
    record.props.city = 'mutated';
    expect(expectStored(await store.get('render-1')).props).toEqual({
      city: 'Seoul',
      temperature: 15,
    });
  });

  it('get returns a defensive copy — mutating the result does not corrupt the store', async () => {
    const store = new InMemoryRenderIdentityStore();
    await store.put(makeRecord());
    const first = expectStored(await store.get('render-1'));
    if (first.props === undefined) throw new Error('stored record lost props');
    first.props.city = 'mutated';
    expect(expectStored(await store.get('render-1')).props).toEqual({
      city: 'Seoul',
      temperature: 15,
    });
  });

  it('rejects a record with an empty sessionId', async () => {
    // An unkeyed record can never be read back; accepting it silently
    // turns a write bug into a lookup miss a whole slice later.
    const store = new InMemoryRenderIdentityStore();
    await expect(store.put(makeRecord({ sessionId: '' }))).rejects.toThrow(
      /sessionId/i,
    );
    expect(store.size).toBe(0);
  });

  it('tracks stored records via size', async () => {
    const store = new InMemoryRenderIdentityStore();
    expect(store.size).toBe(0);
    await store.put(makeRecord());
    await store.put(makeRecord({ sessionId: 'render-2' }));
    expect(store.size).toBe(2);
    // Same-sessionId put replaces rather than grows.
    await store.put(makeRecord({ seqAtLastCommit: 9 }));
    expect(store.size).toBe(2);
  });
});
