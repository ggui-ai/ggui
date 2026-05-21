/**
 * InMemoryAuthAdapter — reference implementation of {@link AuthAdapter}.
 *
 * OSS-tier semantics (§5 of the OSS split plan):
 *   - Every authenticated identity collapses to `{ kind: 'builder' }`.
 *   - Tokens are opaque strings. The adapter stores a {token → AuthResult}
 *     map; callers register tokens via {@link registerToken} / remove via
 *     {@link unregisterToken}. A pairing service composes with this
 *     adapter by registering minted tokens after `completePairing`.
 *   - Optional "dev mode": any non-empty token authenticates as builder
 *     with `source: 'dev'`. Off by default; tests that want a trivial
 *     always-on identity gate pass `devAllowAll: true`.
 *
 * The adapter never persists and never hits the network. It's safe to
 * use in tests + the OSS `@ggui-ai/mcp-server`'s zero-config mode.
 */
import type { AuthAdapter, AuthRequest, AuthResult } from '../auth-adapter.js';

export interface InMemoryAuthAdapterOptions {
  /**
   * When `true`, any non-empty token authenticates as `{kind: 'builder'}`
   * with `source: 'dev'`. Intended for local development + the happy-path
   * smoke of a fresh install; production bindings MUST leave this off.
   */
  devAllowAll?: boolean;
  /**
   * Pre-seeded tokens. Equivalent to calling {@link InMemoryAuthAdapter.registerToken}
   * for each entry. Useful for deterministic tests.
   */
  seedTokens?: Array<{ token: string; result: AuthResult }>;
}

export class InMemoryAuthAdapter implements AuthAdapter {
  private readonly tokens = new Map<string, AuthResult>();
  private readonly devAllowAll: boolean;

  constructor(opts: InMemoryAuthAdapterOptions = {}) {
    this.devAllowAll = opts.devAllowAll ?? false;
    if (opts.seedTokens) {
      for (const { token, result } of opts.seedTokens) this.tokens.set(token, result);
    }
  }

  /** Register a token. Overwrites any existing entry. */
  registerToken(token: string, result: AuthResult): void {
    this.tokens.set(token, result);
  }

  /** Remove a token. Idempotent. */
  unregisterToken(token: string): void {
    this.tokens.delete(token);
  }

  async authenticate(token: string): Promise<AuthResult | null> {
    if (!token) return null;
    const hit = this.tokens.get(token);
    if (hit) {
      // Clone so caller mutations don't alias the stored record.
      return {
        identity: hit.identity,
        source: hit.source,
        ...(hit.metadata ? { metadata: { ...hit.metadata } } : {}),
      };
    }
    if (this.devAllowAll) {
      return { identity: { kind: 'builder' }, source: 'dev' };
    }
    return null;
  }

  async getIdentity(request: AuthRequest): Promise<AuthResult | null> {
    const header = request.headers['authorization'] ?? request.headers['Authorization'];
    if (!header) {
      // Dev-allow-all is documented as "any non-empty bearer (incl.
      // no bearer) authenticates as builder" — see CLI help in
      // `serve-command.ts`. Required for MCP custom-connector hosts
      // (claude.ai) whose discovery probes send no Authorization
      // header before the OAuth flow starts; rejecting them with 401
      // surfaces as "Couldn't reach the MCP server" on the host side.
      if (this.devAllowAll) {
        return { identity: { kind: 'builder' }, source: 'dev' };
      }
      return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return null;
    return this.authenticate(match[1]!.trim());
  }
}
