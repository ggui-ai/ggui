/**
 * Registry completeness for the render-identity event names (#430
 * slice 1).
 *
 * The point of the registry is that the set of names is enumerable from
 * one place and that every emitter — in this package or in a storage
 * backend outside it — spells them from that place. This pins the set,
 * so adding a member is a conscious edit here rather than a string that
 * appears in one backend's logs and nowhere else.
 */

import { describe, expect, it } from 'vitest';
import type { StoredGguiSession } from '@ggui-ai/mcp-server-core';
import { InMemoryRenderIdentityStore } from '@ggui-ai/mcp-server-core/in-memory';
import { RENDER_IDENTITY_EVENTS, refreshRenderIdentity, writeRenderIdentity } from './render-identity.js';

describe('RENDER_IDENTITY_EVENTS — the registry', () => {
  it('contains exactly these wire names', () => {
    // LITERALS ON PURPOSE — do not "DRY" this against the constants.
    //
    // The two directions are deliberately different, and each catches
    // what the other cannot:
    //
    //   - PRODUCTION code imports the constants, so renaming a KEY is a
    //     compile error at every emitter.
    //   - TESTS assert the literal VALUES, so renaming a value lands as
    //     a conscious red here. Operators alert on these strings; a
    //     rename is an alert-filter migration, not a refactor.
    //
    // Rewriting this to `Object.values(RENDER_IDENTITY_EVENTS)` on both
    // sides would make the assertion vacuous — it would pass for any
    // renaming at all, which is exactly the change that must not pass
    // silently.
    expect(Object.values(RENDER_IDENTITY_EVENTS).sort()).toEqual(
      [
        'render_identity_refresh_failed',
        'render_identity_refresh_skipped',
        'render_identity_row_unreadable',
        'render_identity_write_failed',
        'render_props_over_cap',
      ].sort(),
    );
  });

  it('has no duplicate values — one key per emitted name', () => {
    const values = Object.values(RENDER_IDENTITY_EVENTS);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ggui#1405 slice 2 — the blueprint-identity marker travels with the id it
// describes: written when given, absent when not, carried forward verbatim by
// a refresh (which never recomputes the identity slice).
describe('blueprintIdentity on the identity record (ggui#1405)', () => {
  const session = (seq: number): StoredGguiSession => ({
    id: 'render-eph-1',
    appId: 'app-1',
    eventSequence: seq,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_001_000,
    expiresAt: 1_700_000_900_000,
    render: {
      type: 'component',
      id: 'render-eph-1',
      appId: 'app-1',
      componentCode: 'export default function C(){return null;}',
      eventSequence: seq,
      createdAt: 1_700_000_000_000,
      lastActivityAt: 1_700_000_001_000,
      expiresAt: 1_700_000_900_000,
    },
  });
  const slice = { blueprintId: 'bp_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', contractKey: '0123456789abcdef', variantKey: 'fedcba9876543210' };

  it('writes the marker when given and omits the key when not', async () => {
    const store = new InMemoryRenderIdentityStore();
    await writeRenderIdentity(store, session(1), { ...slice, blueprintIdentity: 'ephemeral' });
    expect((await store.get('render-eph-1'))?.blueprintIdentity).toBe('ephemeral');
    const plain = new InMemoryRenderIdentityStore();
    await writeRenderIdentity(plain, session(1), slice);
    const rec = await plain.get('render-eph-1');
    expect(rec !== null && 'blueprintIdentity' in rec).toBe(false);
  });

  it('a refresh carries the marker forward with the id, verbatim', async () => {
    const store = new InMemoryRenderIdentityStore();
    await writeRenderIdentity(store, session(1), { ...slice, blueprintIdentity: 'ephemeral' });
    await refreshRenderIdentity(store, session(4));
    const rec = await store.get('render-eph-1');
    expect(rec?.seqAtLastCommit).toBe(4);
    expect(rec?.blueprintId).toBe(slice.blueprintId);
    expect(rec?.blueprintIdentity).toBe('ephemeral');
  });
});
