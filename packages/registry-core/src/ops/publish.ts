/**
 * `publishArtifact` — pure op for `POST /publish`.
 *
 * Flow (short-circuits on first failure):
 *
 *   1.  Validate {@link AuthnContext} present (transport enforces auth
 *       before calling; this is defense-in-depth).
 *   2.  Parse + validate the manifest via `parseArtifactManifest`.
 *   3.  Decode + size-check the bundle (gadgets only).
 *   4.  Recompute SHA-384 of the bundle bytes; compare to client claim.
 *   5.  Re-run the conformance gate ({@link checkConformance}).
 *   6.  Verify the Ed25519 author signature — look up the
 *       {@link AuthorKeyRow} by `(subject, keyId)`, base64-decode the
 *       stored public key, call `verifyBundleEd25519`.
 *   7.  Insert the {@link ArtifactVersionRow} via
 *       {@link RegistryStorage.putArtifactVersionIfAbsent}. Re-publish
 *       (collision) returns 409 `version_exists`.
 *   8.  Upload the bundle + signature + manifest via
 *       {@link BundleStorage}.
 *   9.  Upsert the {@link ArtifactsMetadataRow} — only rewrites
 *       `latestVersion` when the new version is the highest semver.
 *   10. Return 201 with the wire-locked {@link PublishResponseBody}.
 */
import {
  parseArtifactManifest,
  type ArtifactManifest,
} from '@ggui-ai/artifact-manifest';
import {
  canonicalJson,
  extractSigstoreLeafCertPem,
  isGadgetSignature,
  verifyBundleEd25519,
  verifyBundleSigstore,
  type GadgetSignature,
} from '@ggui-ai/gadget-signing';
import { bundleHostScheme } from '@ggui-ai/protocol';
import { ZodError } from 'zod';
import type {
  ArtifactVersionRow,
  ArtifactsMetadataRow,
  CompiledBlobRow,
  PublishErrorBody,
  PublishErrorCode,
  PublishResponseBody,
} from '../types.js';
import type {
  BlueprintProbeRunner,
  ConformanceFailureCode,
} from './conformance.js';
import { ARTIFACTS_METADATA_SK } from '../types.js';
import type { AuthnContext } from '../interfaces/authn.js';
import type { BundleStorage } from '../interfaces/bundle-storage.js';
import type { RegistryStorage } from '../interfaces/registry-storage.js';
import { safeBase64Decode, sha384Base64 } from '../utils/base64.js';
import { compareSemver } from '../utils/semver.js';
import { compileBlueprint } from './compile.js';
import { checkConformance } from './conformance.js';

/**
 * Hard cap on the base64-DECODED bundle byte length. 5 MiB matches the
 * apigwv2 Lambda integration payload ceiling (6 MB) minus headroom for
 * the manifest + signature + JSON envelope. OSS server enforces the
 * same ceiling for parity (a cloud-published bundle MUST be installable
 * against an OSS-mirrored registry without re-bundling).
 */
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

export interface PublishArtifactInput {
  /** Unvalidated request body — the op parses + validates. */
  readonly manifest: unknown;
  /** Base64-encoded gadget bundle bytes. Required if `kind === 'gadget'`. */
  readonly bundle?: string;
  /** Base64 SHA-384 digest of the decoded bundle bytes. Client-supplied; the op re-verifies. */
  readonly bundleSha384?: string;
  /**
   * Author signature. Discriminated union over `algorithm`:
   *   - `'ed25519'`         → private-gadget path, AuthorKeys-rooted
   *     trust chain.
   *   - `'sigstore-cosign'` → public-gadget path, Fulcio cert +
   *     Rekor inclusion trust chain.
   *
   * The op dispatches on `algorithm` after the signature-shape guard.
   */
  readonly signature: GadgetSignature;
}

