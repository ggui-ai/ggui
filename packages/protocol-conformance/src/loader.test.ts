/**
 * Loader meta-tests — pin the `loadFixture` / `listFixtures` /
 * `loadAllFixtures` contract.
 */
import { describe, expect, it } from 'vitest';

import { listFixtures, loadAllFixtures, loadFixture } from './loader.js';

describe('loader', () => {
  it('listFixtures returns sorted names matching the catalog', () => {
    const names = listFixtures();
    expect(names.length).toBe(12);
    expect([...names].sort()).toEqual(names); // already sorted
    expect(names).toContain('bootstrap-success');
    expect(names).toContain('action-ack-sequence');
  });

  it('loadFixture resolves by name', () => {
    const fixture = loadFixture('bootstrap-success');
    expect(fixture.name).toBe('bootstrap-success');
    expect(fixture.skipReason).toBeNull();
    expect(fixture.expectedBehavior.kind).toBe('bootstrap-success');
  });

  it('loadFixture throws on unknown name with the expected diagnostic', () => {
    expect(() => loadFixture('no-such-fixture')).toThrow(
      /fixture 'no-such-fixture' not found/,
    );
  });

  it('loadFixture throws on empty name (caller-side discipline)', () => {
    expect(() => loadFixture('')).toThrow(/non-empty name/);
  });

  it('loadAllFixtures returns the full deterministic catalog', () => {
    const all = loadAllFixtures();
    expect(all.length).toBe(12);
    const names = all.map((f) => f.name);
    expect([...names].sort()).toEqual(names);
  });
});
