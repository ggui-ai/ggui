import { beforeEach, describe, expect, it, vi } from "vitest";

// `sigstore` is mocked at the import boundary — full sign+verify against
// real Fulcio/Rekor would require either real network or building a
// custom TUF trust root from `@sigstore/mock`, both of which add weight
// well past the unit-test bar. The mock here verifies (a) inputs to
// `sign` are correctly shaped and (b) the wire-shape projection
// (bundleSha384 + signedAt + serialized bundle) is correct. The full
// cryptographic flow is exercised by the upstream sigstore-js library's
// own test suite and by the higher-tier e2e suite when it lands.
vi.mock("sigstore", async () => {
  const actual = await vi.importActual<typeof import("sigstore")>("sigstore");
  return {
    ...actual,
    sign: vi.fn(),
    verify: vi.fn(),
  };
});

const sigstoreModule = await import("sigstore");
const mockedSign = vi.mocked(sigstoreModule.sign);
const mockedVerify = vi.mocked(sigstoreModule.verify);

import {
  derivePublicKeyId,
  extractSigstoreLeafCertPem,
  generateEd25519Keypair,
  signBundleEd25519,
  signBundleSigstore,
  SigstoreSigningError,
  verifyBundleEd25519,
  verifyBundleSigstore,
  type Ed25519Signature,
  type SigstoreSignature,
} from "./index.js";

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
// Sigstore path tests. The `sigstore` package is mocked at the top of
// this file so we can exercise the gadget-signing seam in isolation.
// ---------------------------------------------------------------------------

/**
 * Build a syntactically-valid Sigstore Bundle v0.2 JSON. The exact
 * contents don't need to verify cryptographically — `verifyBundleSigstore`
 * delegates the real check to the mocked `sigstore.verify`.
 *
 * Includes the bare minimum fields `assertBundleLatest` checks for
 * (mediaType + content + verificationMaterial + tlogEntries with
 * inclusionProof + checkpoint). Cert SAN is intentionally crafted so
 * the lightweight DER scanner can extract it.
 */
function buildFakeBundleJSON(opts?: { san?: string }): string {
  // Hand-rolled DER for: SEQUENCE { OID 2.5.29.17, OCTET-STRING containing
  // SEQUENCE { GeneralName URI = opts.san } }. The SAN extractor scans
  // for the OID prefix and then reads the printable run that follows.
  const san = opts?.san ?? "https://gadgets.example.com/test-author";
  const sanBytes = Array.from(san).map((c) => c.charCodeAt(0));
  // 0x06 0x03 0x55 0x1d 0x11 (OID prefix) + small filler + ASCII SAN.
  const certDer = new Uint8Array([
    0x30, 0x82, 0x00, 0x10,
    0x06, 0x03, 0x55, 0x1d, 0x11,
    0x04, 0x0a,
    0x30, 0x08, 0x86, 0x06,
    ...sanBytes,
    0x00,
  ]);
  const certB64 = Buffer.from(certDer).toString("base64");

  return JSON.stringify({
    mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
    verificationMaterial: {
      certificate: { rawBytes: certB64 },
      tlogEntries: [
        {
          logIndex: "1",
          logId: { keyId: "AA==" },
          kindVersion: { kind: "hashedrekord", version: "0.0.1" },
          integratedTime: "1700000000",
          inclusionProof: {
            logIndex: "1",
            rootHash: "AAAA",
            treeSize: "2",
            hashes: ["BBBB"],
            checkpoint: { envelope: "checkpoint-body" },
          },
          canonicalizedBody: "AAAA",
        },
      ],
    },
    messageSignature: {
      messageDigest: { algorithm: "SHA2_256", digest: "AAAA" },
      signature: "BBBB",
    },
  });
}

