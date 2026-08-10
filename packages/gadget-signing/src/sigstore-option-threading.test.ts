/**
 * Thin option-threading seam tests for the sigstore path (F3 residue).
 *
 * The upstream `sigstore` module is mocked HERE ONLY — and only for
 * assertions that are pure option-threading: "did our seam forward
 * field X onto the upstream call's options bag". Everything
 * behavioral (sign/verify round-trips, tamper rejection, identity
 * policy, error classification) runs REAL crypto in `index.test.ts`
 * against the in-process mock infrastructure from `./testing` —
 * never re-add behavioral coverage behind this module mock.
 */
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Signer } from "@sigstore/verify";

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

/**
 * Genuine `Signer` resolution value for the mocked `sigstore.verify`.
 * Upstream's overloaded `verify` resolves a `Signer` —
 * `{ key: crypto.KeyObject; identity?: ... }` per `@sigstore/verify` —
 * which is an ordinary object type, so we CONSTRUCT one (real
 * KeyObject, no identity) instead of casting. Our seam discards the
 * resolution value; only "resolved vs rejected" matters here.
 */
function resolvedSigner(): Signer {
  return { key: generateKeyPairSync("ed25519").publicKey };
}

import {
  signBundleSigstore,
  verifyBundleSigstore,
  type SigstoreSignature,
} from "./index.js";

/**
 * Minimal syntactically-valid serialized bundle for threading tests —
 * enough shape for `bundleFromJSON`'s validator; the mocked verify
 * never checks it cryptographically. Field values mirror what real
 * v0.2-era bundles carry (the real-shape pins live in `index.test.ts`).
 */
function buildFakeBundleJSON(): string {
  return JSON.stringify({
    mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
    verificationMaterial: {
      certificate: { rawBytes: "MIIBADANBgkq" },
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

async function signedFixture(): Promise<{
  bundleBytes: Uint8Array;
  signature: SigstoreSignature;
}> {
  mockedSign.mockResolvedValueOnce(JSON.parse(buildFakeBundleJSON()));
  const bundleBytes = new TextEncoder().encode("data");
  const signature = await signBundleSigstore({ bundleBytes, identityToken: "tok" });
  return { bundleBytes, signature };
}

describe("signBundleSigstore — option threading", () => {
  beforeEach(() => {
    mockedSign.mockReset();
    mockedVerify.mockReset();
  });

  it("threads identityToken + tlogUpload and the payload bytes", async () => {
    mockedSign.mockResolvedValueOnce(JSON.parse(buildFakeBundleJSON()));
    await signBundleSigstore({
      bundleBytes: new TextEncoder().encode("hello world"),
      identityToken: "header.payload.sig",
    });
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

  it("omits endpoint fields from upstream options when unset", async () => {
    mockedSign.mockResolvedValueOnce(JSON.parse(buildFakeBundleJSON()));
    await signBundleSigstore({
      bundleBytes: new TextEncoder().encode("data"),
      identityToken: "tok",
    });
    const [, opts] = mockedSign.mock.calls[0]!;
    expect(opts).not.toHaveProperty("fulcioURL");
    expect(opts).not.toHaveProperty("rekorURL");
  });
});

describe("verifyBundleSigstore — option threading", () => {
  beforeEach(() => {
    mockedSign.mockReset();
    mockedVerify.mockReset();
  });

  it("routes URI-shaped identity to certificateIdentityURI + issuer", async () => {
    mockedVerify.mockResolvedValueOnce(resolvedSigner());
    const { bundleBytes, signature } = await signedFixture();

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
    mockedVerify.mockResolvedValueOnce(resolvedSigner());
    const { bundleBytes, signature } = await signedFixture();

    await verifyBundleSigstore({
      bundleBytes,
      signature,
      expectedIdentity: { subject: "author@example.test" },
    });
    const [, , opts] = mockedVerify.mock.calls[0]!;
    expect(opts).toMatchObject({ certificateIdentityEmail: "author@example.test" });
  });

  it("threads tufCachePath + tufForceCache into upstream verify options (F2)", async () => {
    mockedVerify.mockResolvedValueOnce(resolvedSigner());
    const { bundleBytes, signature } = await signedFixture();

    const result = await verifyBundleSigstore({
      bundleBytes,
      signature,
      tufCachePath: "/tmp/sigstore-js",
      tufForceCache: true,
    });
    expect(result).toEqual({ valid: true });
    const [, , opts] = mockedVerify.mock.calls[0]!;
    expect(opts).toMatchObject({
      tufCachePath: "/tmp/sigstore-js",
      tufForceCache: true,
    });
  });

  it("threads tufMirrorURL + tufRootPath into upstream verify options (F3)", async () => {
    mockedVerify.mockResolvedValueOnce(resolvedSigner());
    const { bundleBytes, signature } = await signedFixture();

    const result = await verifyBundleSigstore({
      bundleBytes,
      signature,
      tufMirrorURL: "https://tuf.mirror.test",
      tufRootPath: "/tmp/tuf/root.json",
    });
    expect(result).toEqual({ valid: true });
    const [, , opts] = mockedVerify.mock.calls[0]!;
    expect(opts).toMatchObject({
      tufMirrorURL: "https://tuf.mirror.test",
      tufRootPath: "/tmp/tuf/root.json",
    });
  });

  it("omits all TUF options from upstream verify when unset", async () => {
    mockedVerify.mockResolvedValueOnce(resolvedSigner());
    const { bundleBytes, signature } = await signedFixture();

    await verifyBundleSigstore({ bundleBytes, signature });
    const [, , opts] = mockedVerify.mock.calls[0]!;
    expect(opts).not.toHaveProperty("tufMirrorURL");
    expect(opts).not.toHaveProperty("tufRootPath");
    expect(opts).not.toHaveProperty("tufCachePath");
    expect(opts).not.toHaveProperty("tufForceCache");
  });
});
