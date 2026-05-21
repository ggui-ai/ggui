/**
 * `readArtifact` — pure op for `GET /pkg/{scope}/{name}/{version}`.
 * A shared op that both this server and the hosted registry project
 * through their respective transport shells.
 *
 * Flow:
 *   1. Point-read the version row via {@link RegistryStorage.getArtifactVersion}.
 *   2. Enforce row `visibility`: `private` → require an {@link AuthnContext}.
 *   3. Yanked → 410 with the manifest still in the body (audit-friendly).
 *   4. For blueprints, resolve the {@link CompiledBlobRow} via
 *      `row.compiledDigest` (two-layer content-addressed storage). A
 *      missing blob when the pointer is set is a critical storage
 *      inconsistency — the op returns 500 rather than silently
 *      omitting `compiledBytes`.
 *   5. Project the row + blob into the {@link ReadPkgResponse} wire shape.
 */
import type {
  ArtifactVersionRow,
  CompiledBlobRow,
  ReadErrorBody,
  ReadErrorCode,
  ReadPkgResponse,
} from '../types.js';
import type { AuthnContext } from '../interfaces/authn.js';
import type { RegistryStorage } from '../interfaces/registry-storage.js';

export interface ReadArtifactInput {
  /**
   * `<scope>/<name>` — the install identifier. Scope MUST start with `@`.
   * Cloud API Gateway path params drop the leading `@`; the cloud
   * Lambda shell re-prepends before calling this op.
   */
  readonly artifactId: string;
  readonly version: string;
}

export interface ReadArtifactDeps {
  readonly storage: RegistryStorage;
  /**
   * Optional — when undefined, the op rejects `private` rows with 403.
   * Cloud transport extracts from the JWT authorizer; OSS extracts from
   * the bearer authn middleware.
   */
  readonly authn?: AuthnContext;
}

export type ReadArtifactResult =
  | { readonly ok: true; readonly status: 200; readonly body: ReadPkgResponse }
  | { readonly ok: false; readonly status: 410; readonly body: ReadPkgResponse }
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 404 | 500;
      readonly body: ReadErrorBody;
    };

export async function readArtifact(
  input: ReadArtifactInput,
  deps: ReadArtifactDeps,
): Promise<ReadArtifactResult> {
  if (typeof input.artifactId !== 'string' || input.artifactId.length === 0) {
    return errorResult(400, 'invalid_request', 'missing artifactId');
  }
  if (typeof input.version !== 'string' || input.version.length === 0) {
    return errorResult(400, 'invalid_request', 'missing version');
  }

  let row: ArtifactVersionRow | null;
  try {
    row = await deps.storage.getArtifactVersion(input.artifactId, input.version);
  } catch (err) {
    return errorResult(
      500,
      'server_error',
      `failed to read package: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (row === null) {
    return errorResult(
      404,
      'not_found',
      `package ${input.artifactId}@${input.version} not found`,
    );
  }

  if (row.visibility === 'private' && deps.authn === undefined) {
    return errorResult(403, 'forbidden', 'private package requires authentication');
  }

  // Two-layer resolution — blueprint rows carry a pointer into the
  // compiled-blob table. Yanked rows still resolve so the 410
  // response keeps the manifest body informative; install paths
  // gate on yanked status independently.
  let compiledBlob: CompiledBlobRow | null = null;
  if (typeof row.compiledDigest === 'string' && row.compiledDigest.length > 0) {
    try {
      compiledBlob = await deps.storage.getCompiledBlob(row.compiledDigest);
    } catch (err) {
      return errorResult(
        500,
        'server_error',
        `failed to read compiled blob for compiledDigest=${row.compiledDigest}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (compiledBlob === null) {
      // CRITICAL — version row points at a digest with no blob.
      // Should never happen if publish succeeded; surface loudly.
      return errorResult(
        500,
        'server_error',
        `version row points at compiledDigest=${row.compiledDigest} but no compiled-blob row exists`,
      );
    }
  }

  const body = rowToResponse(row, compiledBlob);

  if (row.yanked === true) {
    return { ok: false, status: 410, body };
  }

  return { ok: true, status: 200, body };
}

function rowToResponse(
  row: ArtifactVersionRow,
  compiledBlob: CompiledBlobRow | null,
): ReadPkgResponse {
  return {
    manifest: row.manifest,
    bundleUrl: row.bundleUrl,
    bundleSri: row.bundleSri,
    signatureUrl: row.signatureUrl,
    compiledDigest: row.compiledDigest,
    compiledBytes: compiledBlob?.compiledBytes,
    authorPublicKey: row.authorPublicKey,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
  };
}

function errorResult(
  status: 400 | 403 | 404 | 500,
  error: ReadErrorCode,
  message: string,
): ReadArtifactResult {
  return { ok: false, status, body: { error, message } };
}