describe("signBundleSigstore", () => {
  beforeEach(() => {
    mockedSign.mockReset();
    mockedVerify.mockReset();
  });

  it("returns a SigstoreSignature with correct shape on happy path", async () => {
    mockedSign.mockResolvedValueOnce(JSON.parse(buildFakeBundleJSON()));
    const bundleBytes = new TextEncoder().encode("hello world");

    const signature = await signBundleSigstore({
      bundleBytes,
      identityToken: "header.payload.sig",
    });

    expect(signature.algorithm).toBe("sigstore-cosign");
    expect(signature.bundleSha384.length).toBeGreaterThan(0);
    expect(() => JSON.parse(signature.bundle)).not.toThrow();
    expect(() => new Date(signature.signedAt).toISOString()).not.toThrow();

    // Confirms the upstream sign was called with the right shape.
    expect(mockedSign).toHaveBeenCalledOnce();
    const [data, opts] = mockedSign.mock.calls[0]!;
    expect(Buffer.isBuffer(data) ? data.toString("utf-8") : "").toBe("hello world");
    expect(opts).toMatchObject({ identityToken: "header.payload.sig", tlogUpload: true });
  });

  it("forwards endpoint overrides when supplied", async () => {
    mockedSign.mockResolvedValueOnce(JSON.parse(buildFakeBundleJSON()));
    await signBundleSigstore({
      bundleBytes: new TextEncoder().encode("data"),
      identityToken: "tok",
      endpoints: {
        fulcioURL: "https://fulcio.example.test",
        rekorURL: "https://rekor.example.test",
      },
    });
    const [, opts] = mockedSign.mock.calls[0]!;
    expect(opts).toMatchObject({
      fulcioURL: "https://fulcio.example.test",
      rekorURL: "https://rekor.example.test",
    });
  });

  it("wraps upstream OIDC errors as SigstoreSigningError(code='oidc_invalid')", async () => {
    mockedSign.mockRejectedValueOnce(new Error("OIDC token expired"));
    await expect(
      signBundleSigstore({
        bundleBytes: new TextEncoder().encode("data"),
        identityToken: "expired",
      }),
    ).rejects.toMatchObject({
      name: "SigstoreSigningError",
      code: "oidc_invalid",
    });
  });

  it("wraps upstream tlog errors as SigstoreSigningError(code='rekor_error')", async () => {
    const upstream = Object.assign(new Error("tlog write failed"), {
      code: "TLOG_CREATE_ENTRY_ERROR",
    });
    mockedSign.mockRejectedValueOnce(upstream);
    await expect(
      signBundleSigstore({
        bundleBytes: new TextEncoder().encode("data"),
        identityToken: "tok",
      }),
    ).rejects.toMatchObject({
      name: "SigstoreSigningError",
      code: "rekor_error",
    });
  });

  it("SigstoreSigningError exposes cause for upstream telemetry", () => {
    const cause = new Error("inner");
    const err = new SigstoreSigningError("unknown", "outer", cause);
    expect(err.cause).toBe(cause);
    expect(err.code).toBe("unknown");
  });
});

