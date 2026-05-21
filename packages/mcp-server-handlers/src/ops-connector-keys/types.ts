/**
 * Seam types for the `ops-connector-keys` MCP tool family. Mirrors
 * the `GguiUserApiKey` records that back the console's Connector
 * Keys section.
 *
 * "Connector key" = the user-facing `ggui_user_*` API key string. The
 * Connector (Claude Desktop / claude.ai) holds one of these to call
 * the MCP routes on the user's behalf. Pure over `@ggui-ai/protocol`
 * shapes — NO AWS / database imports.
 */

/**
 * Slim metadata shape returned by `list` + `issue`. NEVER carries the
 * plaintext secret on `list`; `issue` returns plaintext exactly once
 * (one-time reveal), then never again.
 */
export interface ConnectorKeySummary {
  /** Stable id for revoke/rename operations. */
  readonly id: string;
  /** First ~8 chars of the secret part — human-readable identifier. */
  readonly apiKeyPrefix: string;
  /** User-supplied label. */
  readonly name?: string;
  /** Optional FK to a `GguiApp` — when set the key locks to that app. */
  readonly appId?: string;
  /** `'active'` | `'revoked'`. */
  readonly status: 'active' | 'revoked';
  /** ISO timestamp. */
  readonly createdAt: string;
  /** ISO timestamp from the last successful auth lookup. */
  readonly lastUsedAt?: string;
  /** ISO expiry, when set. Past timestamp → adapter rejects auth. */
  readonly expiresAt?: string;
}

export interface IssueConnectorKeyResult {
  /** Same shape as a `list` row. */
  readonly summary: ConnectorKeySummary;
  /**
   * Plaintext `ggui_user_*` secret — ONE-TIME REVEAL on the issue
   * call. Subsequent list responses NEVER carry this. The MCP caller
   * (Claude Desktop conversation, console) MUST surface it
   * immediately for the user to copy; we don't store it.
   */
  readonly plaintextKey: string;
}

/**
 * Read+write seam for `GguiUserApiKey`. Cloud pod implements this
 * against the dedicated `issueGguiUserApiKey` AppSync mutation +
 * `apiKeysByUserId` GSI + raw DDB UpdateItem for revoke; tests use
 * in-memory state.
 *
 * Invariants:
 *   - `list(ownerSub)` returns only the caller's rows (scoped by
 *     `userId == ownerSub`).
 *   - `issue` mints `ggui_user_<random>`, persists `sha256(plaintext)`
 *     hex + first 8 plaintext chars, returns the plaintext exactly
 *     ONCE on the result. NEVER persists plaintext.
 *   - `revoke` is idempotent — re-revoking a `revoked` row returns the
 *     same row with `alreadyRevoked: true`. Cross-user revoke is
 *     rejected with `ConnectorKeyAccessDeniedError`.
 */
export interface ConnectorKeysSource {
  list(ownerSub: string): Promise<readonly ConnectorKeySummary[]>;
  issue(args: {
    ownerSub: string;
    name?: string;
    appId?: string;
    expiresAt?: string;
  }): Promise<IssueConnectorKeyResult>;
  revoke(args: {
    ownerSub: string;
    keyId: string;
  }): Promise<{ summary: ConnectorKeySummary; alreadyRevoked: boolean }>;
}

export class ConnectorKeyAccessDeniedError extends Error {
  readonly code = 'connector_key_access_denied' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorKeyAccessDeniedError';
  }
}

export class ConnectorKeyNotFoundError extends Error {
  readonly code = 'connector_key_not_found' as const;
  constructor(keyId: string) {
    super(
      `connector_key_not_found: no key ${JSON.stringify(keyId)} reachable by the caller`,
    );
    this.name = 'ConnectorKeyNotFoundError';
  }
}
