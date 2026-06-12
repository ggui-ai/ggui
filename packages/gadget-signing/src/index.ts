/**
 * `@ggui-ai/gadget-signing` — gadget bundle signing + verification for the
 * ggui gadget marketplace.
 *
 * Two signing schemes:
 * 1. **Ed25519 author keys** (private gadgets) — full implementation. The
 *    author manages a 32-byte Ed25519 private key locally; the registry
 *    stores the public key per author identity. The publisher hashes the
 *    bundle with SHA-384, signs the hash with their private key, and
 *    uploads `bundle.js` + `bundle.js.sig`. The install CLI downloads
 *    both, looks up the author's public key, and verifies. The SRI hash
 *    on the `<script>` tag closes the loop end-to-end.
 *
 * 2. **sigstore (cosign + Rekor)** (public gadgets) — full implementation
 *    via the upstream `sigstore` package (which composes
 *    `@sigstore/sign` + `@sigstore/verify` + `@sigstore/tuf`). The
 *    publisher acquires an OIDC token out-of-band (env var or browser
 *    flow at the CLI seam), passes it in, and the `sign` call walks the
 *    keyless Fulcio + Rekor flow. The serialized cosign Bundle (per
 *    `@sigstore/bundle` v0.3 spec) becomes `SigstoreSignature.bundle`.
 *    Verification calls `sigstore.verify` which uses TUF to resolve the
 *    trust material at runtime, then enforces an optional caller-supplied
 *    identity policy.
 *
 * Cryptography for the Ed25519 path uses `@noble/ed25519` +
 * `@noble/hashes` — pure-TS, audited, browser-safe; no `node:crypto`.
 * The sigstore path uses `node:crypto` transitively through the
 * `sigstore` package, so the sigstore code path is Node-only. Ed25519
 * remains browser-safe.
 */

import { signAsync, verifyAsync, getPublicKeyAsync, utils } from "@noble/ed25519";
import { sha384, sha256 } from "@noble/hashes/sha2";
import {
  bundleFromJSON,
  bundleToJSON,
  type SerializedBundle,
} from "@sigstore/bundle";
import * as sigstoreClient from "sigstore";

// ---------------------------------------------------------------------------
// Signature shapes — the stable wire format for gadget signatures.
// ---------------------------------------------------------------------------

/** Ed25519 signature over the SHA-384 hash of a gadget bundle. */
export interface Ed25519Signature {
  readonly algorithm: "ed25519";
  /** Base64 SHA-384 digest of the bundle bytes. */
  readonly bundleSha384: string;
  /** Base64 Ed25519 signature over `bundleSha384` decoded bytes. */
  readonly signature: string;
  /** Public-key identifier — the registry's stable handle for the key. */
  readonly publicKeyId: string;
  /** ISO 8601 timestamp at signing time. */
  readonly signedAt: string;
}

/**
 * Sigstore/cosign signature.
 *
 * Carries a full serialized Sigstore bundle (per
 * `@sigstore/bundle` v0.3 spec) — including the cert chain, the
 * Rekor inclusion proof, and the messageSignature payload. Verify
 * reconstitutes via `@sigstore/verify` and runs the canonical
 * Sigstore verification flow (Fulcio cert chain + Rekor inclusion +
 * signature over the digest).
 *
 * `bundleSha384` is intentionally retained alongside the cosign
 * bundle (redundant with `messageSignature.messageDigest` inside the
 * bundle) so the server can run a fast tamper-detection pass before
 * paying for the full Sigstore-verify path.
 */
export interface SigstoreSignature {
  readonly algorithm: "sigstore-cosign";
  /** Base64 SHA-384 digest of the bundle bytes — fast tamper check. */
  readonly bundleSha384: string;
  /**
   * Serialized cosign bundle (JSON-encoded per `@sigstore/bundle`'s
   * `Bundle` schema, v0.3 mediaType
   * `application/vnd.dev.sigstore.bundle+json;version=0.3`). Opaque
   * at the wire layer; deserialized by `verifyBundleSigstore` via
   * `@sigstore/bundle`'s parser.
   */
  readonly bundle: string;
  /** ISO 8601 timestamp at signing time. */
  readonly signedAt: string;
}

