import { describe, expect, it } from 'vitest';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import { claimSpentOneShot, withSpentOneShots, type SpentOneShotsLedger } from './ggui-session-store.js';

// ggui#1424 — the one rule every store applies when a dispatch claims a
// oneShot spend. The LEDGER is the store's record: the read view's
// `{ epoch, actions }` plus `spentBy`, the actionId that holds each action.
describe('claimSpentOneShot (ggui#1424)', () => {
  const g1 = { epoch: 0, action: 'confirm', actionId: 'g-1' };

  it('no record → recorded; the ledger names the holder', () => {
    expect(claimSpentOneShot(undefined, g1)).toEqual({
      claim: { outcome: 'recorded' },
      record: { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-1', delivered: false } } },
    });
  });

  it('the same card, the action already listed → already-spent by its holder; the record does not change', () => {
    const current: SpentOneShotsLedger = { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-1', delivered: false } } };
    expect(claimSpentOneShot(current, { ...g1, actionId: 'g-2' })).toEqual({
      claim: { outcome: 'already-spent', by: 'g-1', delivered: false },
      record: null,
    });
    expect(claimSpentOneShot(current, g1)).toEqual({ claim: { outcome: 'already-spent', by: 'g-1', delivered: false }, record: null });
  });

  it('the same card, a new action → recorded; the holder map gains it and keeps the others', () => {
    const current: SpentOneShotsLedger = { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-1', delivered: false } } };
    expect(claimSpentOneShot(current, { epoch: 0, action: 'cancel', actionId: 'g-2' })).toEqual({
      claim: { outcome: 'recorded' },
      record: { epoch: 0, actions: ['confirm', 'cancel'], spentBy: { confirm: { actionId: 'g-1', delivered: false }, cancel: { actionId: 'g-2', delivered: false } } },
    });
  });

  it("a newer card's spend → recorded with a fresh ledger (replaces, never appends)", () => {
    const current: SpentOneShotsLedger = { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-1', delivered: false } } };
    expect(claimSpentOneShot(current, { epoch: 1, action: 'confirm', actionId: 'g-2' })).toEqual({
      claim: { outcome: 'recorded' },
      record: { epoch: 1, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-2', delivered: false } } },
    });
  });

  it("an older card's spend → superseded; the record does not change", () => {
    const current: SpentOneShotsLedger = { epoch: 2, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-1', delivered: false } } };
    expect(claimSpentOneShot(current, { epoch: 1, action: 'confirm', actionId: 'g-2' })).toEqual({
      claim: { outcome: 'superseded' },
      record: null,
    });
  });

  it('a record from before the ids existed has no holder: already-spent with no `by`', () => {
    const current: SpentOneShotsLedger = { epoch: 0, actions: ['confirm'], spentBy: {} };
    const r = claimSpentOneShot(current, { ...g1, actionId: 'g-2' });
    expect(r.claim).toEqual({ outcome: 'already-spent' });
    expect(r.record).toBeNull();
  });

  it('a spend without an id is recorded and held by nobody', () => {
    expect(claimSpentOneShot(undefined, { epoch: 0, action: 'confirm' })).toEqual({
      claim: { outcome: 'recorded' },
      record: { epoch: 0, actions: ['confirm'], spentBy: {} },
    });
  });

  it('a take-over: `reclaimFrom` naming the current holder → recorded, the holder replaced (the loss-window close, ggui#1424)', () => {
    const current: SpentOneShotsLedger = { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-1', delivered: false } } };
    expect(claimSpentOneShot(current, { ...g1, actionId: 'g-2', reclaimFrom: 'g-1' })).toEqual({
      claim: { outcome: 'recorded' },
      record: { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-2', delivered: false } } },
    });
  });

  it('a take-over naming a holder the ledger no longer names → already-spent by the real holder; nothing changes', () => {
    const current: SpentOneShotsLedger = { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-3', delivered: false } } };
    expect(claimSpentOneShot(current, { ...g1, actionId: 'g-2', reclaimFrom: 'g-1' })).toEqual({
      claim: { outcome: 'already-spent', by: 'g-3', delivered: false },
      record: null,
    });
  });

  it('a take-over of a spend held by nobody, or without an id of its own, changes nothing', () => {
    const anon: SpentOneShotsLedger = { epoch: 0, actions: ['confirm'], spentBy: {} };
    expect(claimSpentOneShot(anon, { ...g1, actionId: 'g-2', reclaimFrom: 'g-1' })).toEqual({
      claim: { outcome: 'already-spent' },
      record: null,
    });
    const held: SpentOneShotsLedger = { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-1', delivered: false } } };
    expect(claimSpentOneShot(held, { epoch: 0, action: 'confirm', reclaimFrom: 'g-1' })).toEqual({
      claim: { outcome: 'already-spent', by: 'g-1', delivered: false },
      record: null,
    });
  });

  it('the mark: the holder, after its append, records the spend as delivered; the claim says so', () => {
    const current: SpentOneShotsLedger = { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-1', delivered: false } } };
    expect(claimSpentOneShot(current, { ...g1, delivered: true })).toEqual({
      claim: { outcome: 'already-spent', by: 'g-1', delivered: true },
      record: { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-1', delivered: true } } },
    });
    // Marking again changes nothing.
    const marked: SpentOneShotsLedger = { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-1', delivered: true } } };
    expect(claimSpentOneShot(marked, { ...g1, delivered: true })).toEqual({
      claim: { outcome: 'already-spent', by: 'g-1', delivered: true },
      record: null,
    });
    // A stranger cannot mark another holder's spend delivered.
    expect(claimSpentOneShot(current, { ...g1, actionId: 'g-2', delivered: true })).toEqual({
      claim: { outcome: 'already-spent', by: 'g-1', delivered: false },
      record: null,
    });
  });

  it('a take-over of a DELIVERED holder is refused: already-spent by it, delivered', () => {
    const marked: SpentOneShotsLedger = { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-1', delivered: true } } };
    expect(claimSpentOneShot(marked, { ...g1, actionId: 'g-2', reclaimFrom: 'g-1' })).toEqual({
      claim: { outcome: 'already-spent', by: 'g-1', delivered: true },
      record: null,
    });
  });

  it('the release: a holder that claimed and whose gesture was never stored gives the action back (ggui#1424 / #1519)', () => {
    const current: SpentOneShotsLedger = {
      epoch: 0,
      actions: ['confirm', 'cancel'],
      spentBy: { confirm: { actionId: 'g-1', delivered: false }, cancel: { actionId: 'g-2', delivered: true } },
    };
    expect(claimSpentOneShot(current, { ...g1, release: true })).toEqual({
      claim: { outcome: 'released' },
      record: { epoch: 0, actions: ['cancel'], spentBy: { cancel: { actionId: 'g-2', delivered: true } } },
    });
    // A stranger, a delivered holder, or an unknown action: nothing changes.
    expect(claimSpentOneShot(current, { ...g1, actionId: 'g-9', release: true })).toEqual({
      claim: { outcome: 'already-spent', by: 'g-1', delivered: false },
      record: null,
    });
    expect(claimSpentOneShot(current, { epoch: 0, action: 'cancel', actionId: 'g-2', release: true })).toEqual({
      claim: { outcome: 'already-spent', by: 'g-2', delivered: true },
      record: null,
    });
    expect(claimSpentOneShot(current, { epoch: 0, action: 'other', actionId: 'g-3', release: true })).toEqual({
      claim: { outcome: 'released' },
      record: null,
    });
  });

  it('a first claim that already carries the mark records a delivered holder (an ingress whose append preceded its spend)', () => {
    expect(claimSpentOneShot(undefined, { ...g1, delivered: true })).toEqual({
      claim: { outcome: 'recorded' },
      record: { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-1', delivered: true } } },
    });
  });

  it('refuses a malformed spend before any store writes it', () => {
    expect(() => claimSpentOneShot(undefined, { epoch: -1, action: 'confirm', actionId: 'g' })).toThrow(RangeError);
    expect(() => claimSpentOneShot(undefined, { epoch: 0, action: '', actionId: 'g' })).toThrow(RangeError);
  });
});

describe('withSpentOneShots folds names only — never the holders (ggui#1424)', () => {
  const render: ComponentGguiSession = {
    type: 'component',
    id: 'r-1',
    appId: 'app-1',
    componentCode: '/* card */',
    eventSequence: 0,
    createdAt: 0,
    lastActivityAt: 0,
    expiresAt: 0,
  };
  it('the read view is { epoch, actions }', () => {
    const folded = withSpentOneShots(render, { epoch: 0, actions: ['confirm'], spentBy: { confirm: { actionId: 'g-1', delivered: false } } });
    expect(folded.type === 'component' ? folded.spentOneShots : undefined).toEqual({ epoch: 0, actions: ['confirm'] });
    expect(folded.type === 'component' ? folded.spentOneShots : undefined).not.toHaveProperty('spentBy');
  });
});