export interface PublishArtifactDeps {
  readonly storage: RegistryStorage;
  readonly bundleStorage: BundleStorage;
  readonly authn: AuthnContext;
  readonly clock: () => Date;
  /**
   * Hostname the install CLI talks to — embedded into the success
   * response's `installCommand`. Cloud: API Gateway custom domain (e.g.
   * `dev.registry.sandbox.ggui.ai`). OSS: `localhost:9001` etc.
   *
   * No protocol prefix — the op composes `https://` for cloud and
   * `http://` for `localhost`/`127.0.0.1`.
   */
  readonly registryHostname: string;
  /**
   * Optional runtime probe for blueprint manifests. Static gates
   * always run; the probe additionally compiles + renders the
   * blueprint default export with the manifest's fixtureProps in a
   * sandboxed Node `vm` + React server-renderer.
   *
   * Wire from `@ggui-ai/blueprint-probe` in OSS and cloud Lambda
   * environments where the runtime probe is desired. Leaving it
   * unset skips the probe — useful for the standalone conformance
   * HTTP endpoint that should not pay for react-dom.
   */
  readonly blueprintProbe?: BlueprintProbeRunner;
}

export type PublishArtifactResult =
  | { readonly ok: true; readonly status: 201; readonly body: PublishResponseBody }
  | {
      readonly ok: false;
      readonly status: 400 | 401 | 403 | 409 | 413 | 500;
      readonly body: PublishErrorBody;
    };

