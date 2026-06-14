import { describe, expect, it, vi } from 'vitest';
import { CompositeAuthAdapter } from './composite-auth-adapter.js';
import { authAdapterContract } from './contract-tests/auth-adapter.js';
import type { AuthAdapter, AuthResult } from './auth-adapter.js';

const nullAdapter: AuthAdapter = {
  authenticate: async () => null,
  getIdentity: async () => null,
};
const fixed = (r: AuthResult): AuthAdapter => ({
  authenticate: async () => r,
  getIdentity: async () => r,
});
const builder: AuthResult = { identity: { kind: 'builder' }, source: 'dev' };

describe('CompositeAuthAdapter', () => {
  it('authenticate returns the first non-null result and stops', async () => {
    const second = fixed(builder);
    const spy = vi.spyOn(second, 'authenticate');
    const c = new CompositeAuthAdapter([nullAdapter, second]);
    expect(await c.authenticate('t')).toEqual(builder);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('authenticate returns null when all adapters return null', async () => {
    const c = new CompositeAuthAdapter([nullAdapter, nullAdapter]);
    expect(await c.authenticate('t')).toBeNull();
  });

  it('getIdentity returns the first non-null result', async () => {
    const c = new CompositeAuthAdapter([nullAdapter, fixed(builder)]);
    expect(await c.getIdentity({ headers: {} })).toEqual(builder);
  });

  it('short-circuits: a later adapter is not consulted once one hits', async () => {
    const later = fixed(builder);
    const spy = vi.spyOn(later, 'getIdentity');
    const c = new CompositeAuthAdapter([fixed(builder), later]);
    await c.getIdentity({ headers: {} });
    expect(spy).not.toHaveBeenCalled();
  });
});

// Seam conformance: a composite of [nullAdapter] behaves like a no-identity adapter.
authAdapterContract(
  'CompositeAuthAdapter([null])',
  () => new CompositeAuthAdapter([nullAdapter]),
);
