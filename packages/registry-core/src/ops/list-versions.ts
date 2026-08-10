/**
 * `listArtifactVersions` — pure op for `GET /pkg/{scope}/{name}`.
 * Mirrors {@link readArtifact}'s structure — same authn injection
 * point, same storage seam, same discriminated-union result.
 *
 * Flow:
 *   1. Point-read the metadata row via {@link RegistryStorage.getArtifactMetadata}.
 *      Missing metadata → 404 (`not_found`).
 *   2. Fetch all version rows via {@link RegistryStorage.listArtifactVersions}.
 *   3. Filter out private rows the caller cannot read — the same
 *      ownership rule as the read op ({@link canReadPrivateArtifact}:
 *      publisher or scope owner). Unreadable rows are FILTERED, never
 *      errored: an unauthorized caller (anonymous or authenticated)
 *      gets the readable subset. When NOTHING is readable, the
 *      response is the SAME 404 `not_found` as a true miss — a 200
 *      `versions: []` would differ from the miss shape and that
 *      difference is an existence oracle (cf. GitHub's
 *      404-on-private-repo behaviour). The scope-owner lookup is lazy,
 *      memoized, and fail-closed ({@link createScopeOwnerResolver}):
 *      at most one {@link RegistryStorage.getScopeOwner} call per
 *      request; none when every row is public, the caller published
 *      every private row, or the caller is anonymous; a lookup fault
 *      denies instead of erroring.
 *   4. Sort by semver DESC so the latest version is first. Yanked rows
 *      are NOT filtered — they stay in the list with `yanked: true`
 *      so the UI can show "this version was yanked".
 *   5. Project the row → {@link VersionListEntry} shape (drop heavy
 *      fields: manifest, compiledDigest, manifestSig).
 *
 * **Why not gate on metadata.visibility?** A private artifact might
 * have a public version (visibility lives on every version row
 * independently). Authn-gating at the metadata level would over-block.
 * The version-by-version filter in step 3 is the precise gate.
 */
import type {
  ArtifactVersionRow,
  ListVersionsErrorBody,
  ListVersionsErrorCode,
  ListVersionsResponse,
  VersionListEntry,
} from '../types.js';
import type { AuthnContext } from '../interfaces/authn.js';
import type { RegistryStorage } from '../interfaces/registry-storage.js';
import { compareSemver } from '../utils/semver.js';
import {
  canReadPrivateArtifact,
  createScopeOwnerResolver,
} from './private-read-authz.js';

export interface ListArtifactVersionsInput {
  /**
   * `<scope>/<name>` — the install identifier. Scope MUST start
   * with `@`. Transports whose path params drop the leading `@`
   * MUST re-prepend it before calling this op.
   */
  readonly artifactId: string;
}

export interface ListArtifactVersionsDeps {
  readonly storage: RegistryStorage;
  /**
   * Optional — the verified caller context, produced by the
   * transport's own credential verification. Private versions appear
   * in the response only for the caller who published them or the
   * owner of the artifact's scope ({@link canReadPrivateArtifact});
   * every other caller — anonymous included — gets the public subset.
   */
  readonly authn?: AuthnContext;
}

export type ListArtifactVersionsResult =
  | {
      readonly ok: true;
      readonly status: 200;
      readonly body: ListVersionsResponse;
    }
  | {
      readonly ok: false;
      readonly status: 400 | 404 | 500;
      readonly body: ListVersionsErrorBody;
    };

export async function listArtifactVersions(
  input: ListArtifactVersionsInput,
  deps: ListArtifactVersionsDeps,
): Promise<ListArtifactVersionsResult> {
  if (typeof input.artifactId !== 'string' || input.artifactId.length === 0) {
    return errorResult(400, 'invalid_request', 'missing artifactId');
  }

  // Step 1 — metadata existence check. A missing metadata row is the
  // "no such artifact" signal. We rely on the publish op writing a
  // metadata row on every successful publish (idempotent upsert).
  let metadataExists = false;
  try {
    const metadata = await deps.storage.getArtifactMetadata(input.artifactId);
    metadataExists = metadata !== null;
  } catch (err) {
    logStorageFailure('read metadata', input.artifactId, err);
    return errorResult(500, 'server_error', 'failed to list versions');
  }
  if (!metadataExists) {
    return notFoundResult(input);
  }

  // Step 2 — fetch all version rows.
  let rows: readonly ArtifactVersionRow[];
  try {
    rows = await deps.storage.listArtifactVersions(input.artifactId);
  } catch (err) {
    logStorageFailure('list version rows', input.artifactId, err);
    return errorResult(500, 'server_error', 'failed to list versions');
  }

  // Step 3 — ownership filter. A private row stays in the list only
  // when the caller may read it under the shared rule (publisher or
  // scope owner). All rows share one artifactId, hence one scope —
  // the shared resolver memoizes the lazy owner lookup (one
  // getScopeOwner call at most; none for public rows / anonymous
  // callers / publisher-only matches) and fails CLOSED on a storage
  // fault (deny + server-side log, never a distinctive error status).
  const getScopeOwner = createScopeOwnerResolver(
    deps.storage,
    input.artifactId,
  );
  const visibleRows: ArtifactVersionRow[] = [];
  for (const row of rows) {
    if (
      row.visibility === 'private' &&
      !(await canReadPrivateArtifact(deps.authn, row, getScopeOwner))
    ) {
      continue;
    }
    visibleRows.push(row);
  }

  // No visible versions ⇒ answer exactly as a true miss. Emitting a
  // 200 `versions: []` here would differ from the miss shape, and
  // that difference is an existence oracle for private artifacts.
  if (visibleRows.length === 0) {
    return notFoundResult(input);
  }

  // Step 4 — semver DESC sort. `compareSemver(a, b)` returns -1/0/1
  // matching ascending order; flip the sign for DESC.
  const sorted = [...visibleRows].sort((a, b) => -compareSemver(a.version, b.version));

  // Step 5 — project to the lightweight wire shape.
  const versions: VersionListEntry[] = sorted.map(rowToEntry);

  return {
    ok: true,
    status: 200,
    body: { artifactId: input.artifactId, versions },
  };
}

function rowToEntry(row: ArtifactVersionRow): VersionListEntry {
  return {
    version: row.version,
    publishedAt: row.publishedAt,
    yanked: row.yanked === true,
    kind: row.kind,
    visibility: row.visibility,
  };
}

/**
 * The one not-found projection — used for a true miss AND an artifact
 * with no versions visible to the caller, so the two responses cannot
 * drift apart (drift would reintroduce the existence signal).
 */
function notFoundResult(
  input: ListArtifactVersionsInput,
): ListArtifactVersionsResult {
  return errorResult(404, 'not_found', `no such artifact: ${input.artifactId}`);
}

/**
 * Structured server-side failure log. Raw storage error text stays
 * OUT of wire bodies (it can carry backend identifiers a caller has
 * no business seeing); this log line is the operator's copy.
 */
function logStorageFailure(
  operation: string,
  artifactId: string,
  err: unknown,
): void {
  // eslint-disable-next-line no-console -- server-side operator signal; the wire stays generic
  console.error(`registry list-versions: failed to ${operation}`, {
    artifactId,
    error: err instanceof Error ? err.message : String(err),
  });
}

function errorResult(
  status: 400 | 404 | 500,
  error: ListVersionsErrorCode,
  message: string,
): ListArtifactVersionsResult {
  return { ok: false, status, body: { error, message } };
}