export async function publishArtifact(
  input: PublishArtifactInput,
  deps: PublishArtifactDeps,
): Promise<PublishArtifactResult> {
  // 1. Authn — transport enforces before calling, but defensive read.
  if (typeof deps.authn.subject !== 'string' || deps.authn.subject.length === 0) {
    return error(401, 'unauthorized', 'request is missing a verified caller subject');
  }

  // 1b. Signature shape — transport pre-decoded the JSON envelope; we
  // still validate the structured object before the cryptographic
  // path. The discriminated guard accepts both Ed25519 (private) and
  // sigstore-cosign (public) shapes; the verify-time dispatch on
  // `signature.algorithm` selects the correct trust chain.
  if (!isGadgetSignature(input.signature)) {
    return error(
      400,
      'signature_invalid',
      'request body is missing or malformed `signature` (expected Ed25519Signature or SigstoreSignature shape)',
    );
  }

  // 2. Manifest schema
  let manifest: ArtifactManifest;
  try {
    manifest = parseArtifactManifest(input.manifest);
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const path = (first?.path ?? []).map((seg) =>
        typeof seg === 'symbol' ? String(seg) : seg,
      );
      return error(
        400,
        'manifest_invalid',
        first?.message ?? 'manifest failed schema validation',
        { path, issues: err.issues },
      );
    }
    return error(
      400,
      'manifest_invalid',
      `manifest failed validation: ${errorMessage(err)}`,
    );
  }

  const artifactId = `${manifest.scope}/${manifest.name}`;
  const version = manifest.version;

  // 3. Bundle decode + size (gadgets only)
  let bundleBytes: Uint8Array | undefined;
  if (manifest.kind === 'gadget') {
    if (input.bundle === undefined || input.bundle.length === 0) {
      return error(
        400,
        'bundle_required',
        'gadget publish requires a base64-encoded `bundle` field — blueprint manifests carry source inline, but gadgets ship compiled bytes',
      );
    }
    const decoded = safeBase64Decode(input.bundle);
    if (decoded === undefined) {
      return error(400, 'manifest_invalid', '`bundle` field is not valid base64');
    }
    if (decoded.byteLength > MAX_BUNDLE_BYTES) {
      return error(
        413,
        'bundle_too_large',
        `bundle is ${decoded.byteLength} bytes; maximum is ${MAX_BUNDLE_BYTES} bytes (${MAX_BUNDLE_BYTES / (1024 * 1024)} MiB)`,
      );
    }
    bundleBytes = decoded;

    // 4. Hash check
    if (input.bundleSha384 === undefined || input.bundleSha384.length === 0) {
      return error(
        400,
        'bundle_hash_mismatch',
        'gadget publish requires `bundleSha384` (base64 SHA-384 digest of the decoded bundle bytes)',
      );
    }
    const recomputed = sha384Base64(bundleBytes);
    if (recomputed !== input.bundleSha384) {
      return error(
        400,
        'bundle_hash_mismatch',
        'server-computed SHA-384 of the bundle does not match the client-supplied `bundleSha384`',
        { expected: recomputed, received: input.bundleSha384 },
      );
    }
  }

  // 5. Conformance gate
  const conformanceBundleText =
    bundleBytes === undefined
      ? undefined
      : Buffer.from(bundleBytes.buffer, bundleBytes.byteOffset, bundleBytes.byteLength).toString(
          'utf8',
        );
  const conformanceResult = checkConformance({
    manifest,
    bundle: conformanceBundleText,
  });
  if (!conformanceResult.ok) {
    return conformanceFailureResponse(conformanceResult.errors);
  }

  // 5b. Blueprint runtime probe — opt-in via deps.blueprintProbe.
  // Static gates already accepted the manifest above; the probe runs
  // only for blueprints and only when the caller wired a runner.
  // Probe failures surface through the same `conformance_failed`
  // envelope so wire consumers don't branch on a separate error code.
  if (manifest.kind === 'blueprint' && deps.blueprintProbe !== undefined) {
    const probeResult = await deps.blueprintProbe.probe(manifest);
    if (!probeResult.ok) {
      return conformanceFailureResponse(probeResult.errors);
    }
  }

  // 6. Signature verification — dispatch on the locked discriminator.
  //
  // `authorPublicKey` is the publisher identity persisted on the
  // version row (`ArtifactVersionRow.authorPublicKey`). For Ed25519
  // it's the base64 32-byte public key; for sigstore-cosign it's
  // the leaf-cert PEM extracted from the bundle.
  const bytesForSignature =
    bundleBytes ?? new TextEncoder().encode(canonicalJson(manifest));
  let authorPublicKey: string;

  if (input.signature.algorithm === 'ed25519') {
    // Private gadgets — AuthorKeys-rooted trust chain.
    const authorKeyRow = await deps.storage.getAuthorKey(
      deps.authn.subject,
      input.signature.publicKeyId,
    );
    if (authorKeyRow === null) {
      return error(
        403,
        'unknown_key',
        `no registered AuthorKeys row for publisher \`${deps.authn.subject}\` + keyId \`${input.signature.publicKeyId}\` — run \`ggui keygen\` and register the public key before publishing`,
      );
    }

    const publicKeyBytes = safeBase64Decode(authorKeyRow.publicKeyBase64);
    if (publicKeyBytes === undefined) {
      return error(500, 'internal', 'author key row is malformed');
    }

    const verifyResult = await verifyBundleEd25519({
      bundleBytes: bytesForSignature,
      signature: input.signature,
      publicKey: publicKeyBytes,
    });
    if (!verifyResult.valid) {
      return error(400, 'signature_invalid', verifyResult.reason);
    }
    authorPublicKey = authorKeyRow.publicKeyBase64;
  } else {
    // Public gadgets — sigstore (Fulcio + Rekor) trust chain.
    // Identity claim: trust ANY valid OIDC identity at publish-time —
    // the publisher is already authenticated by the transport layer
    // ahead of this op. Install-time consumers CAN tighten via
    // `--verify-identity <pattern>` (CLI install flag); that's a
    // separate trust decision controlled by the install operator, not
    // the publisher.
    const verifyResult = await verifyBundleSigstore({
      bundleBytes: bytesForSignature,
      signature: input.signature,
    });
    if (!verifyResult.valid) {
      return error(400, 'signature_invalid', verifyResult.reason);
    }
    // Persist the leaf cert PEM on the version row so install
    // consumers can render the signer identity. The cosign-bundle
    // parsing lives in `@ggui-ai/gadget-signing` next to the verify
    // impl (single source of truth for the bundle shape).
    const leafCertPem = extractSigstoreLeafCertPem(input.signature);
    if (leafCertPem === undefined) {
      return error(
        400,
        'signature_invalid',
        'sigstore verify succeeded but bundle is missing `verificationMaterial.x509CertificateChain.certificates[0].rawBytes` — cannot pin author identity on the version row',
      );
    }
    authorPublicKey = leafCertPem;
  }

  // 6b. Blueprint compile boundary (TSX → JS).
  // Blueprints compile at publish time; the canonical compiled JS bytes
  // are stored content-addressed in {@link CompiledBlobRow} and the
  // version row only carries the digest pointer. Two-layer storage
  // gives dedup (byte-identical compiled output reuses one blob row)
  // and federation-ready content-addressable identity.
  //
  // Compile failure surfaces through the same `conformance_failed`
  // wire envelope as the static gates — same shape, same code
  // (`blueprint_compile_error`). The static gate already runs a
  // best-effort `transformSync` to catch the same class of errors;
  // this is the load-bearing run (its output is what's persisted).
  let compiledDigest: string | undefined;
  let compiledBlobToWrite: CompiledBlobRow | undefined;
  if (manifest.kind === 'blueprint') {
    const compileResult = compileBlueprint(manifest.source);
    if (!compileResult.ok) {
      return conformanceFailureResponse(
        compileResult.errors.map((e) => ({
          code: 'blueprint_compile_error' as const,
          message: e.message,
          ...(e.location !== undefined ? { detail: { location: e.location } } : {}),
        })),
      );
    }
    compiledDigest = compileResult.compiledDigest;
    compiledBlobToWrite = {
      compiledDigest: compileResult.compiledDigest,
      compiledBytes: compileResult.compiledBytes,
      compiledSize: compileResult.compiledSize,
      refCount: 1,
      // Persist the publisher's signature envelope inline on the blob
      // row so a hosted install path can re-verify without a second
      // fetch. Stored as a JSON-encoded `GadgetSignature` discriminated
      // union; the install path runs `JSON.parse` + `isGadgetSignature`
      // before dispatching to verifyBundleEd25519 / verifyBundleSigstore.
      manifestSig: JSON.stringify(input.signature),
      // compiledSig still reserved — a registry-rooted sigstore
      // signature over the compiled bytes is a future enhancement.
      createdAt: deps.clock().toISOString(),
    };
  }

  // 7. Atomic commit.
  //
  // For blueprints — version row + compiled-blob row land under one
  // logical transaction via `commitVersionAndBlob`. The DDB impl uses
  // `TransactWriteItems` so the all-or-nothing guarantee holds at the
  // service level; memory + filesystem impls get atomicity from the
  // single-threaded JS event loop.
  //
  // For gadgets — no compiled-blob row, so we still use the simple
  // conditional version-row insert. (Adding a synthetic blob row for
  // gadgets just to share the code path would widen the schema; the
  // discriminator on `kind` is cleaner.)
  //
  // Either way: the version-row conditional `attribute_not_exists` is
  // the load-bearing concurrency primitive. On conflict, return 409
  // `version_exists` immediately — the publisher's idempotent retry path.
  const nowIso = deps.clock().toISOString();
  const sriHash = bundleBytes === undefined ? undefined : `sha384-${sha384Base64(bundleBytes)}`;
  const bundleUrl =
    bundleBytes === undefined
      ? undefined
      : deps.bundleStorage.bundleUrl(manifest.scope, manifest.name, version);
  const signatureUrl =
    bundleBytes === undefined
      ? undefined
      : deps.bundleStorage.signatureUrl(manifest.scope, manifest.name, version);

  const versionRow: ArtifactVersionRow = {
    artifactId,
    version,
    manifest,
    kind: manifest.kind,
    visibility: manifest.visibility,
    bundleUrl,
    bundleSri: sriHash,
    signatureUrl,
    ...(compiledDigest !== undefined ? { compiledDigest } : {}),
    authorPublicKey,
    publishedAt: nowIso,
    publishedBy: deps.authn.subject,
  };

  if (compiledBlobToWrite !== undefined) {
    // Blueprint path — atomic two-row commit.
    let commitResult: Awaited<ReturnType<typeof deps.storage.commitVersionAndBlob>>;
    try {
      commitResult = await deps.storage.commitVersionAndBlob(versionRow, compiledBlobToWrite);
    } catch (err) {
      return error(
        500,
        'internal',
        `failed to commit version + compiled-blob rows for ${artifactId}@${version}: ${errorMessage(err)}`,
      );
    }
    if (!commitResult.ok) {
      return error(
        409,
        'version_exists',
        `${artifactId}@${version} is already published — versions are immutable. Publish a new version instead.`,
      );
    }
  } else {
    // Gadget path — single conditional version-row insert.
    const insertResult = await deps.storage.putArtifactVersionIfAbsent(versionRow);
    if (!insertResult.ok) {
      return error(
        409,
        'version_exists',
        `${artifactId}@${version} is already published — versions are immutable. Publish a new version instead.`,
      );
    }
  }

  // 8. Upload bundle + signature + manifest
  let manifestUrl: string;
  try {
    if (bundleBytes !== undefined) {
      await deps.bundleStorage.putBundle(manifest.scope, manifest.name, version, bundleBytes);
      await deps.bundleStorage.putSignature(
        manifest.scope,
        manifest.name,
        version,
        input.signature,
      );
    }
    manifestUrl = await deps.bundleStorage.putManifest(
      manifest.scope,
      manifest.name,
      version,
      manifest,
    );
  } catch (err) {
    return error(500, 'internal', `failed to upload artifact: ${errorMessage(err)}`);
  }

  // 9. Upsert Plugins metadata row.
  // Only rewrite `latestVersion` when the new version is the highest
  // semver. Race-condition note: between the get and the put, another
  // concurrent publisher could update the row. We accept rare
  // last-writer-wins on `latestVersion` — per-version row INSERT
  // remains strongly conditional, which is the load-bearing invariant.
  const existing = await deps.storage.getArtifactMetadata(artifactId);
  const shouldUpdateLatest =
    existing === null || compareSemver(version, existing.latestVersion) > 0;

  if (shouldUpdateLatest) {
    // Denormalized search field — a gadget package's primary (first)
    // export name. The package may export several hooks/components;
    // the manifest's `exports[]` is the source of truth.
    const primaryExport =
      manifest.kind === 'gadget' ? manifest.exports[0] : undefined;
    const metadataRow: ArtifactsMetadataRow = {
      artifactId,
      sk: ARTIFACTS_METADATA_SK,
      kind: manifest.kind,
      latestVersion: version,
      description: manifest.description,
      tags: manifest.tags,
      visibility: manifest.visibility,
      hook:
        primaryExport === undefined
          ? undefined
          : 'hook' in primaryExport
            ? primaryExport.hook
            : primaryExport.component,
      authorName: manifest.author?.name,
      publishedAt: nowIso,
      publishedBy: deps.authn.subject,
    };
    try {
      await deps.storage.putArtifactMetadata(metadataRow);
    } catch (err) {
      return error(500, 'internal', `failed to write Plugins metadata row: ${errorMessage(err)}`);
    }
  }

  // 10. Success
  return {
    ok: true,
    status: 201,
    body: {
      artifactId,
      version,
      manifestUrl,
      bundleUrl,
      signatureUrl,
      installCommand: buildInstallCommand(artifactId, version, deps.registryHostname, manifest.kind),
    },
  };
}

