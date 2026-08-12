/**
 * Ledger-derived epochs (#483): the count of `'ui.reminted'` events
 * IS the epoch — no counter field anywhere. These pins keep the
 * derivation honest against the taxonomy.
 */
import { describe, expect, it } from 'vitest';
import { deriveEpochFromEvents } from '../ggui-session-event.js';

const ev = (type: string) => ({ type });

describe('deriveEpochFromEvents', () => {
  it('empty ledger = epoch 0 (render mints epoch 0 with no event)', () => {
    expect(deriveEpochFromEvents([])).toBe(0);
  });

  it('remint-free activity stays at epoch 0', () => {
    expect(
      deriveEpochFromEvents([
        ev('ui.created'),
        ev('ui.updated'),
        ev('user.submitted'),
        ev('ui.updated'),
      ]),
    ).toBe(0);
  });

  it('each reminted event advances the derived epoch', () => {
    expect(
      deriveEpochFromEvents([
        ev('ui.created'),
        ev('ui.reminted'),
        ev('ui.updated'),
        ev('ui.reminted'),
      ]),
    ).toBe(2);
  });

  it('a ledger slice derives the epoch AS OF that slice (pinned-snapshot semantics)', () => {
    const full = [ev('ui.created'), ev('ui.reminted'), ev('ui.updated'), ev('ui.reminted')];
    expect(deriveEpochFromEvents(full.slice(0, 2))).toBe(1);
    expect(deriveEpochFromEvents(full)).toBe(2);
  });
});
