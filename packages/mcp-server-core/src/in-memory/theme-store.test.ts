/**
 * ThemeStore port semantics (ggui#598-C FREEZE, 2026-08-22) — pinned
 * through the reference in-memory adapter. These pins ARE the frozen
 * surface cloud's skeleton builds against; churn here reworks their
 * store, so every behavior below is one the seat defends.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryThemeStore } from './theme-store.js';
import {
  isValidThemeId,
  type StoredTheme,
} from '../theme-store.js';

const DOC = JSON.stringify({ light: { $name: 'x' } });
const HASH = 'a'.repeat(64);

function stored(overrides: Partial<StoredTheme> = {}): StoredTheme {
  return {
    appId: 'app-1',
    themeId: 'acme-brand-v1',
    document: DOC,
    documentHash: HASH,
    registeredAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('InMemoryThemeStore — the frozen port semantics', () => {
  let store: InMemoryThemeStore;
  beforeEach(() => {
    store = new InMemoryThemeStore();
  });

  it('put → get round-trips the stored record verbatim', async () => {
    await store.put(stored());
    const got = await store.get('app-1', 'acme-brand-v1');
    expect(got).toEqual(stored());
  });

  it('get scopes by appId — one tenant never reads another\'s theme', async () => {
    await store.put(stored());
    expect(await store.get('app-2', 'acme-brand-v1')).toBeNull();
  });

  it('put upserts: same (appId, themeId) replaces the document', async () => {
    await store.put(stored());
    await store.put(stored({ document: '{"light":{}}', updatedAt: 2_000 }));
    const got = await store.get('app-1', 'acme-brand-v1');
    expect(got?.document).toBe('{"light":{}}');
    expect(got?.updatedAt).toBe(2_000);
    expect(got?.registeredAt).toBe(1_000);
  });

  it('list returns only the app\'s themes, themeId-sorted', async () => {
    await store.put(stored({ themeId: 'zeta-brand' }));
    await store.put(stored({ themeId: 'acme-brand-v1' }));
    await store.put(stored({ appId: 'app-2', themeId: 'other' }));
    const listed = await store.list('app-1');
    expect(listed.map((t) => t.themeId)).toEqual(['acme-brand-v1', 'zeta-brand']);
  });

  it('delete returns true once, false when absent; the row is gone', async () => {
    await store.put(stored());
    expect(await store.delete('app-1', 'acme-brand-v1')).toBe(true);
    expect(await store.delete('app-1', 'acme-brand-v1')).toBe(false);
    expect(await store.get('app-1', 'acme-brand-v1')).toBeNull();
  });
});

describe('isValidThemeId — the frozen id grammar', () => {
  it('accepts lowercase kebab ids, 3-64 chars, alnum-bounded', () => {
    expect(isValidThemeId('acme-brand-v1')).toBe(true);
    expect(isValidThemeId('a1b')).toBe(true);
  });

  it('rejects the shapes the wire must never accept', () => {
    expect(isValidThemeId('')).toBe(false);
    expect(isValidThemeId('ab')).toBe(false); // too short
    expect(isValidThemeId('-leading')).toBe(false);
    expect(isValidThemeId('trailing-')).toBe(false);
    expect(isValidThemeId('Upper-Case')).toBe(false);
    expect(isValidThemeId('under_score')).toBe(false);
    expect(isValidThemeId('a'.repeat(65))).toBe(false);
  });
});