/** Discriminated union of all signature shapes. */
export type GadgetSignature = Ed25519Signature | SigstoreSignature;

// ---------------------------------------------------------------------------
// Canonical type guards.
//
// The signature guards live in one canonical home so wire-shape
// changes flow uniformly to every consumer (registry publish op,
// install path). `isGadgetSignature` is the discriminated guard
// callers use at the request boundary.
// ---------------------------------------------------------------------------

/**
 * Runtime check that `value` is a well-formed {@link Ed25519Signature}.
 * Structural shape only — does NOT cryptographically verify.
 */
export function isEd25519Signature(value: unknown): value is Ed25519Signature {
  if (value === null || typeof value !== "object") return false;
  // `as Partial<Ed25519Signature>` (not `Record<string, unknown>`) is
  // the honest narrow: it makes each field optional with the correct
  // declared type, so the typeof checks below catch shape mismatches
  // without lying about what the input MAY be.
  const v = value as Partial<Ed25519Signature>;
  return (
    v.algorithm === "ed25519" &&
    typeof v.bundleSha384 === "string" &&
    typeof v.signature === "string" &&
    typeof v.publicKeyId === "string" &&
    typeof v.signedAt === "string"
  );
}

/**
 * Runtime check that `value` is a well-formed {@link SigstoreSignature}.
 * Structural shape only — does NOT cryptographically verify the embedded
 * bundle. Use {@link verifyBundleSigstore} for the full trust-chain check.
 */
export function isSigstoreSignature(value: unknown): value is SigstoreSignature {
  if (value === null || typeof value !== "object") return false;
  const v = value as Partial<SigstoreSignature>;
  return (
    v.algorithm === "sigstore-cosign" &&
    typeof v.bundleSha384 === "string" &&
    typeof v.bundle === "string" &&
    typeof v.signedAt === "string"
  );
}

/**
 * Discriminated guard over the {@link GadgetSignature} union. Use this
 * at request boundaries — switching on `value.algorithm` after the
 * guard passes narrows to the correct variant for downstream dispatch.
 */
export function isGadgetSignature(value: unknown): value is GadgetSignature {
  return isEd25519Signature(value) || isSigstoreSignature(value);
}

// ---------------------------------------------------------------------------
// Base64 helpers — browser-safe, no `node:buffer` dependency.
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  // `btoa` exists in browsers and modern Node (>=16) globals.
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canonical JSON — the bit-stable form blueprint signatures cover.
// ---------------------------------------------------------------------------

/**
 * Canonical-JSON serialization for blueprint signatures. Recursive
 * lexicographic key-sort at every nesting depth, then `JSON.stringify`.
 *
 * Lives here (not in publish/install/server) because all three sites
 * sign or verify against the same byte sequence. Any drift between
 * server-side canonicalization and CLI-side canonicalization breaks
 * blueprint signatures silently — pulling the impl into one place
 * eliminates that drift class.
 *
 * NOT RFC-8785 compliant: the v1 manifest schema doesn't carry
 * non-ASCII strings, exotic numbers, or unicode normalization
 * surfaces, so the simpler shape suffices. If a future blueprint
 * manifest grows nested objects with order-sensitive content that
 * RFC-8785 would canonicalize differently, both this function and
 * the publish + install sites need to swap to a real RFC-8785 impl
 * in lock-step.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalSort(value));
}

function canonicalSort(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalSort);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = canonicalSort(v);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public-key ID derivation — stable, deterministic.
// ---------------------------------------------------------------------------

/**
 * Derive a stable public-key identifier from a 32-byte Ed25519 public key.
 * `base64(sha256(publicKey))[:16]`. Used as the registry's stable handle
 * for a stored author public key.
 */
export function derivePublicKeyId(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(
      `derivePublicKeyId: expected 32-byte Ed25519 public key, got ${publicKey.length}`,
    );
  }
  const digest = sha256(publicKey);
  return bytesToBase64(digest).slice(0, 16);
}

