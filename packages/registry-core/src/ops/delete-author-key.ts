/**
 * `deleteAuthorKey` — pure op for `DELETE /author-keys/{keyId}`.
 *
 * Hard-deletes the `(subject, keyId)` row under the VERIFIED caller
 * identity. Like {@link listAuthorKeys} there is no anonymous branch —
 * transports MUST 401 before calling this op when the bearer
 * credential is missing or invalid.
 *
 * Semantics (see {@link DeleteAuthorKeyResponseBody}):
 *
 *   - Idempotent: an absent keyId is a 200 with `deleted: false`, not
 *     an error — retries and double-clicks converge.
 *   - Subject-scoped: the delete only ever addresses the caller's own
 *     partition. A keyId registered by ANOTHER subject is untouched
 *     and the response is byte-identical to the plain-absent case, so
 *     key existence never leaks across accounts.
 *   - Forward-only: removal blocks FUTURE publishes signed with this
 *     key. Versions already published stay valid — their signing key
 *     is pinned per version at publish time, which this delete never
 *     touches.
 */
import type {
  DeleteAuthorKeyErrorBody,
  DeleteAuthorKeyResponseBody,
} from '../types.js';
import type { AuthnContext } from '../interfaces/authn.js';
import type { RegistryStorage } from '../interfaces/registry-storage.js';

export interface DeleteAuthorKeyInput {
  /** The keyId path segment — `derivePublicKeyId` output, non-empty. */
  readonly keyId: string;
}

export interface DeleteAuthorKeyDeps {
  readonly storage: RegistryStorage;
  /** REQUIRED — the verified caller identity. No anonymous branch. */
  readonly authn: AuthnContext;
}

export type DeleteAuthorKeyResult =
  | {
      readonly ok: true;
      readonly status: 200;
      readonly body: DeleteAuthorKeyResponseBody;
    }
  | {
      readonly ok: false;
      readonly status: 400 | 500;
      readonly body: DeleteAuthorKeyErrorBody;
    };

export async function deleteAuthorKey(
  input: DeleteAuthorKeyInput,
  deps: DeleteAuthorKeyDeps,
): Promise<DeleteAuthorKeyResult> {
  if (typeof input.keyId !== 'string' || input.keyId.length === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_request',
        message: '`keyId` path segment is required',
      },
    };
  }

  let deleted: boolean;
  try {
    deleted = await deps.storage.deleteAuthorKey(deps.authn.subject, input.keyId);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      body: {
        error: 'server_error',
        message: `failed to delete author key: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  return {
    ok: true,
    status: 200,
    body: { keyId: input.keyId, deleted },
  };
}

// Re-export wire shapes alongside the op so downstream consumers
// (server transports, web clients) only need one import.
export type { DeleteAuthorKeyErrorBody, DeleteAuthorKeyResponseBody };
