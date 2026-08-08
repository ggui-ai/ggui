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
import { RENDER_IDENTITY_EVENTS } from './render-identity.js';

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