/**
 * Derive the Ed25519 public key from a 32-byte private key. Deterministic
 * (Ed25519 public keys are functions of the private key). Used by the
 * publish CLI when re-reading a stored private key from disk between
 * sessions — recompute the public half rather than store both halves.
 */
export async function publicKeyFromPrivate(
  privateKey: Uint8Array,
): Promise<Uint8Array> {
  if (privateKey.length !== 32) {
    throw new Error(
      `publicKeyFromPrivate: expected 32-byte Ed25519 private key, got ${privateKey.length}`,
    );
  }
  return getPublicKeyAsync(privateKey);
}

// ---------------------------------------------------------------------------
// Ed25519 path — full implementation.
// ---------------------------------------------------------------------------

/**
 * Generate a fresh 32-byte Ed25519 keypair plus its derived `publicKeyId`.
 *
 * Use only in CLI flows (`ggui gadget keygen`) — the private key MUST be
 * stored by the author locally and NEVER uploaded to the registry.
 */
export async function generateEd25519Keypair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyId: string;
}> {
  const privateKey = utils.randomPrivateKey();
  const publicKey = await getPublicKeyAsync(privateKey);
  return {
    publicKey,
    privateKey,
    publicKeyId: derivePublicKeyId(publicKey),
  };
}

/**
 * Sign a gadget bundle with an Ed25519 author key.
 *
 * Hashes the bundle with SHA-384 and signs the digest. SHA-384 (not 512)
 * matches the SRI hash that the iframe-runtime enforces on `<script>` tags,
 * so the signature attests to the exact same digest the browser will
 * recompute at install/load time.
 */
export async function signBundleEd25519(input: {
  bundleBytes: Uint8Array;
  privateKey: Uint8Array;
  publicKeyId: string;
}): Promise<Ed25519Signature> {
  const { bundleBytes, privateKey, publicKeyId } = input;
  if (privateKey.length !== 32) {
    throw new Error(
      `signBundleEd25519: expected 32-byte Ed25519 private key, got ${privateKey.length}`,
    );
  }
  const digest = sha384(bundleBytes);
  const sigBytes = await signAsync(digest, privateKey);
  return {
    algorithm: "ed25519",
    bundleSha384: bytesToBase64(digest),
    signature: bytesToBase64(sigBytes),
    publicKeyId,
    signedAt: new Date().toISOString(),
  };
}

