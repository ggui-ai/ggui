/**
 * ggui#1415 runtime item 1 — the view's key root: `P`, the payload segment
 * of the slice's `wsToken`, and `K`, the slice's `viewKey`. The parse
 * captures it; the holder decides which root the view proves with.
 */
import { describe, it, expect } from 'vitest';
import { VIEW_PROOF_ROOT_MAX_CHARS } from '@ggui-ai/protocol/integrations/mcp-apps';
import { createViewRootHolder, viewRootOf } from '../view-root.js';

const KEY = 'K-7dUBMeCtprxv4DED-VUuAjEBHGqoaWA-hHgh5t12A';
const rootOf = (claims: object): string => Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
const claimsOf = (over: object = {}): object => ({
  sessionId: 's-1',
  appId: 'a-1',
  kind: 'ws',
  iat: 100,
  exp: 280,
  jti: 'jti-1',
  kid: 'kid-1',
  src: 'result',
  ...over,
});
const rootWith = (over: object = {}): { root: string; key: string } => ({ root: rootOf(claimsOf(over)), key: KEY });

describe('viewRootOf (ggui#1415)', () => {
  it("takes P from the wsToken's payload segment and K from viewKey", () => {
    const root = rootOf(claimsOf());
    expect(viewRootOf({ wsToken: `${root}.c2ln`, viewKey: KEY })).toEqual({ root, key: KEY });
  });

  it('captures nothing without a viewKey, or without the wsToken it is rooted in', () => {
    expect(viewRootOf({ wsToken: `${rootOf(claimsOf())}.c2ln` })).toBeUndefined();
    expect(viewRootOf({ viewKey: KEY })).toBeUndefined();
    expect(viewRootOf({ wsToken: '', viewKey: KEY })).toBeUndefined();
    expect(viewRootOf({ wsToken: `${rootOf(claimsOf())}.c2ln`, viewKey: '' })).toBeUndefined();
  });
});

describe('createViewRootHolder (ggui#1415)', () => {
  it("adopts a root whose P decodes to the slice's own session, and reads it back with its claims", () => {
    const holder = createViewRootHolder();
    const offered = rootWith();
    expect(holder.offer('s-1', offered)).toEqual({ adopted: true });
    expect(holder.current('s-1')).toEqual({ ...offered, claims: claimsOf() });
  });

  it('refuses a root whose P names another session, and holds nothing', () => {
    const holder = createViewRootHolder();
    expect(holder.offer('s-2', rootWith())).toEqual({ adopted: false, reason: 'session_mismatch' });
    expect(holder.current('s-1')).toBeUndefined();
    expect(holder.current('s-2')).toBeUndefined();
  });

  it(`refuses a P longer than ${VIEW_PROOF_ROOT_MAX_CHARS} characters as oversize, and one that does not decode as malformed`, () => {
    const holder = createViewRootHolder();
    const long = rootWith({ pad: 'x'.repeat(600) });
    expect(long.root.length).toBeGreaterThan(VIEW_PROOF_ROOT_MAX_CHARS);
    expect(holder.offer('s-1', long)).toEqual({ adopted: false, reason: 'oversize' });
    for (const root of ['not a root', Buffer.from('not json at all').toString('base64url'), rootOf(claimsOf({ kind: 'session' }))]) {
      expect(holder.offer('s-1', { root, key: KEY }), root).toEqual({ adopted: false, reason: 'malformed' });
    }
    expect(holder.current('s-1')).toBeUndefined();
  });

  it('never replaces a held root with a slice that carries none, such as a /state poll', () => {
    const holder = createViewRootHolder();
    holder.offer('s-1', rootWith());
    expect(holder.offer('s-1', undefined)).toEqual({ adopted: false, reason: 'no_key' });
    expect(holder.current('s-1')?.claims).toMatchObject({ iat: 100 });
  });

  it("adopts a later slice's root for the same session only when its iat is greater", () => {
    const holder = createViewRootHolder();
    holder.offer('s-1', rootWith({ iat: 100 }));
    expect(holder.offer('s-1', rootWith({ iat: 100, jti: 'jti-2' }))).toEqual({ adopted: false, reason: 'not_newer' });
    expect(holder.offer('s-1', rootWith({ iat: 99 }))).toEqual({ adopted: false, reason: 'not_newer' });
    expect(holder.current('s-1')?.claims).toMatchObject({ iat: 100, jti: 'jti-1' });
    expect(holder.offer('s-1', rootWith({ iat: 101 }))).toEqual({ adopted: true });
    expect(holder.current('s-1')?.claims).toMatchObject({ iat: 101 });
  });

  it("answers only for the session its root was adopted for, and a valid root for another session replaces it", () => {
    const holder = createViewRootHolder();
    holder.offer('s-1', rootWith({ iat: 100 }));
    expect(holder.current('s-2')).toBeUndefined();
    expect(holder.offer('s-2', rootWith({ sessionId: 's-2', iat: 50 }))).toEqual({ adopted: true });
    expect(holder.current('s-1')).toBeUndefined();
    expect(holder.current('s-2')?.claims).toMatchObject({ sessionId: 's-2', iat: 50 });
  });
});
