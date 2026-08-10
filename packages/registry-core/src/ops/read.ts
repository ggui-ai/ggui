/**
 * `readArtifact` — pure op for `GET /pkg/{scope}/{name}/{version}`.
 * A shared op that every registry deployment projects through its
 * own transport shell.
 *
 * Flow:
 *   1. Point-read the version row via {@link RegistryStorage.getArtifactVersion}.
 *   2. Enforce row `visibility`: `private` → the caller must satisfy
 *      {@link canReadPrivateArtifact} (publisher or scope owner).
 *      Anyone else receives a response byte-identical to a true
 *      not-found — no status, code, or message distinguishes "exists
 *      but you may not read it" from "does not exist". The scope-owner
 *      lookup is lazy: it runs only for a private row whose publisher
 *      doesn't match, so public reads cost zero extra storage reads.
 *   3. Yanked → 410 with the manifest still in the body (audit-friendly).
 *      The private gate fires FIRST — an unauthorized caller never sees
 *      the 410 body.
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
import {
  canReadPrivateArtifact,
  createScopeOwnerResolver,
} from './private-read-authz.js';

export interface ReadArtifactInput {
  /**
   * `<scope>/<name>` — the install identifier. Scope MUST start
   * with `@`. Transports whose path params drop the leading `@`
   * MUST re-prepend it before calling this op.
   */
  readonly artifactId: string;
  readonly version: string;
}

export interface ReadArtifactDeps {
  readonly storage: RegistryStorage;
  /**
   * Optional — the verified caller context, produced by the
   * transport's own credential verification. When the requested row
   * is `private`, the op admits only the row's publisher or the
   * artifact's scope owner ({@link canReadPrivateArtifact}); every
   * other caller — anonymous included — gets the not-found shape.
   */
  readonly authn?: AuthnContext;
}

export type ReadArtifactResult =
  | { readonly ok: true; readonly status: 200; readonly body: ReadPkgResponse }
  | { readonly ok: false; readonly status: 410; readonly body: ReadPkgResponse }
  | {
      readonly ok: false;
      readonly status: 400 | 404 | 500;
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
    logStorageFailure('read version row', input.artifactId, err);
    return errorResult(500, 'server_error', 'failed to read package');
  }

  if (row === null) {
    return notFoundResult(input);
  }

  if (row.visibility === 'private') {
    // Ownership gate — publisher or scope owner only. The
    // unauthorized response is produced by the SAME function as a
    // true miss so the two are structurally indistinguishable. The
    // resolver is fail-closed: a storage fault during the owner
    // lookup denies (logged server-side) rather than erroring — a
    // 500 only private rows could trigger would leak existence.
    const allowed = await canReadPrivateArtifact(
      deps.authn,
      row,
      createScopeOwnerResolver(deps.storage, input.artifactId),
    );
    if (!allowed) {
      return notFoundResult(input);
    }
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
      logStorageFailure('read compiled blob', input.artifactId, err);
      return errorResult(
        500,
        'server_error',
        `failed to read compiled blob for compiledDigest=${row.compiledDigest}`,
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
  console.error(`registry read: failed to ${operation}`, {
    artifactId,
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * The one not-found projection — used for BOTH a true miss and an
 * unauthorized private read, so the two responses cannot drift apart
 * (drift would reintroduce the existence signal).
 */
function notFoundResult(input: ReadArtifactInput): ReadArtifactResult {
  return errorResult(
    404,
    'not_found',
    `package ${input.artifactId}@${input.version} not found`,
  );
}

function errorResult(
  status: 400 | 404 | 500,
  error: ReadErrorCode,
  message: string,
): ReadArtifactResult {
  return { ok: false, status, body: { error, message } };
}