/** Result of a verification call. Discriminated by `valid`. */
export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Verify a gadget bundle against an Ed25519 author key.
 *
 * Checks (in order):
 * 1. Recompute SHA-384 of `bundleBytes` and confirm it matches
 *    `signature.bundleSha384`. Catches bundle tampering.
 * 2. Confirm `signature.publicKeyId === derivePublicKeyId(publicKey)`.
 *    Catches `publicKeyId` substitution (e.g., the registry returning a
 *    different author's public key alongside the original sig).
 * 3. Run the Ed25519 verify over the digest. Catches signature tampering
 *    and wrong-key cases.
 */
export async function verifyBundleEd25519(input: {
  bundleBytes: Uint8Array;
  signature: Ed25519Signature;
  publicKey: Uint8Array;
}): Promise<VerifyResult> {
  const { bundleBytes, signature, publicKey } = input;

  if (publicKey.length !== 32) {
    return {
      valid: false,
      reason: `expected 32-byte Ed25519 public key, got ${publicKey.length}`,
    };
  }

  const recomputed = sha384(bundleBytes);
  const recomputedB64 = bytesToBase64(recomputed);
  if (recomputedB64 !== signature.bundleSha384) {
    return {
      valid: false,
      reason: "bundle hash mismatch (bundleBytes tampered or wrong bundle)",
    };
  }

  const expectedKeyId = derivePublicKeyId(publicKey);
  if (expectedKeyId !== signature.publicKeyId) {
    return {
      valid: false,
      reason: `publicKeyId mismatch: signature claims '${signature.publicKeyId}', provided key derives '${expectedKeyId}'`,
    };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(signature.signature);
  } catch (err) {
    return {
      valid: false,
      reason: `malformed signature base64: ${(err as Error).message}`,
    };
  }

  let ok: boolean;
  try {
    ok = await verifyAsync(sigBytes, recomputed, publicKey);
  } catch (err) {
    return {
      valid: false,
      reason: `signature verification threw: ${(err as Error).message}`,
    };
  }

  if (!ok) {
    return { valid: false, reason: "Ed25519 signature does not verify" };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Sigstore path — full implementation.
//
// Built on the upstream `sigstore` package (which composes
// `@sigstore/sign` + `@sigstore/verify` + `@sigstore/tuf`). The high-level
// `sign()` / `verify()` entry points handle Fulcio cert issuance, Rekor
// transparency-log writes, bundle assembly, TUF-backed trust-material
// resolution, and signature verification.
//
// This module is the seam between the upstream sigstore-js shape and
// the ggui wire shape (`SigstoreSignature`). Errors from upstream are
// normalized onto a single `SigstoreSigningError` class with a small
// enumerated `code` so callers can branch deterministically.
// ---------------------------------------------------------------------------

/** Discriminated error codes thrown by {@link signBundleSigstore}. */
export type SigstoreSigningErrorCode =
  | "oidc_invalid"
  | "fulcio_error"
  | "rekor_error"
  | "unknown";

/**
 * Error class thrown by {@link signBundleSigstore} on signing failure.
 * The `code` field is enumerated so callers can route to recovery paths
 * (re-acquire OIDC token, retry against a different Rekor instance, …).
 *
 * Verification failures DO NOT throw — they project to
 * `{ valid: false, reason }` instead. Only the signing seam exposes
 * structured errors, since signing failure modes (network down, OIDC
 * expired, Rekor 5xx) drive caller retry behavior and the verification
 * seam wants the `VerifyResult` discriminator at every callsite.
 */
export class SigstoreSigningError extends Error {
  readonly code: SigstoreSigningErrorCode;
  override readonly cause?: unknown;

  constructor(code: SigstoreSigningErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "SigstoreSigningError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Input to {@link signBundleSigstore}. */
export interface SignBundleSigstoreInput {
  /** Raw gadget bundle bytes — the signature attests to these bytes. */
  readonly bundleBytes: Uint8Array;
  /**
   * Pre-acquired OIDC JWT. Caller is responsible for obtaining it
   * (env var, `--identity-token` flag, interactive browser flow) — all
   * resolved at the CLI seam, not here. Keeping the token at the call
   * site (rather than reading env in this package) keeps the signing
   * function pure + testable.
   */
  readonly identityToken: string;
  /**
   * Optional override of the Sigstore endpoint set. Defaults to the
   * production Fulcio + Rekor URLs (`sigstore.dev`). Tests pass mock
   * URLs via `@sigstore/mock`; staging traffic points at the
   * sigstaging.dev instances.
   */
  readonly endpoints?: {
    readonly fulcioURL?: string;
    readonly rekorURL?: string;
  };
}

/**
 * Sign a gadget bundle via the Sigstore keyless flow.
 *
 * 1. SHA-384 the bundle bytes (matches the Ed25519 path and the SRI hash
 *    the iframe-runtime enforces). The digest becomes the fast
 *    tamper-check payload stored in `bundleSha384`.
 * 2. Hand the bundle bytes + OIDC token to `sigstore.sign()`. Under the
 *    hood: ephemeral keypair → Fulcio short-lived signing cert tied to
 *    the OIDC identity → Rekor inclusion entry → bundle assembled.
 * 3. Serialize the bundle to JSON (per `@sigstore/bundle` v0.3 schema)
 *    and pack into `SigstoreSignature`.
 */
export async function signBundleSigstore(
  input: SignBundleSigstoreInput,
): Promise<SigstoreSignature> {
  const { bundleBytes, identityToken, endpoints } = input;

  const digest = sha384(bundleBytes);
  const bundleSha384 = bytesToBase64(digest);

  let serialized: SerializedBundle;
  try {
    serialized = await sigstoreClient.sign(Buffer.from(bundleBytes), {
      identityToken,
      ...(endpoints?.fulcioURL ? { fulcioURL: endpoints.fulcioURL } : {}),
      ...(endpoints?.rekorURL ? { rekorURL: endpoints.rekorURL } : {}),
      tlogUpload: true,
    });
  } catch (err) {
    throw classifySigstoreSigningError(err);
  }

  return {
    algorithm: "sigstore-cosign",
    bundleSha384,
    bundle: JSON.stringify(serialized),
    signedAt: new Date().toISOString(),
  };
}

/**
 * Heuristic classifier mapping upstream sigstore errors onto our
 * enumerated `SigstoreSigningErrorCode`. The upstream library throws a
 * mix of `InternalError` (network-level) and `Error` subclasses; the
 * codes attached to `InternalError` (`CA_*`, `TLOG_*`, …) are stable
 * enough to map onto our coarser categories.
 */
function classifySigstoreSigningError(err: unknown): SigstoreSigningError {
  const message = err instanceof Error ? err.message : String(err);

  // `InternalError` from `@sigstore/sign` carries a string `code` field
  // like `'CA_CREATE_SIGNING_CERTIFICATE_ERROR'` or `'TLOG_CREATE_ENTRY_ERROR'`.
  const upstreamCode =
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined;

  if (upstreamCode?.includes("IDENTITY") || /identity|oidc|jwt/i.test(message)) {
    return new SigstoreSigningError(
      "oidc_invalid",
      `OIDC identity token rejected: ${message}`,
      err,
    );
  }
  if (upstreamCode?.includes("CA_") || /fulcio/i.test(message)) {
    return new SigstoreSigningError(
      "fulcio_error",
      `Fulcio signing-cert issuance failed: ${message}`,
      err,
    );
  }
  if (upstreamCode?.includes("TLOG") || /rekor|tlog/i.test(message)) {
    return new SigstoreSigningError(
      "rekor_error",
      `Rekor transparency-log write failed: ${message}`,
      err,
    );
  }
  return new SigstoreSigningError(
    "unknown",
    `sigstore signing failed: ${message}`,
    err,
  );
}

/** Input to {@link verifyBundleSigstore}. */
export interface VerifyBundleSigstoreInput {
  /** Raw bundle bytes — must match the bytes that were signed. */
  readonly bundleBytes: Uint8Array;
  /** The signature returned by {@link signBundleSigstore}. */
  readonly signature: SigstoreSignature;
  /**
   * Optional identity-claim assertion. When present, the verifier rejects
   * bundles whose embedded Fulcio cert doesn't claim the expected OIDC
   * identity — `subject` is matched against the cert's
   * `subjectAlternativeName`. Use this to encode "publisher X is the
   * only legitimate signer" trust models at install time.
   *
   * The `subject` may be a string (literal equality, per Sigstore's
   * `certificateIdentityURI` / `certificateIdentityEmail` semantics) or
   * a RegExp (the verifier pre-validates against the deserialized
   * bundle SAN before delegating to upstream, since the upstream API
   * supports only string equality).
   */
  readonly expectedIdentity?: {
    readonly subject: string | RegExp;
    /** OIDC issuer URL (e.g. `https://token.actions.githubusercontent.com`). */
    readonly issuer?: string;
  };
  /**
   * Optional endpoint overrides — only meaningful when paired with a
   * non-prod TUF mirror. Production gadgets verify against the prod
   * Sigstore TUF root.
   */
  readonly endpoints?: { readonly fulcioURL?: string; readonly rekorURL?: string };
}

/**
 * Verify a sigstore-signed gadget bundle.
 *
 * 1. **Fast tamper check** — recompute SHA-384 of `bundleBytes` and
 *    compare to `signature.bundleSha384`. Mismatch short-circuits the
 *    full Sigstore-verify path. (Redundant with `messageDigest` inside
 *    the bundle, but cheap.)
 * 2. **Deserialize** the embedded bundle via `bundleFromJSON`.
 * 3. **RegExp identity pre-check** — when `expectedIdentity.subject` is
 *    a RegExp, walk the bundle's verification material to extract the
 *    SAN URI and assert the match here (upstream `sigstore.verify` only
 *    accepts literal strings).
 * 4. **Upstream verify** — `sigstore.verify(bundle, data, opts)` runs
 *    the full Sigstore flow: TUF trust material, Fulcio cert-chain
 *    validation, Rekor inclusion proof, signature over the digest, and
 *    (if `expectedIdentity` was provided as a string) the identity
 *    policy. Throws on any failure.
 *
 * Returns a {@link VerifyResult} discriminated by `valid` — never
 * throws on policy failure (only on programmer error like a malformed
 * `signature.bundle` JSON).
 */
export async function verifyBundleSigstore(
  input: VerifyBundleSigstoreInput,
): Promise<VerifyResult> {
  const { bundleBytes, signature, expectedIdentity } = input;

  // 1. Fast tamper check.
  const recomputed = sha384(bundleBytes);
  const recomputedB64 = bytesToBase64(recomputed);
  if (recomputedB64 !== signature.bundleSha384) {
    return {
      valid: false,
      reason: "bundle hash mismatch (bundleBytes tampered or wrong bundle)",
    };
  }

  // 2. Deserialize cosign bundle. The wire shape stores the JSON-encoded
  // bundle as a string; `bundleFromJSON` takes the parsed object.
  let parsedBundle: SerializedBundle;
  try {
    parsedBundle = JSON.parse(signature.bundle) as SerializedBundle;
  } catch (err) {
    return {
      valid: false,
      reason: `malformed bundle JSON: ${(err as Error).message}`,
    };
  }
  try {
    // Validate-only round-trip — throws ValidationError on bad shape.
    bundleToJSON(bundleFromJSON(parsedBundle));
  } catch (err) {
    return {
      valid: false,
      reason: `invalid sigstore bundle shape: ${(err as Error).message}`,
    };
  }

  // 3. RegExp identity pre-check. Upstream `sigstore.verify` accepts
  // only literal-equality identity strings, so a RegExp expectation
  // must be enforced here against the bundle's embedded SAN.
  if (expectedIdentity && expectedIdentity.subject instanceof RegExp) {
    const san = extractSANFromBundle(parsedBundle);
    if (san === undefined) {
      return {
        valid: false,
        reason:
          "expectedIdentity.subject is RegExp but bundle has no subjectAlternativeName to match against",
      };
    }
    if (!expectedIdentity.subject.test(san)) {
      return {
        valid: false,
        reason: `identity mismatch: bundle SAN '${san}' does not match expected pattern ${expectedIdentity.subject}`,
      };
    }
  }

  // 4. Run the full upstream verify.
  try {
    const verifyOpts: sigstoreClient.VerifyOptions = {};
    if (expectedIdentity) {
      if (typeof expectedIdentity.subject === "string") {
        // Use email-shaped vs URI-shaped routing per upstream's two
        // policy fields. Both enforce a SAN match.
        if (expectedIdentity.subject.includes("@")) {
          (verifyOpts as { certificateIdentityEmail?: string }).certificateIdentityEmail =
            expectedIdentity.subject;
        } else {
          (verifyOpts as { certificateIdentityURI?: string }).certificateIdentityURI =
            expectedIdentity.subject;
        }
      }
      if (expectedIdentity.issuer) {
        (verifyOpts as { certificateIssuer?: string }).certificateIssuer =
          expectedIdentity.issuer;
      }
    }
    await sigstoreClient.verify(parsedBundle, Buffer.from(bundleBytes), verifyOpts);
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: `sigstore verification failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Extract the Fulcio leaf cert's base64 raw bytes from a
 * {@link SigstoreSignature}'s serialized cosign bundle (per
 * `@sigstore/bundle` v0.3, `verificationMaterial.x509CertificateChain
 * .certificates[0].rawBytes`). Returns `undefined` if the bundle is
 * malformed or missing the cert chain.
 *
 * Lives here — next to {@link verifyBundleSigstore} — so cosign
 * bundle-format knowledge has ONE home. Registries persist the
 * returned value on the version row so install consumers can render
 * the signer identity (`@ggui-ai/registry-core`'s publish op is the
 * first-party caller).
 *
 * Walks the JSON structurally (no `@sigstore/bundle` parse) because
 * callers run it AFTER {@link verifyBundleSigstore} has already
 * validated the bundle cryptographically — this is a projection, not
 * a verification.
 */
export function extractSigstoreLeafCertPem(
  signature: SigstoreSignature,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(signature.bundle);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const verificationMaterial = (parsed as { verificationMaterial?: unknown })
    .verificationMaterial;
  if (verificationMaterial === null || typeof verificationMaterial !== "object") {
    return undefined;
  }
  const chain = (verificationMaterial as { x509CertificateChain?: unknown })
    .x509CertificateChain;
  if (chain === null || typeof chain !== "object") return undefined;
  const certificates = (chain as { certificates?: unknown }).certificates;
  if (!Array.isArray(certificates) || certificates.length === 0) return undefined;
  const leaf = certificates[0];
  if (leaf === null || typeof leaf !== "object") return undefined;
  const rawBytes = (leaf as { rawBytes?: unknown }).rawBytes;
  if (typeof rawBytes !== "string" || rawBytes.length === 0) return undefined;
  return rawBytes;
}

/**
 * Reach into a serialized sigstore Bundle and pull the
 * `subjectAlternativeName` from the embedded X.509 cert (if any). Used
 * by the RegExp-identity pre-check; production verification still goes
 * through the upstream verifier for the actual cryptographic check.
 *
 * Returns `undefined` if the bundle has no cert (e.g. publicKey-only
 * bundle) or no extractable SAN. Uses lightweight base64-DER scanning —
 * defers to the upstream verifier for the trust-chain semantics.
 */
function extractSANFromBundle(bundle: SerializedBundle): string | undefined {
  const material = bundle.verificationMaterial;
  if (!material) return undefined;

  let certB64: string | undefined;
  if ("certificate" in material && material.certificate) {
    certB64 = material.certificate.rawBytes;
  } else if (
    "x509CertificateChain" in material &&
    material.x509CertificateChain &&
    material.x509CertificateChain.certificates.length > 0
  ) {
    certB64 = material.x509CertificateChain.certificates[0]?.rawBytes;
  }
  if (!certB64) return undefined;

  // Very lightweight SAN extraction: decode DER, locate the SAN
  // extension OID (2.5.29.17), and pull the first URI/email-shaped
  // ASCII run. This is intentionally tolerant — exact parsing happens
  // in `@sigstore/verify` downstream.
  let der: Uint8Array;
  try {
    der = base64ToBytes(certB64);
  } catch {
    return undefined;
  }
  // OID 2.5.29.17 (subjectAltName) DER prefix: 06 03 55 1d 11.
  const sanOid = [0x06, 0x03, 0x55, 0x1d, 0x11];
  let idx = -1;
  for (let i = 0; i < der.length - sanOid.length; i++) {
    let match = true;
    for (let j = 0; j < sanOid.length; j++) {
      if (der[i + j] !== sanOid[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return undefined;

  // After the OID DER there's a BOOLEAN (critical, optional) then an
  // OCTET STRING wrapping a SEQUENCE of GeneralName. Scan forward for
  // the first printable ASCII run containing a URI or email shape.
  const tail = der.subarray(idx + sanOid.length);
  let buf = "";
  const uriPattern = /[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]+|[\w.+-]+@[\w.-]+/;
  for (let i = 0; i < tail.length; i++) {
    const b = tail[i]!;
    if (b >= 0x20 && b <= 0x7e) {
      buf += String.fromCharCode(b);
    } else {
      if (buf.length >= 3) {
        const m = buf.match(uriPattern);
        if (m) return m[0];
      }
      buf = "";
    }
  }
  if (buf.length >= 3) {
    const m = buf.match(uriPattern);
    if (m) return m[0];
  }
  return undefined;
}
