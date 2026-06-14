/**
 * Runs an ordered list of AuthAdapters; the first non-null result wins.
 * Vendor-neutral composition primitive — lets a deployment accept more
 * than one identity source (e.g. native API keys AND a federated OIDC
 * issuer) without baking either into the server. registerToken/
 * unregisterToken delegate to the first adapter that implements them.
 */
import type { AuthAdapter, AuthRequest, AuthResult } from './auth-adapter.js';

export class CompositeAuthAdapter implements AuthAdapter {
  constructor(private readonly adapters: readonly AuthAdapter[]) {}

  async authenticate(token: string): Promise<AuthResult | null> {
    for (const a of this.adapters) {
      const r = await a.authenticate(token);
      if (r) return r;
    }
    return null;
  }

  async getIdentity(request: AuthRequest): Promise<AuthResult | null> {
    for (const a of this.adapters) {
      const r = await a.getIdentity(request);
      if (r) return r;
    }
    return null;
  }

  registerToken(token: string, result: AuthResult): void {
    for (const a of this.adapters) {
      if (typeof a.registerToken === 'function') {
        a.registerToken(token, result);
        return;
      }
    }
  }

  unregisterToken(token: string): void {
    for (const a of this.adapters) {
      if (typeof a.unregisterToken === 'function') {
        a.unregisterToken(token);
        return;
      }
    }
  }
}
