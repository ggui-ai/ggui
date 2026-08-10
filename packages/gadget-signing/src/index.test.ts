import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  derivePublicKeyId,
  extractSigstoreLeafCertPem,
  extractSigstoreSANs,
  generateEd25519Keypair,
  signBundleEd25519,
  signBundleSigstore,
  SigstoreSigningError,
  verifyBundleEd25519,
  verifyBundleSigstore,
  type Ed25519Signature,
  type SigstoreSignature,
} from "./index.js";
import {
  startSigstoreMockStack,
  type SigstoreMockStack,
} from "./testing/index.js";

/**
 * Build a deterministic byte buffer so we can test deterministic-signature
 * properties without depending on randomness.
 */
function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

describe("generateEd25519Keypair", () => {
  it("returns 32-byte private + 32-byte public + 16-char publicKeyId", async () => {
    const kp = await generateEd25519Keypair();
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey.length).toBe(32);
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.publicKeyId).toMatch(/^.{16}$/);
  });

  it("produces distinct keypairs across calls", async () => {
    const a = await generateEd25519Keypair();
    const b = await generateEd25519Keypair();
    expect(a.publicKeyId).not.toBe(b.publicKeyId);
  });
});

describe("derivePublicKeyId", () => {
  it("is stable for the same public key", async () => {
    const kp = await generateEd25519Keypair();
    expect(derivePublicKeyId(kp.publicKey)).toBe(kp.publicKeyId);
    expect(derivePublicKeyId(kp.publicKey)).toBe(derivePublicKeyId(kp.publicKey));
  });

  it("emits base64url ids — URL-safe alphabet, never + / = ([E] structural ruling)", () => {
    // keyIds travel as URL path segments (DELETE /author-keys/{keyId})
    // and as filesystem row-key components. Standard base64 puts '/'
    // in ~22% of ids, which breaks both. 64 deterministic inputs make
    // an accidental all-clean pass under a standard-base64 impl
    // vanishingly unlikely (~1e-14) while the base64url alphabet is
    // guaranteed by construction.
    for (let i = 0; i < 64; i++) {
      const publicKey = new Uint8Array(32).fill(i);
      expect(derivePublicKeyId(publicKey)).toMatch(/^[A-Za-z0-9_-]{16}$/);
    }
  });

  it("rejects non-32-byte input", () => {
    expect(() => derivePublicKeyId(bytes(1, 2, 3))).toThrow(/32-byte/);
  });
});