describe("verifyBundleSigstore", () => {
  beforeEach(() => {
    mockedSign.mockReset();
    mockedVerify.mockReset();
  });

  it("round-trips with sign on the happy path", async () => {
    mockedSign.mockResolvedValueOnce(JSON.parse(buildFakeBundleJSON()));
    mockedVerify.mockResolvedValueOnce({} as unknown as never);

    const bundleBytes = new TextEncoder().encode("hello world");
    const signature = await signBundleSigstore({
      bundleBytes,
      identityToken: "tok",
    });

    const result = await verifyBundleSigstore({
      bundleBytes,
      signature,
    });
    expect(result).toEqual({ valid: true });
    expect(mockedVerify).toHaveBeenCalledOnce();
  });

  it("rejects bundle tampering with bundleSha384 mismatch", async () => {
    mockedSign.mockResolvedValueOnce(JSON.parse(buildFakeBundleJSON()));
    const bundleBytes = new TextEncoder().encode("clean bundle");
    const signature = await signBundleSigstore({
      bundleBytes,
      identityToken: "tok",
    });

    const tampered = new Uint8Array(bundleBytes);
    tampered[0] = (tampered[0]! ^ 0x01) & 0xff;

    const result = await verifyBundleSigstore({
      bundleBytes: tampered,
      signature,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/bundle hash mismatch/);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it("rejects a malformed bundle JSON string", async () => {
    const signature: SigstoreSignature = {
      algorithm: "sigstore-cosign",
      bundleSha384: Buffer.from(
        // Sha-384 of empty string — matches sha384(new Uint8Array(0)).
        new Uint8Array(48),
      ).toString("base64"),
      bundle: "{not json",
      signedAt: new Date().toISOString(),
    };
    // Force the fast-tamper check to pass: pre-compute the expected
    // digest for the (empty) bundle bytes.
    const { sha384 } = await import("@noble/hashes/sha2");
    const digest = sha384(new Uint8Array(0));
    signature.bundleSha384 satisfies string;
    const fixed: SigstoreSignature = {
      ...signature,
      bundleSha384: Buffer.from(digest).toString("base64"),
    };
    const result = await verifyBundleSigstore({
      bundleBytes: new Uint8Array(0),
      signature: fixed,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/malformed bundle JSON/);
  });

  it("projects upstream verify failure to VerifyResult (does not throw)", async () => {
    mockedSign.mockResolvedValueOnce(JSON.parse(buildFakeBundleJSON()));
    mockedVerify.mockRejectedValueOnce(new Error("certificate identity does not match"));
    const bundleBytes = new TextEncoder().encode("data");
    const signature = await signBundleSigstore({ bundleBytes, identityToken: "tok" });

    const result = await verifyBundleSigstore({
      bundleBytes,
      signature,
      expectedIdentity: { subject: "https://different.example.test" },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/sigstore verification failed/);
      expect(result.reason).toMatch(/certificate identity does not match/);
    }
  });

  it("forwards string identity policy to upstream verify", async () => {
    mockedSign.mockResolvedValueOnce(JSON.parse(buildFakeBundleJSON()));
    mockedVerify.mockResolvedValueOnce({} as unknown as never);
    const bundleBytes = new TextEncoder().encode("data");
    const signature = await signBundleSigstore({ bundleBytes, identityToken: "tok" });

    await verifyBundleSigstore({
      bundleBytes,
      signature,
      expectedIdentity: {
        subject: "https://author.example.test/me",
        issuer: "https://token.actions.githubusercontent.com",
      },
    });
    const [, , opts] = mockedVerify.mock.calls[0]!;
    expect(opts).toMatchObject({
      certificateIdentityURI: "https://author.example.test/me",
      certificateIssuer: "https://token.actions.githubusercontent.com",
    });
  });

  it("routes email-shaped identity to certificateIdentityEmail", async () => {
    mockedSign.mockResolvedValueOnce(JSON.parse(buildFakeBundleJSON()));
    mockedVerify.mockResolvedValueOnce({} as unknown as never);
    const bundleBytes = new TextEncoder().encode("data");
    const signature = await signBundleSigstore({ bundleBytes, identityToken: "tok" });

    await verifyBundleSigstore({
      bundleBytes,
      signature,
      expectedIdentity: { subject: "author@example.test" },
    });
    const [, , opts] = mockedVerify.mock.calls[0]!;
    expect(opts).toMatchObject({ certificateIdentityEmail: "author@example.test" });
  });

  it("RegExp identity that fails to match rejects WITHOUT calling upstream verify", async () => {
    mockedSign.mockResolvedValueOnce(
      JSON.parse(buildFakeBundleJSON({ san: "https://gadgets.example.com/alice" })),
    );
    const bundleBytes = new TextEncoder().encode("data");
    const signature = await signBundleSigstore({ bundleBytes, identityToken: "tok" });

    const result = await verifyBundleSigstore({
      bundleBytes,
      signature,
      expectedIdentity: { subject: /\/bob$/ },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/identity mismatch/);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it("RegExp identity that matches allows upstream verify to proceed", async () => {
    mockedSign.mockResolvedValueOnce(
      JSON.parse(buildFakeBundleJSON({ san: "https://gadgets.example.com/alice" })),
    );
    mockedVerify.mockResolvedValueOnce({} as unknown as never);
    const bundleBytes = new TextEncoder().encode("data");
    const signature = await signBundleSigstore({ bundleBytes, identityToken: "tok" });

    const result = await verifyBundleSigstore({
      bundleBytes,
      signature,
      expectedIdentity: { subject: /\/alice$/ },
    });
    expect(result).toEqual({ valid: true });
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

  it("returns undefined for malformed JSON", () => {
    expect(extractSigstoreLeafCertPem(sigWithBundle("{not json"))).toBeUndefined();
  });

  it("returns undefined when the cert chain is absent (single-certificate shape)", () => {
    const bundle = JSON.stringify({
      verificationMaterial: { certificate: { rawBytes: "TEVBRi1DRVJU" } },
    });
    expect(extractSigstoreLeafCertPem(sigWithBundle(bundle))).toBeUndefined();
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
  });
});
