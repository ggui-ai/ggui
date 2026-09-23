/**
 * The corpus cache is gitignored and fetched (oss/e2e/fixtures/silverprotocol,
 * pinned by fixtures.lock.json). A worktree without it must fail with the fix
 * named, never with a bare ENOENT that a reviewer can mistake for a
 * pre-existing red (#1298, ggui-main's catch on the 0.6.5 bump).
 */
import { describe, expect, it } from 'vitest';
import { loadLeg } from './corpus.js';

describe('corpus loader — a missing fixture names its fix', () => {
  it('a leg absent from the cache throws naming fetch-fixtures.mjs and the missing file', () => {
    expect(() => loadLeg('no-such-scenario', 'openai')).toThrow(/fetch-fixtures\.mjs/);
    expect(() => loadLeg('no-such-scenario', 'openai')).toThrow(/no-such-scenario\/openai\.native\.json/);
  });

  it('a locked leg still loads (control: the check does not block real data)', () => {
    const leg = loadLeg('app-spec-structured-result', 'openai');
    expect(leg.native.length).toBeGreaterThan(0);
    expect(leg.agjson.length).toBeGreaterThan(0);
  });
});
