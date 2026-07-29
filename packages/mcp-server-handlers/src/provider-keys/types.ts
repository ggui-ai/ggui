/**
 * Seam types for the bring-your-own-key provider-key MCP tools —
 * pure over `@ggui-ai/protocol` shapes, no AWS / KMS / database
 * imports. Lets the handler factories live in this open package
 * while a cloud deployment binds an AWS-backed implementation.
 *
 * The four supported providers are constants of the protocol; the
 * MCP tool surface MUST agree with the provider enum on the stored
 * `GguiUserProviderKey` record.
 */

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'openrouter';

export const SUPPORTED_PROVIDERS: readonly ProviderName[] = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
];

export function isProviderName(value: unknown): value is ProviderName {
  return (
    typeof value === 'string' &&
    (SUPPORTED_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Slim metadata shape returned by `list` + `set`. NEVER carries
 * plaintext, NEVER carries the encrypted ciphertext blob.
 */
export interface ProviderKeySummary {
  provider: ProviderName;
  /** Optional human label set by the caller. */
  label?: string;
  /** Last 4 chars of the plaintext, for re-identification. */
  lastFour: string;
  /** ISO timestamp when this key was set. */
  createdAt?: string;
  /**
   * ISO timestamp updated by the resolver on the LLM-call path
   * (best-effort). Surfaces "last seen" in console + this MCP tool.
   */
  lastUsedAt?: string;
}

export interface SetProviderKeyInput {
  userId: string;
  provider: ProviderName;
  plaintextKey: string;
  label?: string;
}

export interface RemoveResult {
  deleted: boolean;
  provider: ProviderName;
}

/**
 * BYOK key-store seam. The pod implements this against raw
 * DynamoDB + KMS; tests can implement it against in-memory state.
 *
 * Invariants every implementation MUST honor:
 *   - `set` validates the plaintext against the provider's verify
 *     endpoint BEFORE persistence (provider-attributable error on
 *     reject).
 *   - `set` returns `lastFour` derived from the plaintext, NEVER
 *     plaintext. The plaintext exits the implementation only via
 *     the LLM-call path, never via a tool result.
 *   - `list` is scoped to the caller's userId — the implementation
 *     does NOT leak rows from other users.
 *   - `remove` is idempotent; `deleted: false` reports "no row to
 *     remove" (a success state, not an error).
 */
export interface ProviderKeyStore {
  list(userId: string): Promise<readonly ProviderKeySummary[]>;
  set(input: SetProviderKeyInput): Promise<ProviderKeySummary>;
  remove(args: { userId: string; provider: ProviderName }): Promise<RemoveResult>;
}

/**
 * OPTIONAL app-scoped sibling of {@link ProviderKeyStore} — keys that
 * apply to a single app instead of the caller's whole account. Bound
 * only where the deployment stores per-app keys; when unbound, the
 * set/remove handlers reject an `appId` argument with
 * {@link AppScopedKeysUnavailableError}.
 *
 * Invariants every implementation MUST honor, on top of the
 * account-scope store's plaintext discipline:
 *   - Both methods verify `ownerSub` owns `appId` BEFORE any key
 *     work, and throw {@link AppScopedKeyAppNotFoundError} when the
 *     app is missing OR owned by someone else — one uniform shape,
 *     no existence leak.
 *   - `set` validates the plaintext against the provider's verify
 *     endpoint BEFORE persistence and NEVER returns plaintext.
 *   - `remove` is idempotent; `deleted: false` reports "no row to
 *     remove" (a success state, not an error).
 */
export interface AppScopedProviderKeyStore {
  set(input: {
    ownerSub: string;
    appId: string;
    provider: ProviderName;
    plaintextKey: string;
    label?: string;
  }): Promise<ProviderKeySummary>;
  remove(args: {
    ownerSub: string;
    appId: string;
    provider: ProviderName;
  }): Promise<RemoveResult>;
}

/**
 * Thrown when an `appId` argument reaches a deployment that has no
 * app-scoped key store bound. Deployment-neutral wording — the field
 * is part of the shared wire schema everywhere, availability is not.
 */
export class AppScopedKeysUnavailableError extends Error {
  readonly code = 'app_scoped_keys_unavailable' as const;
  constructor(toolName: string) {
    super(
      `app_scoped_keys_unavailable: ${toolName} — this deployment does not support app-scoped provider keys. Omit appId to manage the account-level key.`,
    );
    this.name = 'AppScopedKeysUnavailableError';
  }
}

/**
 * Uniform "not found" for app-scoped key operations whose target app
 * is missing OR owned by another user — one shape, no existence leak.
 */
export class AppScopedKeyAppNotFoundError extends Error {
  readonly code = 'app_not_found' as const;
  constructor(appId: string) {
    super(`app_not_found: no app ${JSON.stringify(appId)} for the calling user`);
    this.name = 'AppScopedKeyAppNotFoundError';
  }
}
