/**
 * `listAuthorKeys` — pure op for `GET /author-keys`.
 *
 * Lists every signing key registered under the VERIFIED caller
 * identity. Unlike the read/list-versions ops there is no anonymous
 * branch: "my keys" has no public projection, so `deps.authn` is
 * required — transports MUST 401 before calling this op when the
 * bearer credential is missing or invalid.
 *
 * Ordering: newest first by `createdAt` (ISO strings compare
 * lexicographically === chronologically), rows without `createdAt`
 * (registered before the display enrichment) last, `keyId` tie-break —
 * deterministic across storage impls whose list order is arbitrary.
 */
import type {
  AuthorKeyListEntry,
  AuthorKeyRow,
  ListAuthorKeysErrorBody,
  ListAuthorKeysResponseBody,
} from '../types.js';
import type { AuthnContext } from '../interfaces/authn.js';
import type { RegistryStorage } from '../interfaces/registry-storage.js';

export interface ListAuthorKeysDeps {
  readonly storage: RegistryStorage;
  /** REQUIRED — the verified caller identity. No anonymous branch. */
  readonly authn: AuthnContext;
}

export type ListAuthorKeysResult =
  | {
      readonly ok: true;
      readonly status: 200;
      readonly body: ListAuthorKeysResponseBody;
    }
  | {
      readonly ok: false;
      readonly status: 500;
      readonly body: ListAuthorKeysErrorBody;
    };

export async function listAuthorKeys(
  deps: ListAuthorKeysDeps,
): Promise<ListAuthorKeysResult> {
  const subject = deps.authn.subject;

  let rows: readonly AuthorKeyRow[];
  try {
    rows = await deps.storage.listAuthorKeys(subject);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      body: {
        error: 'server_error',
        message: `failed to list author keys: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const sorted = [...rows].sort(compareNewestFirst);
  return {
    ok: true,
    status: 200,
    body: { subject, keys: sorted.map(rowToEntry) },
  };
}

function compareNewestFirst(a: AuthorKeyRow, b: AuthorKeyRow): number {
  if (a.createdAt !== undefined && b.createdAt !== undefined) {
    const byCreated = b.createdAt.localeCompare(a.createdAt);
    if (byCreated !== 0) return byCreated;
  } else if (a.createdAt !== undefined) {
    return -1;
  } else if (b.createdAt !== undefined) {
    return 1;
  }
  return a.keyId.localeCompare(b.keyId);
}

function rowToEntry(row: AuthorKeyRow): AuthorKeyListEntry {
  return {
    keyId: row.keyId,
    publicKeyBase64: row.publicKeyBase64,
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
    ...(row.label !== undefined ? { label: row.label } : {}),
  };
}

// Re-export wire shapes alongside the op so downstream consumers
// (server transports, web clients) only need one import.
export type { ListAuthorKeysErrorBody, ListAuthorKeysResponseBody };
