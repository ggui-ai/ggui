/**
 * Tests for `InMemoryActiveConsumerRegistry` — the OSS in-memory
 * reference adapter for the active-consumer awareness seam.
 *
 * Locks the reference-count semantics:
 *   - `enter` increments; `hasActive` becomes true.
 *   - `exit` decrements; entry is removed when count reaches zero.
 *   - Multiple concurrent consumers per render are counted correctly.
 *   - Different renderIds don't bleed into each other.
 *   - `exit` without prior `enter` is harmless (no negative counts).
 */

import { describe, expect, it } from 'vitest';
import { InMemoryActiveConsumerRegistry } from './active-consumer-registry.js';

describe('InMemoryActiveConsumerRegistry', () => {
  it('starts empty — hasActive returns false for any id', () => {
    const r = new InMemoryActiveConsumerRegistry();
    expect(r.hasActive('render-1')).toBe(false);
    expect(r.hasActive('render-2')).toBe(false);
  });

  it('enter then hasActive returns true', () => {
    const r = new InMemoryActiveConsumerRegistry();
    r.enter('render-1');
    expect(r.hasActive('render-1')).toBe(true);
  });

  it('enter+exit returns hasActive to false', () => {
    const r = new InMemoryActiveConsumerRegistry();
    r.enter('render-1');
    r.exit('render-1');
    expect(r.hasActive('render-1')).toBe(false);
  });

  it('counts concurrent consumers per renderId', () => {
    const r = new InMemoryActiveConsumerRegistry();
    r.enter('render-1');
    r.enter('render-1');
    expect(r.hasActive('render-1')).toBe(true);
    r.exit('render-1');
    // One consumer still in — hasActive must still be true.
    expect(r.hasActive('render-1')).toBe(true);
    r.exit('render-1');
    expect(r.hasActive('render-1')).toBe(false);
  });

  it('keeps renderIds isolated', () => {
    const r = new InMemoryActiveConsumerRegistry();
    r.enter('render-A');
    r.enter('render-B');
    expect(r.hasActive('render-A')).toBe(true);
    expect(r.hasActive('render-B')).toBe(true);
    r.exit('render-A');
    expect(r.hasActive('render-A')).toBe(false);
    expect(r.hasActive('render-B')).toBe(true);
  });

  it('exit without enter is harmless (no underflow)', () => {
    const r = new InMemoryActiveConsumerRegistry();
    // Defensive: an early-error path that exits without entering must
    // not flip hasActive into a sticky negative state.
    r.exit('render-1');
    expect(r.hasActive('render-1')).toBe(false);
    r.enter('render-1');
    expect(r.hasActive('render-1')).toBe(true);
  });

  it('removes the entry when count hits zero (no zombie keys)', () => {
    const r = new InMemoryActiveConsumerRegistry();
    r.enter('render-1');
    r.exit('render-1');
    // We can't observe the internal map directly without reaching into
    // private state, but reentering should establish a fresh count
    // of 1 (not 1+something stale). Validate via the public contract:
    // a single matching exit must return to false.
    r.enter('render-1');
    r.exit('render-1');
    expect(r.hasActive('render-1')).toBe(false);
  });
});