/** Compose the install command. Loopback hosts use http://; everything else https://. */
function buildInstallCommand(
  artifactId: string,
  version: string,
  registryHostname: string,
  kind: 'gadget' | 'blueprint',
): string {
  // Loopback hosts get `http://`. Symmetric with the push-time
  // `resolveGadgetUrls` resolver in `@ggui-ai/mcp-server-handlers` —
  // install + render MUST agree on scheme for local-dev / sandbox
  // workflows, otherwise the iframe blocks mixed content.
  return `ggui ${kind} install ${artifactId}@${version} --registry=${bundleHostScheme(registryHostname)}://${registryHostname}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function error(
  status: 400 | 401 | 403 | 409 | 413 | 500,
  code: PublishErrorCode,
  message: string,
  detail?: unknown,
): PublishArtifactResult {
  return {
    ok: false,
    status,
    body: detail === undefined ? { error: code, message } : { error: code, message, detail },
  };
}

/**
 * Translate a {@link ConformanceResponseBody} error list into a 400
 * `PublishArtifactResult`. Used by both the static-gate failure path
 * and the runtime-probe failure path so the wire shape is identical
 * regardless of which gate caught the issue.
 *
 * The first failure's sub-discriminator is hoisted to the wire body's
 * TOP level (alongside `error: 'conformance_failed'`) so callers can
 * branch without parsing nested JSON. The full error list stays in
 * `detail.errors` for verbose rendering.
 */
function conformanceFailureResponse(
  errors: ReadonlyArray<{ readonly code: ConformanceFailureCode; readonly message: string; readonly detail?: unknown }>,
): PublishArtifactResult {
  const conformanceFailureCode: ConformanceFailureCode | undefined = errors[0]?.code;
  const body: PublishErrorBody =
    conformanceFailureCode === undefined
      ? {
          error: 'conformance_failed',
          message: 'submission failed the registry conformance gate',
          detail: { errors },
        }
      : {
          error: 'conformance_failed',
          message: 'submission failed the registry conformance gate',
          conformanceFailureCode,
          detail: { errors },
        };
  return { ok: false, status: 400, body };
}
