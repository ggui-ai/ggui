/**
 * `POST /author-keys` — register an Ed25519 public key for the
 * authenticated publisher's identity.
 *
 * Trust shape:
 *
 *   - `subject` is the verified caller identity (carried in
 *     `deps.authn`, never trusted from the request body). The publisher
 *     can only register keys under their own identity.
 *   - `keyId` is derived deterministically from the public-key bytes
 *     via {@link derivePublicKeyId} — NOT caller-supplied. Two clients
 *     registering the same key produce the same row.
 *   - `publicKeyBase64` is base64-encoded raw 32-byte Ed25519 public-
 *     key bytes. The op decodes + validates length, then writes via
 *     {@link RegistryStorage.putAuthorKey}.
 *
 * Idempotency:
 *
 *   - First write for `(subject, keyId)` → 201.
 *   - Re-register of the same row contents → 200.
 *   - Re-register with a DIFFERENT publicKey for the same keyId →
 *     409 `key_conflict`. (Hash collision is the only realistic path;
 *     SHA-256 truncation collisions on 64 bits are vanishingly rare
 *     but the failure mode is closed-form.)
 *
 * Concurrency: the op uses a conditional put via
 * {@link RegistryStorage.putAuthorKey}'s `ifNotExists: true` flag and
 * falls back to a read-then-dispatch only when the conditional put
 * rejects. This closes the TOCTOU race that an earlier
 * read-then-write flow had — two concurrent first-register requests
 * for the same `(subject, keyId)` are now serialized at the storage
 * layer, so the 409 branch is deterministically reachable on the
 * SHA-256 truncation-collision race.
 *
 * Why a server-side op rather than a client writing storage directly:
 * keeps the publisher's verified credentials the only auth surface —
 * the storage backend does not need to grant write access to end users.
 */
import { derivePublicKeyId } from '@ggui-ai/gadget-signing';
import type { AuthnContext } from '../interfaces/authn.js';
import {
  AuthorKeyAlreadyExistsError,
  type RegistryStorage,
} from '../interfaces/registry-storage.js';
import { safeBase64Decode } from '../utils/base64.js';
import type {
  AuthorKeyRow,
  RegisterAuthorKeyErrorBody,
  RegisterAuthorKeyRequestBody,
  RegisterAuthorKeyResponseBody,
} from '../types.js';

export interface RegisterAuthorKeyInput {
  readonly publicKeyBase64: string;
}

export interface RegisterAuthorKeyDeps {
  readonly storage: RegistryStorage;
  readonly authn: AuthnContext;
}

export type RegisterAuthorKeyResult =
  | {
      readonly ok: true;
      readonly status: 200 | 201;
      readonly body: RegisterAuthorKeyResponseBody;
    }
  | {
      readonly ok: false;
      readonly status: 400 | 409 | 500;
      readonly body: RegisterAuthorKeyErrorBody;
    };

const ED25519_PUBLIC_KEY_BYTES = 32;

export async function registerAuthorKey(
  input: RegisterAuthorKeyInput,
  deps: RegisterAuthorKeyDeps,
): Promise<RegisterAuthorKeyResult> {
  if (
    typeof input.publicKeyBase64 !== 'string' ||
    input.publicKeyBase64.length === 0
  ) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_request',
        message: '`publicKeyBase64` is required',
      },
    };
  }

  const decoded = safeBase64Decode(input.publicKeyBase64);
  if (decoded === undefined) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_request',
        message: '`publicKeyBase64` is not valid base64',
      },
    };
  }
  if (decoded.length !== ED25519_PUBLIC_KEY_BYTES) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_request',
        message: `\`publicKeyBase64\` must decode to ${ED25519_PUBLIC_KEY_BYTES} raw bytes (got ${decoded.length})`,
      },
    };
  }

  const keyId = derivePublicKeyId(decoded);
  const subject = deps.authn.subject;
  const row: AuthorKeyRow = {
    subject,
    keyId,
    publicKeyBase64: input.publicKeyBase64,
  };

  // Atomic first-write attempt. The `ifNotExists` flag tells the
  // storage adapter to use a conditional put (a DDB
  // `attribute_not_exists(...)` condition on a hosted backend, an
  // in-memory map-key check for the OSS impl). On success → 201. On
  // conflict → storage throws {@link AuthorKeyAlreadyExistsError};
  // re-read and dispatch same-publicKey → 200 vs different-publicKey
  // → 409.
  //
  // This closes the TOCTOU race the prior read-then-write flow had:
  // two concurrent first-register requests both saw `null` on
  // `getAuthorKey` and both unconditionally put → last-writer-wins.
  // Same-publicKey races are still harmless idempotent re-writes; the
  // ≈2^-64 SHA-256-first-16-chars-collision race hits the 409 branch
  // deterministically rather than silently overwriting the first row.
  try {
    await deps.storage.putAuthorKey(row, { ifNotExists: true });
    return {
      ok: true,
      status: 201,
      body: {
        subject,
        keyId,
        publicKeyBase64: input.publicKeyBase64,
      },
    };
  } catch (err) {
    if (!(err instanceof AuthorKeyAlreadyExistsError)) {
      return {
        ok: false,
        status: 500,
        body: {
          error: 'server_error',
          message: 'failed to write AuthorKey row',
        },
      };
    }
    // Conditional-put rejected — a row already exists for
    // `(subject, keyId)`. Read it back and dispatch.
  }

  let existing;
  try {
    existing = await deps.storage.getAuthorKey(subject, keyId);
  } catch {
    return {
      ok: false,
      status: 500,
      body: {
        error: 'server_error',
        message: 'failed to read existing AuthorKey row',
      },
    };
  }

  if (existing === null) {
    // The conditional put failed but no row is visible on read-back.
    // This means a concurrent writer landed AND then a concurrent
    // deleter removed the row, OR a non-atomic storage backend has
    // diverged. Either way the safest answer is 500 — caller should
    // retry.
    return {
      ok: false,
      status: 500,
      body: {
        error: 'server_error',
        message:
          'AuthorKey row vanished between conditional put and idempotency read-back',
      },
    };
  }

  if (existing.publicKeyBase64 === input.publicKeyBase64) {
    return {
      ok: true,
      status: 200,
      body: {
        subject: existing.subject,
        keyId: existing.keyId,
        publicKeyBase64: existing.publicKeyBase64,
      },
    };
  }
  return {
    ok: false,
    status: 409,
    body: {
      error: 'key_conflict',
      message: `an AuthorKey for (subject=${subject}, keyId=${keyId}) already exists with a different publicKey — derivePublicKeyId collision or stale row?`,
    },
  };
}

// Re-export wire shapes alongside the op so downstream consumers
// (Lambda handler, OSS server, CLI api-client) only need one import.
export type {
  RegisterAuthorKeyErrorBody,
  RegisterAuthorKeyRequestBody,
  RegisterAuthorKeyResponseBody,
};
