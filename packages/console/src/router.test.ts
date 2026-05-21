/**
 * Unit tests for `router.ts`. Focused on `parseRoute` — the pure
 * function — since `navigateTo` + `onRouteChange` need a real DOM
 * and get exercised via the browser in practice. `getStableRoute` is
 * the `useSyncExternalStore`-facing wrapper; its identity invariants
 * get dedicated coverage below.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetRouteCacheForTests,
  getStableRoute,
  isAdminRoute,
  parseRoute,
} from './router.js';

describe('parseRoute — root + deep-links', () => {
  it('matches root to admin-index (operator landing surface)', () => {
    // End-user zone retired in Slice 5. `/` is now an operator
    // surface that lands on Status (same content as /admin).
    expect(parseRoute('/')).toEqual({ kind: 'admin-index' });
    expect(parseRoute('')).toEqual({ kind: 'admin-index' });
  });

  it('matches /s/<shortCode> to viewer (deep-link)', () => {
    expect(parseRoute('/s/abc12345')).toEqual({
      kind: 'viewer',
      shortCode: 'abc12345',
    });
    expect(parseRoute('/s/abc12345/')).toEqual({
      kind: 'viewer',
      shortCode: 'abc12345',
    });
  });

  it('URL-decodes the shortCode segment', () => {
    const encoded = encodeURIComponent('abc+def');
    expect(parseRoute(`/s/${encoded}`)).toEqual({
      kind: 'viewer',
      shortCode: 'abc+def',
    });
  });

  it('rejects /s/ with empty segment as not-found', () => {
    expect(parseRoute('/s/')).toEqual({ kind: 'not-found', pathname: '/s/' });
  });

  it('rejects nested viewer paths as not-found', () => {
    expect(parseRoute('/s/abc/def')).toEqual({
      kind: 'not-found',
      pathname: '/s/abc/def',
    });
  });

  it('matches /preview/<blueprintId> to blueprint (deep-link)', () => {
    expect(parseRoute('/preview/weather-card-fixture')).toEqual({
      kind: 'blueprint',
      blueprintId: 'weather-card-fixture',
    });
    expect(parseRoute('/preview/weather-card-fixture/')).toEqual({
      kind: 'blueprint',
      blueprintId: 'weather-card-fixture',
    });
  });

  it('URL-decodes the blueprintId segment', () => {
    const encoded = encodeURIComponent('my/scoped@id');
    expect(parseRoute(`/preview/${encoded}`)).toEqual({
      kind: 'blueprint',
      blueprintId: 'my/scoped@id',
    });
  });

  it('rejects /preview/ with empty segment as not-found', () => {
    expect(parseRoute('/preview/')).toEqual({
      kind: 'not-found',
      pathname: '/preview/',
    });
  });
});

describe('parseRoute — admin zone', () => {
  it('matches /admin to the admin index', () => {
    expect(parseRoute('/admin')).toEqual({ kind: 'admin-index' });
    expect(parseRoute('/admin/')).toEqual({ kind: 'admin-index' });
  });

  it('matches /admin/status to admin-status', () => {
    expect(parseRoute('/admin/status')).toEqual({ kind: 'admin-status' });
    expect(parseRoute('/admin/status/')).toEqual({ kind: 'admin-status' });
  });

  it('matches /admin/sessions to admin-sessions', () => {
    expect(parseRoute('/admin/sessions')).toEqual({ kind: 'admin-sessions' });
    expect(parseRoute('/admin/sessions/')).toEqual({ kind: 'admin-sessions' });
  });

  it('matches /admin/variants to admin-variants (MVB-7)', () => {
    expect(parseRoute('/admin/variants')).toEqual({ kind: 'admin-variants' });
    expect(parseRoute('/admin/variants/')).toEqual({ kind: 'admin-variants' });
  });

  it('matches /admin/variants/:contractHash to admin-variant-detail (MVB-7)', () => {
    expect(parseRoute('/admin/variants/hash-abc')).toEqual({
      kind: 'admin-variant-detail',
      contractHash: 'hash-abc',
    });
    expect(parseRoute('/admin/variants/hash-abc/')).toEqual({
      kind: 'admin-variant-detail',
      contractHash: 'hash-abc',
    });
  });

  it('matches /admin/variants/:contractHash/generate to admin-variant-generate (MVB-7)', () => {
    expect(parseRoute('/admin/variants/hash-abc/generate')).toEqual({
      kind: 'admin-variant-generate',
      contractHash: 'hash-abc',
    });
    expect(parseRoute('/admin/variants/hash-abc/generate/')).toEqual({
      kind: 'admin-variant-generate',
      contractHash: 'hash-abc',
    });
  });

  it('URL-decodes the contractHash segment on variant routes (MVB-7)', () => {
    const encoded = encodeURIComponent('hash/with+special');
    expect(parseRoute(`/admin/variants/${encoded}`)).toEqual({
      kind: 'admin-variant-detail',
      contractHash: 'hash/with+special',
    });
  });

  it('matches /admin/blueprints to admin-blueprints', () => {
    expect(parseRoute('/admin/blueprints')).toEqual({
      kind: 'admin-blueprints',
    });
    expect(parseRoute('/admin/blueprints/')).toEqual({
      kind: 'admin-blueprints',
    });
  });

  it('matches /admin/config to admin-config', () => {
    expect(parseRoute('/admin/config')).toEqual({ kind: 'admin-config' });
    expect(parseRoute('/admin/config/')).toEqual({ kind: 'admin-config' });
  });

  it('matches /admin/tools to admin-tools', () => {
    expect(parseRoute('/admin/tools')).toEqual({ kind: 'admin-tools' });
    expect(parseRoute('/admin/tools/')).toEqual({ kind: 'admin-tools' });
  });

  it('matches /admin/llm-keys to admin-llm-keys', () => {
    expect(parseRoute('/admin/llm-keys')).toEqual({ kind: 'admin-llm-keys' });
    expect(parseRoute('/admin/llm-keys/')).toEqual({ kind: 'admin-llm-keys' });
  });

  it('matches /admin/connector-keys to admin-connector-keys', () => {
    expect(parseRoute('/admin/connector-keys')).toEqual({
      kind: 'admin-connector-keys',
    });
  });

  it('matches /admin/oauth-providers to admin-oauth-providers', () => {
    expect(parseRoute('/admin/oauth-providers')).toEqual({
      kind: 'admin-oauth-providers',
    });
  });

  it('matches /admin/clients to admin-clients', () => {
    expect(parseRoute('/admin/clients')).toEqual({ kind: 'admin-clients' });
  });

  it('matches /admin/theme to admin-theme', () => {
    expect(parseRoute('/admin/theme')).toEqual({ kind: 'admin-theme' });
    expect(parseRoute('/admin/theme/')).toEqual({ kind: 'admin-theme' });
  });

  it('matches /admin-login to admin-login', () => {
    expect(parseRoute('/admin-login')).toEqual({ kind: 'admin-login' });
    expect(parseRoute('/admin-login/')).toEqual({ kind: 'admin-login' });
  });

  it('rejects unknown /admin/* subpaths as not-found', () => {
    expect(parseRoute('/admin/unknown')).toEqual({
      kind: 'not-found',
      pathname: '/admin/unknown',
    });
    expect(parseRoute('/admin/theme/foo')).toEqual({
      kind: 'not-found',
      pathname: '/admin/theme/foo',
    });
  });
});

describe('parseRoute — retired paths (pre-launch no-backcompat)', () => {
  // End-user zone retired in Slice 5; old top-level operator paths
  // retired in Slices 1–3.

  it('rejects the retired end-user /login path', () => {
    expect(parseRoute('/login')).toEqual({
      kind: 'not-found',
      pathname: '/login',
    });
  });

  it('rejects the retired end-user /settings path', () => {
    expect(parseRoute('/settings')).toEqual({
      kind: 'not-found',
      pathname: '/settings',
    });
  });

  it('rejects the retired top-level /theme', () => {
    expect(parseRoute('/theme')).toEqual({
      kind: 'not-found',
      pathname: '/theme',
    });
  });

  it('rejects the retired top-level /config', () => {
    expect(parseRoute('/config')).toEqual({
      kind: 'not-found',
      pathname: '/config',
    });
  });

  it('rejects the retired top-level /status', () => {
    expect(parseRoute('/status')).toEqual({
      kind: 'not-found',
      pathname: '/status',
    });
  });

  it('rejects the retired top-level /tools', () => {
    expect(parseRoute('/tools')).toEqual({
      kind: 'not-found',
      pathname: '/tools',
    });
  });

  it('rejects the retired top-level /sessions', () => {
    expect(parseRoute('/sessions')).toEqual({
      kind: 'not-found',
      pathname: '/sessions',
    });
  });

  it('rejects the retired top-level /blueprints', () => {
    expect(parseRoute('/blueprints')).toEqual({
      kind: 'not-found',
      pathname: '/blueprints',
    });
  });

  it('rejects the retired /chat path', () => {
    expect(parseRoute('/chat')).toEqual({
      kind: 'not-found',
      pathname: '/chat',
    });
  });

  it('rejects the retired /registry path', () => {
    expect(parseRoute('/registry')).toEqual({
      kind: 'not-found',
      pathname: '/registry',
    });
  });

  it('rejects the retired /b/<id> shape', () => {
    expect(parseRoute('/b/weather-card-fixture')).toEqual({
      kind: 'not-found',
      pathname: '/b/weather-card-fixture',
    });
  });

  it('rejects /mcp on the SPA side (transport endpoint, not a SPA route)', () => {
    expect(parseRoute('/mcp')).toEqual({
      kind: 'not-found',
      pathname: '/mcp',
    });
  });
});

describe('parseRoute — fallthrough', () => {
  it('classifies unknown paths as not-found with the raw pathname', () => {
    expect(parseRoute('/foo')).toEqual({
      kind: 'not-found',
      pathname: '/foo',
    });
  });
});

describe('isAdminRoute', () => {
  it('returns true for admin-zone routes', () => {
    expect(isAdminRoute({ kind: 'admin-index' })).toBe(true);
    expect(isAdminRoute({ kind: 'admin-status' })).toBe(true);
    expect(isAdminRoute({ kind: 'admin-sessions' })).toBe(true);
    expect(isAdminRoute({ kind: 'admin-blueprints' })).toBe(true);
    expect(isAdminRoute({ kind: 'admin-variants' })).toBe(true);
    expect(
      isAdminRoute({ kind: 'admin-variant-detail', contractHash: 'h' }),
    ).toBe(true);
    expect(
      isAdminRoute({ kind: 'admin-variant-generate', contractHash: 'h' }),
    ).toBe(true);
    expect(isAdminRoute({ kind: 'admin-config' })).toBe(true);
    expect(isAdminRoute({ kind: 'admin-tools' })).toBe(true);
    expect(isAdminRoute({ kind: 'admin-llm-keys' })).toBe(true);
    expect(isAdminRoute({ kind: 'admin-connector-keys' })).toBe(true);
    expect(isAdminRoute({ kind: 'admin-oauth-providers' })).toBe(true);
    expect(isAdminRoute({ kind: 'admin-clients' })).toBe(true);
    expect(isAdminRoute({ kind: 'admin-theme' })).toBe(true);
  });

  it('returns false for deep-link surfaces, admin-login, and not-found', () => {
    expect(isAdminRoute({ kind: 'admin-login' })).toBe(false);
    expect(isAdminRoute({ kind: 'viewer', shortCode: 'abc' })).toBe(false);
    expect(isAdminRoute({ kind: 'blueprint', blueprintId: 'x' })).toBe(false);
    expect(isAdminRoute({ kind: 'not-found', pathname: '/x' })).toBe(false);
  });
});

describe('getStableRoute', () => {
  beforeEach(() => {
    _resetRouteCacheForTests();
  });

  it('returns the same object reference on repeated calls with the same pathname', () => {
    const a = getStableRoute('/s/abc12345');
    const b = getStableRoute('/s/abc12345');
    const c = getStableRoute('/s/abc12345');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('returns the same reference across the three route kinds independently', () => {
    const root1 = getStableRoute('/');
    const root2 = getStableRoute('/');
    expect(root2).toBe(root1);
    const viewer1 = getStableRoute('/s/hak3cw89');
    const viewer2 = getStableRoute('/s/hak3cw89');
    expect(viewer2).toBe(viewer1);
    const notFound1 = getStableRoute('/unknown');
    const notFound2 = getStableRoute('/unknown');
    expect(notFound2).toBe(notFound1);
  });

  it('returns a fresh reference when the pathname changes', () => {
    const a = getStableRoute('/');
    const b = getStableRoute('/s/xyz');
    expect(b).not.toBe(a);
    expect(a).toEqual({ kind: 'admin-index' });
    expect(b).toEqual({ kind: 'viewer', shortCode: 'xyz' });
    const aAgain = getStableRoute('/');
    expect(aAgain).toEqual({ kind: 'admin-index' });
    expect(aAgain).not.toBe(a);
  });

  it('returns parseRoute-equivalent values', () => {
    expect(getStableRoute('/')).toEqual(parseRoute('/'));
    expect(getStableRoute('/admin/status')).toEqual(parseRoute('/admin/status'));
    expect(getStableRoute('/nope')).toEqual(parseRoute('/nope'));
  });

  it('survives thousands of repeated calls without reallocating', () => {
    const first = getStableRoute('/s/test');
    for (let i = 0; i < 5000; i++) {
      expect(getStableRoute('/s/test')).toBe(first);
    }
  });
});