describe("signBundleEd25519 + verifyBundleEd25519", () => {
  it("roundtrips successfully (happy path)", async () => {
    const kp = await generateEd25519Keypair();
    const bundle = new TextEncoder().encode("export const wrapper = () => 'hi';");

    const signature = await signBundleEd25519({
      bundleBytes: bundle,
      privateKey: kp.privateKey,
      publicKeyId: kp.publicKeyId,
    });

    expect(signature.algorithm).toBe("ed25519");
    expect(signature.publicKeyId).toBe(kp.publicKeyId);
    expect(signature.bundleSha384.length).toBeGreaterThan(0);
    expect(signature.signature.length).toBeGreaterThan(0);
    expect(() => new Date(signature.signedAt).toISOString()).not.toThrow();

    const result = await verifyBundleEd25519({
      bundleBytes: bundle,
      signature,
      publicKey: kp.publicKey,
    });
    expect(result).toEqual({ valid: true });
  });

  it("rejects bundle tampering (single byte flipped)", async () => {
    const kp = await generateEd25519Keypair();
    const bundle = new TextEncoder().encode("clean bundle");

    const signature = await signBundleEd25519({
      bundleBytes: bundle,
      privateKey: kp.privateKey,
      publicKeyId: kp.publicKeyId,
    });

    const tampered = new Uint8Array(bundle);
    tampered[0] = (tampered[0]! ^ 0x01) & 0xff;

    const result = await verifyBundleEd25519({
      bundleBytes: tampered,
      signature,
      publicKey: kp.publicKey,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/bundle hash mismatch/);
  });

  it("rejects signature tampering (signature bytes mutated)", async () => {
    const kp = await generateEd25519Keypair();
    const bundle = new TextEncoder().encode("clean bundle");
    const signature = await signBundleEd25519({
      bundleBytes: bundle,
      privateKey: kp.privateKey,
      publicKeyId: kp.publicKeyId,
    });

    // Flip one bit in the base64-decoded signature by swapping a char.
    // The base64 alphabet is closed under this kind of swap, so we keep
    // the structure valid but the bytes wrong.
    const swappedChar = signature.signature[0] === "A" ? "B" : "A";
    const mutated: Ed25519Signature = {
      ...signature,
      signature: swappedChar + signature.signature.slice(1),
    };

    const result = await verifyBundleEd25519({
      bundleBytes: bundle,
      signature: mutated,
      publicKey: kp.publicKey,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/does not verify|verification threw/);
    }
  });

  it("rejects publicKeyId substitution", async () => {
    const kp = await generateEd25519Keypair();
    const bundle = new TextEncoder().encode("clean bundle");
    const signature = await signBundleEd25519({
      bundleBytes: bundle,
      privateKey: kp.privateKey,
      publicKeyId: kp.publicKeyId,
    });

    const swapped: Ed25519Signature = {
      ...signature,
      publicKeyId: "ZZZZZZZZZZZZZZZZ", // 16 chars, but doesn't match the key
    };

    const result = await verifyBundleEd25519({
      bundleBytes: bundle,
      signature: swapped,
      publicKey: kp.publicKey,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/publicKeyId mismatch/);
  });

  it("rejects verification with the wrong public key", async () => {
    const author = await generateEd25519Keypair();
    const attacker = await generateEd25519Keypair();
    const bundle = new TextEncoder().encode("clean bundle");

    const signature = await signBundleEd25519({
      bundleBytes: bundle,
      privateKey: author.privateKey,
      publicKeyId: author.publicKeyId,
    });

    const result = await verifyBundleEd25519({
      bundleBytes: bundle,
      signature,
      publicKey: attacker.publicKey,
    });
    expect(result.valid).toBe(false);
    // Either the keyId-derivation check catches it (most likely)
    // or the raw Ed25519 verify rejects it. Both are acceptable rejections.
    if (!result.valid) {
      expect(result.reason).toMatch(/publicKeyId mismatch|does not verify/);
    }
  });

  it("produces deterministic signatures (Ed25519 is deterministic per RFC 8032)", async () => {
    const kp = await generateEd25519Keypair();
    const bundle = new TextEncoder().encode("same bundle, same key, same sig");

    const a = await signBundleEd25519({
      bundleBytes: bundle,
      privateKey: kp.privateKey,
      publicKeyId: kp.publicKeyId,
    });
    const b = await signBundleEd25519({
      bundleBytes: bundle,
      privateKey: kp.privateKey,
      publicKeyId: kp.publicKeyId,
    });

    expect(a.bundleSha384).toBe(b.bundleSha384);
    expect(a.signature).toBe(b.signature);
    // signedAt is a timestamp — intentionally allowed to differ.
  });

  it("rejects non-32-byte private key at signing time", async () => {
    await expect(
      signBundleEd25519({
        bundleBytes: new Uint8Array([1, 2, 3]),
        privateKey: new Uint8Array(16),
        publicKeyId: "abcdef0123456789",
      }),
    ).rejects.toThrow(/32-byte/);
  });

  it("rejects non-32-byte public key at verify time", async () => {
    const kp = await generateEd25519Keypair();
    const bundle = new TextEncoder().encode("hello");
    const signature = await signBundleEd25519({
      bundleBytes: bundle,
      privateKey: kp.privateKey,
      publicKeyId: kp.publicKeyId,
    });

    const result = await verifyBundleEd25519({
      bundleBytes: bundle,
      signature,
      publicKey: new Uint8Array(16),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/32-byte/);
  });
});

// ---------------------------------------------------------------------------
// Sigstore path — REAL crypto (F3, 2026-08-10).
//
// Nothing here mocks `sigstore`. `signBundleSigstore` and
// `verifyBundleSigstore` run their full upstream code paths — real
// ephemeral keys, real cert issuance, real transparency-log entries,
// real TUF trust-root resolution, real cryptographic verification —
// against the in-process mock Fulcio/Rekor/TUF stack from
// `./testing`, whose trust material is injected purely through the
// upstream option surface (`fulcioURL`/`rekorURL` on sign;
// `tufMirrorURL`/`tufRootPath`/`tufCachePath` on verify). Assertions
// that are pure option-threading live in
// `sigstore-option-threading.test.ts` instead.
// ---------------------------------------------------------------------------

describe("sigstore keyless path — real sign + verify against mock infrastructure (F3)", () => {
  let stack: SigstoreMockStack;

  beforeAll(async () => {
    stack = await startSigstoreMockStack();
  });

  afterAll(() => {
    stack.teardown();
  });

  it("sign → verify roundtrip: Fulcio cert, Rekor entry, TUF-resolved trust root", async () => {
    const bundleBytes = new TextEncoder().encode("export const wrapper = () => 'hi';");

    const signature = await signBundleSigstore({
      bundleBytes,
      identityToken: stack.identityToken(),
      endpoints: stack.signEndpoints,
    });

    expect(signature.algorithm).toBe("sigstore-cosign");
    expect(signature.bundleSha384.length).toBeGreaterThan(0);
    expect(() => new Date(signature.signedAt).toISOString()).not.toThrow();

    // Pin the REAL bundle shape sigstore v4 emits — the old hand-built
    // fixtures in this file assumed shapes real signing does not
    // produce (see the extractSigstoreLeafCertPem suite below).
    const parsed = JSON.parse(signature.bundle) as {
      mediaType?: string;
      verificationMaterial?: {
        certificate?: { rawBytes?: string };
        x509CertificateChain?: unknown;
        tlogEntries?: unknown[];
      };
      messageSignature?: { messageDigest?: { algorithm?: string } };
    };
    expect(parsed.mediaType).toMatch(/application\/vnd\.dev\.sigstore\.bundle/);
    expect(parsed.messageSignature?.messageDigest?.algorithm).toBe("SHA2_256");
    expect(parsed.verificationMaterial?.tlogEntries).toHaveLength(1);

    const result = await verifyBundleSigstore({
      bundleBytes,
      signature,
      ...stack.tuf,
    });
    expect(result).toEqual({ valid: true });
  });

  it("verify rejects tampered bundle bytes at the fast SHA-384 gate", async () => {
    const bundleBytes = new TextEncoder().encode("clean bundle");
    const signature = await signBundleSigstore({
      bundleBytes,
      identityToken: stack.identityToken(),
      endpoints: stack.signEndpoints,
    });

    const tampered = new Uint8Array(bundleBytes);
    tampered[0] = (tampered[0]! ^ 0x01) & 0xff;

    const result = await verifyBundleSigstore({
      bundleBytes: tampered,
      signature,
      ...stack.tuf,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/bundle hash mismatch/);
  });

  it("verify cryptographically rejects a signature transplanted from other payload bytes", async () => {
    // Defeat the fast SHA-384 gate on purpose (claim the digest of the
    // bytes under verification) so the REAL upstream check — the
    // signature + messageDigest inside the cosign bundle — is what
    // rejects. This is the assertion the old wholesale `sigstore` mock
    // could never make.
    const signedBytes = new TextEncoder().encode("the bytes that were signed");
    const presentedBytes = new TextEncoder().encode("different bytes presented");
    const signature = await signBundleSigstore({
      bundleBytes: signedBytes,
      identityToken: stack.identityToken(),
      endpoints: stack.signEndpoints,
    });

    const { sha384 } = await import("@noble/hashes/sha2");
    const transplanted: SigstoreSignature = {
      ...signature,
      bundleSha384: Buffer.from(sha384(presentedBytes)).toString("base64"),
    };

    const result = await verifyBundleSigstore({
      bundleBytes: presentedBytes,
      signature: transplanted,
      ...stack.tuf,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/sigstore verification failed/);
      // Guard the assertion's meaning: the rejection must come from
      // the cryptographic check, not from trust-material resolution
      // failing before the check could run.
      expect(result.reason).not.toMatch(/TUF/i);
    }
  });

  it("string identity policy: the real leaf-cert SAN must match certificateIdentityURI", async () => {
    // URI-shaped subject on purpose: the mock CA writes URI SANs
    // regardless of subject shape (see ./testing module docstring), so
    // email policies can never match here — email routing is pinned in
    // the option-threading seam tests.
    const bundleBytes = new TextEncoder().encode("identity-policy payload");
    const signature = await signBundleSigstore({
      bundleBytes,
      identityToken: stack.identityToken(),
      endpoints: stack.signEndpoints,
    });

    const matching = await verifyBundleSigstore({
      bundleBytes,
      signature,
      expectedIdentity: {
        subject: stack.defaultSubject,
        issuer: stack.defaultIssuer,
      },
      ...stack.tuf,
    });
    expect(matching).toEqual({ valid: true });

    const mismatched = await verifyBundleSigstore({
      bundleBytes,
      signature,
      expectedIdentity: {
        subject: "https://gadgets.ggui.test/somebody-else",
        issuer: stack.defaultIssuer,
      },
      ...stack.tuf,
    });
    expect(mismatched.valid).toBe(false);
    if (!mismatched.valid) {
      expect(mismatched.reason).toMatch(/sigstore verification failed/);
    }
  });

  it("RegExp identity pre-check runs against the real leaf-cert SAN", async () => {
    const bundleBytes = new TextEncoder().encode("regexp-identity payload");
    const signature = await signBundleSigstore({
      bundleBytes,
      identityToken: stack.identityToken(),
      endpoints: stack.signEndpoints,
    });

    // The lightweight DER scanner in `extractSANFromBundle` reads a
    // REAL Fulcio-mock certificate here — this suite is its only
    // coverage against genuine DER (the old tests fed it hand-rolled
    // pseudo-DER).
    const matching = await verifyBundleSigstore({
      bundleBytes,
      signature,
      expectedIdentity: { subject: /\/e2e-signer$/ },
      ...stack.tuf,
    });
    expect(matching).toEqual({ valid: true });

    const mismatched = await verifyBundleSigstore({
      bundleBytes,
      signature,
      expectedIdentity: { subject: /\/somebody-else$/ },
      ...stack.tuf,
    });
    expect(mismatched.valid).toBe(false);
    // `identity mismatch` is emitted ONLY by the RegExp pre-check —
    // proof the rejection happened before the upstream verifier ran.
    if (!mismatched.valid) expect(mismatched.reason).toMatch(/identity mismatch/);
  });

  it("extractSigstoreLeafCertPem returns the leaf cert from a REAL signed bundle", async () => {
    const bundleBytes = new TextEncoder().encode("leaf-cert payload");
    const signature = await signBundleSigstore({
      bundleBytes,
      identityToken: stack.identityToken(),
      endpoints: stack.signEndpoints,
    });

    const leaf = extractSigstoreLeafCertPem(signature);
    expect(leaf).toBeDefined();
    // The extracted value is the base64 DER — a decoded cert starts
    // with the ASN.1 SEQUENCE tag.
    expect(Buffer.from(leaf!, "base64")[0]).toBe(0x30);
  });

  it("extractSigstoreSANs projects EVERY signer identity from a REAL signed bundle (F4)", async () => {
    const bundleBytes = new TextEncoder().encode("san-projection payload");
    const signature = await signBundleSigstore({
      bundleBytes,
      identityToken: stack.identityToken(),
      endpoints: stack.signEndpoints,
    });

    // The certificate's SANs carry the OIDC subject the token claimed
    // — the identities a registry's publish gate authorizes against.
    // The mock CA writes a single URI SAN; real Fulcio certs can carry
    // BOTH a URI and an rfc822 SAN, and callers must check every one.
    expect(extractSigstoreSANs(signature)).toEqual([stack.defaultSubject]);

    // A custom subject flows through end-to-end.
    const emailShaped = await signBundleSigstore({
      bundleBytes,
      identityToken: stack.identityToken({ sub: "release@gadgets.ggui.test" }),
      endpoints: stack.signEndpoints,
    });
    expect(extractSigstoreSANs(emailShaped)).toEqual(["release@gadgets.ggui.test"]);
  });

  it("extractSigstoreSANs returns an EMPTY array for malformed or cert-less bundles (F4)", () => {
    const sigWithBundle = (bundle: string): SigstoreSignature => ({
      algorithm: "sigstore-cosign",
      bundleSha384: "AAAA",
      bundle,
      signedAt: "2026-08-10T00:00:00.000Z",
    });
    expect(extractSigstoreSANs(sigWithBundle("{not json"))).toEqual([]);
    expect(extractSigstoreSANs(sigWithBundle(JSON.stringify({})))).toEqual([]);
    // A cert value that isn't parseable DER projects as empty —
    // callers reject rather than authorize against garbage.
    expect(
      extractSigstoreSANs(
        sigWithBundle(
          JSON.stringify({
            verificationMaterial: {
              certificate: { rawBytes: "bm90LWEtY2VydA==" },
            },
          }),
        ),
      ),
    ).toEqual([]);
  });
});

describe("sigstore signing failure classification — real error paths (F3)", () => {
  it("wraps a Fulcio 400 (garbage OIDC token) as SigstoreSigningError with a cause", async () => {
    const stack = await startSigstoreMockStack();
    try {
      await expect(
        signBundleSigstore({
          bundleBytes: new TextEncoder().encode("data"),
          identityToken: "not-a-jwt-at-all",
          endpoints: stack.signEndpoints,
        }),
      ).rejects.toMatchObject({
        name: "SigstoreSigningError",
        // Observed on first real execution (F3): the upstream error
        // message for an undecodable token mentions the token itself,
        // so the classifier's message-level identity check fires
        // BEFORE the `CA_*` code check — `oidc_invalid`, the more
        // actionable code for this failure (re-acquire the token, not
        // "Fulcio is down").
        code: "oidc_invalid",
      });
    } finally {
      stack.teardown();
    }
  });

  it("wraps an unreachable Rekor as SigstoreSigningError(code='rekor_error')", async () => {
    // Fulcio mounted, Rekor NOT — cert issuance succeeds, the
    // transparency-log write fails. The stack is hermetic
    // (disableNetConnect), so each attempt dies instantly on nock's
    // disallowed-net-connect error — no live DNS involved; the ~3s
    // wall time is upstream's default retry backoff (2 retries)
    // around the deterministic refusal.
    const stack = await startSigstoreMockStack({ rekor: false });
    try {
      await expect(
        signBundleSigstore({
          bundleBytes: new TextEncoder().encode("data"),
          identityToken: stack.identityToken(),
          endpoints: stack.signEndpoints,
        }),
      ).rejects.toMatchObject({
        name: "SigstoreSigningError",
        code: "rekor_error",
      });
    } finally {
      stack.teardown();
    }
  }, 15_000);

  it("SigstoreSigningError exposes cause for upstream telemetry", () => {
    const cause = new Error("inner");
    const err = new SigstoreSigningError("unknown", "outer", cause);
    expect(err.cause).toBe(cause);
    expect(err.code).toBe("unknown");
  });
});

describe("verifyBundleSigstore — local structural gates (no network, no trust root)", () => {
  it("rejects a malformed bundle JSON string before consulting any trust material", async () => {
    const { sha384 } = await import("@noble/hashes/sha2");
    const digest = sha384(new Uint8Array(0));
    const signature: SigstoreSignature = {
      algorithm: "sigstore-cosign",
      bundleSha384: Buffer.from(digest).toString("base64"),
      bundle: "{not json",
      signedAt: new Date().toISOString(),
    };
    const result = await verifyBundleSigstore({
      bundleBytes: new Uint8Array(0),
      signature,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/malformed bundle JSON/);
  });

  it("rejects a structurally invalid sigstore bundle shape", async () => {
    const bundleBytes = new TextEncoder().encode("data");
    const { sha384 } = await import("@noble/hashes/sha2");
    const signature: SigstoreSignature = {
      algorithm: "sigstore-cosign",
      bundleSha384: Buffer.from(sha384(bundleBytes)).toString("base64"),
      // Valid JSON, invalid Bundle: no verificationMaterial/content.
      bundle: JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3" }),
      signedAt: new Date().toISOString(),
    };
    const result = await verifyBundleSigstore({ bundleBytes, signature });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/invalid sigstore bundle shape/);
  });
});

describe("extractSigstoreLeafCertPem", () => {
  function sigWithBundle(bundle: string): SigstoreSignature {
    return {
      algorithm: "sigstore-cosign",
      bundleSha384: "dW51c2Vk",
      bundle,
      signedAt: "2026-06-12T00:00:00.000Z",
    };
  }

  it("returns the leaf cert rawBytes from a chain-shaped bundle", () => {
    const bundle = JSON.stringify({
      verificationMaterial: {
        x509CertificateChain: {
          certificates: [{ rawBytes: "TEVBRi1DRVJU" }, { rawBytes: "SU5URVJNRURJQVRF" }],
        },
      },
    });
    expect(extractSigstoreLeafCertPem(sigWithBundle(bundle))).toBe("TEVBRi1DRVJU");
  });

  it("returns the leaf cert rawBytes from a v0.3 single-certificate bundle", () => {
    // sigstore v4's `sign()` emits bundle v0.3, which carries
    // `verificationMaterial.certificate` (single leaf) instead of the
    // v0.1/v0.2 `x509CertificateChain` shape — discovered when the
    // first REAL signed bundle hit this extractor (F3).
    const bundle = JSON.stringify({
      verificationMaterial: { certificate: { rawBytes: "TEVBRi1DRVJU" } },
    });
    expect(extractSigstoreLeafCertPem(sigWithBundle(bundle))).toBe("TEVBRi1DRVJU");
  });

  it("returns undefined for malformed JSON", () => {
    expect(extractSigstoreLeafCertPem(sigWithBundle("{not json"))).toBeUndefined();
  });

  it("returns undefined for an empty certificates array", () => {
    const bundle = JSON.stringify({
      verificationMaterial: { x509CertificateChain: { certificates: [] } },
    });
    expect(extractSigstoreLeafCertPem(sigWithBundle(bundle))).toBeUndefined();
  });

  it("returns undefined when rawBytes is empty or missing", () => {
    const empty = JSON.stringify({
      verificationMaterial: {
        x509CertificateChain: { certificates: [{ rawBytes: "" }] },
      },
    });
    expect(extractSigstoreLeafCertPem(sigWithBundle(empty))).toBeUndefined();
    const missing = JSON.stringify({
      verificationMaterial: { x509CertificateChain: { certificates: [{}] } },
    });
    expect(extractSigstoreLeafCertPem(sigWithBundle(missing))).toBeUndefined();
    const emptySingle = JSON.stringify({
      verificationMaterial: { certificate: { rawBytes: "" } },
    });
    expect(extractSigstoreLeafCertPem(sigWithBundle(emptySingle))).toBeUndefined();
  });
});
