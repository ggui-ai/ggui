/**
 * Contract test factory for {@link AuthAdapter} implementations.
 *
 * Normative semantics covered:
 *   - `authenticate` on an unknown token returns `null`.
 *   - `authenticate` on a known token returns a well-formed AuthResult.
 *   - `getIdentity` reads `Authorization: Bearer <token>` (case-insensitive
 *     header key), rejects non-Bearer schemes, returns null when the
 *     header is absent.
 *
 * Adapters that accept pre-registered tokens pass a `seeder` so the
 * contract can exercise the `authenticate-hit` path. Adapters without
 * a "register token" affordance (e.g. OIDC) omit the seeder and those
 * tests skip.
 */
import { describe, expect, it } from 'vitest';
import type { AuthAdapter, AuthResult } from '../auth-adapter.js';

export interface AuthAdapterContractOptions {
  /**
   * Register `token → result` on the freshly-constructed adapter.
   * Omit if the adapter can't accept ad-hoc tokens (the token-hit
   * tests are then skipped, not failed).
   */
  seed?: (adapter: AuthAdapter, token: string, result: AuthResult) => void;
}

export function authAdapterContract(
  label: string,
  makeAdapter: () => Promise<AuthAdapter> | AuthAdapter,
  opts: AuthAdapterContractOptions = {},
): void {
  describe(`AuthAdapter contract — ${label}`, () => {
    it('authenticate on an unknown token returns null', async () => {
      const a = await makeAdapter();
      await expect(a.authenticate('not-a-real-token')).resolves.toBeNull();
    });

    it('authenticate on empty string returns null', async () => {
      const a = await makeAdapter();
      await expect(a.authenticate('')).resolves.toBeNull();
    });

    it('getIdentity with no Authorization header returns null', async () => {
      const a = await makeAdapter();
      await expect(
        a.getIdentity({ headers: {}, remoteAddress: '127.0.0.1' }),
      ).resolves.toBeNull();
    });

    it('getIdentity rejects non-Bearer schemes', async () => {
      const a = await makeAdapter();
      await expect(
        a.getIdentity({ headers: { authorization: 'Basic abc' } }),
      ).resolves.toBeNull();
    });

    if (opts.seed) {
      const seed = opts.seed;

      it('authenticate on a seeded token returns the registered result', async () => {
        const a = await makeAdapter();
        seed(a, 'tok-1', { identity: { kind: 'builder' }, source: 'dev' });
        const result = await a.authenticate('tok-1');
        expect(result).not.toBeNull();
        expect(result?.identity.kind).toBe('builder');
        expect(result?.source).toBe('dev');
      });

      it('getIdentity reads Authorization: Bearer <token>', async () => {
        const a = await makeAdapter();
        seed(a, 'tok-1', { identity: { kind: 'builder' }, source: 'pairing' });
        const result = await a.getIdentity({
          headers: { authorization: 'Bearer tok-1' },
        });
        expect(result?.identity.kind).toBe('builder');
        expect(result?.source).toBe('pairing');
      });

      it('getIdentity header key is case-insensitive', async () => {
        const a = await makeAdapter();
        seed(a, 'tok-1', { identity: { kind: 'builder' }, source: 'dev' });
        const result = await a.getIdentity({
          headers: { Authorization: 'Bearer tok-1' },
        });
        expect(result?.identity.kind).toBe('builder');
      });
    }
  });
}
