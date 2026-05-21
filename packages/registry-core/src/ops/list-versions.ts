/**
 * `listArtifactVersions` — pure op for `GET /pkg/{scope}/{name}`.
 * Mirrors {@link readArtifact}'s structure — same authn injection
 * point, same storage seam, same discriminated-union result.
 *
 * Flow:
 *   1. Point-read the metadata row via {@link RegistryStorage.getArtifactMetadata}.
 *      Missing metadata → 404 (`not_found`).
 *   2. Fetch all version rows via {@link RegistryStorage.listArtifactVersions}.
 *   3. Filter out private rows for unauthenticated callers — same gate
 *      as the read op's `visibility === 'private' && authn === undefined`
 *      branch. We do NOT 403 on a fully-private artifact for an unauthed
 *      caller; we 200 with `versions: []` so the wire response doesn't
 *      leak the existence of a private artifact (cf. GitHub's 404-on-
 *      private-repo behaviour).
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

export interface ListArtifactVersionsInput {
  /**
   * `<scope>/<name>` — the install identifier. Scope MUST start with `@`.
   * Cloud API Gateway path params drop the leading `@`; the cloud
   * Lambda shell re-prepends before calling this op.
   */
  readonly artifactId: string;
}

export interface ListArtifactVersionsDeps {
  readonly storage: RegistryStorage;
  /**
   * Optional — when undefined, the op filters `private` versions OUT
   * of the response. Authenticated callers see every version they own
   * (the storage layer's row-level visibility filter is the source of
   * truth; this op just honours it).
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
    return errorResult(
      500,
      'server_error',
      `failed to read metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!metadataExists) {
    return errorResult(
      404,
      'not_found',
      `no such artifact: ${input.artifactId}`,
    );
  }

  // Step 2 — fetch all version rows.
  let rows: readonly ArtifactVersionRow[];
  try {
    rows = await deps.storage.listArtifactVersions(input.artifactId);
  } catch (err) {
    return errorResult(
      500,
      'server_error',
      `failed to list versions: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 3 — visibility filter. Unauthed callers see only public rows;
  // authed callers see everything (finer org-membership gating is a
  // future concern — for now, "authed" === "can see your own private
  // rows" is captured by the verified caller subject being non-null).
  const visibleRows: ArtifactVersionRow[] = [];
  for (const row of rows) {
    if (row.visibility === 'private' && deps.authn === undefined) continue;
    visibleRows.push(row);
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

function errorResult(
  status: 400 | 404 | 500,
  error: ListVersionsErrorCode,
  message: string,
): ListArtifactVersionsResult {
  return { ok: false, status, body: { error, message } };
}
