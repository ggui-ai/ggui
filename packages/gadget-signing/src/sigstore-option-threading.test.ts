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
import { bundleFromJSON } from "@sigstore/bundle";

vi.mock("sigstore", async () => {
  const actual = await vi.importActual<typeof import("sigstore")>("sigstore");
  return {
    ...actual,
    sign: vi.fn(),
    verify: vi.fn(),
  };
});

// The SIGN seam assembles `@sigstore/sign` primitives directly (ggui#555
// — the facade hardcodes `fetchOnConflict: false`), so its threading
// pins mock the primitive constructors + the builder, capturing exactly
// what our seam hands upstream. Behavioral coverage (the reassembled
// pipeline actually signing) stays REAL in `index.test.ts`.
vi.mock("@sigstore/sign", async () => {
  const actual = await vi.importActual<typeof import("@sigstore/sign")>("@sigstore/sign");
  return {
    ...actual,
    FulcioSigner: vi.fn(),
    RekorWitness: vi.fn(),
    MessageSignatureBundleBuilder: vi.fn(),
  };
});

const sigstoreModule = await import("sigstore");
const signModule = await import("@sigstore/sign");
const mockedSign = vi.mocked(sigstoreModule.sign);
const mockedVerify = vi.mocked(sigstoreModule.verify);
const MockedFulcioSigner = vi.mocked(signModule.FulcioSigner);
const MockedRekorWitness = vi.mocked(signModule.RekorWitness);
const MockedBundleBuilder = vi.mocked(signModule.MessageSignatureBundleBuilder);

/**
 * Arm the mocked builder so `create` resolves; returns the create spy.
 * `create` resolves a DESERIALIZED Bundle (through the real
 * `@sigstore/bundle` codec) because the seam re-serializes it with
 * `bundleToJSON` — resolving pre-serialized JSON would round-trip into
 * garbage and poison the verify-side fixtures downstream.
 */
function armBuilder(): ReturnType<typeof vi.fn> {
  const create = vi
    .fn()
    .mockResolvedValue(bundleFromJSON(JSON.parse(buildFakeBundleJSON())));
  MockedBundleBuilder.mockImplementation(
    () =>
      ({ create }) as unknown as InstanceType<
        typeof signModule.MessageSignatureBundleBuilder
      >,
  );
  return create;
}

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
  // The sign seam runs through the mocked primitive builder now
  // (ggui#555) — arm it so the fixture resolves the fake bundle.
  armBuilder();
  const bundleBytes = new TextEncoder().encode("data");
  const signature = await signBundleSigstore({ bundleBytes, identityToken: "tok" });
  return { bundleBytes, signature };
}

describe("signBundleSigstore — option threading", () => {
  beforeEach(() => {
    mockedSign.mockReset();
    mockedVerify.mockReset();
    MockedFulcioSigner.mockReset();
    MockedRekorWitness.mockReset();
    MockedBundleBuilder.mockReset();
  });

  it("threads the identity token through a resolving provider and hands the payload bytes to the builder", async () => {
    const create = armBuilder();
    await signBundleSigstore({
      bundleBytes: new TextEncoder().encode("hello world"),
      identityToken: "header.payload.sig",
    });
    expect(create).toHaveBeenCalledOnce();
    const [artifact] = create.mock.calls[0]!;
    const data = (artifact as { data: Buffer }).data;
    expect(Buffer.isBuffer(data) ? data.toString("utf-8") : "").toBe("hello world");
    const signerOpts = MockedFulcioSigner.mock.calls[0]![0]!;
    await expect(signerOpts.identityProvider!.getToken()).resolves.toBe(
      "header.payload.sig",
    );
  });

  it("arms Rekor's fetch-on-conflict recovery — a 409 'equivalent entry' is our own retry's success, never fatal (ggui#555)", async () => {
    armBuilder();
    await signBundleSigstore({
      bundleBytes: new TextEncoder().encode("data"),
      identityToken: "tok",
    });
    expect(MockedRekorWitness).toHaveBeenCalledOnce();
    expect(MockedRekorWitness.mock.calls[0]![0]).toMatchObject({
      fetchOnConflict: true,
    });
    // Exactly one witness, and it is the armed one — a second,
    // facade-built witness would reintroduce the fatal path.
    const builderOpts = MockedBundleBuilder.mock.calls[0]![0]!;
    expect(builderOpts.witnesses).toHaveLength(1);
    expect(builderOpts.witnesses[0]).toBe(MockedRekorWitness.mock.instances[0]);
  });

  it("forwards endpoint overrides when supplied", async () => {
    armBuilder();
    await signBundleSigstore({
      bundleBytes: new TextEncoder().encode("data"),
      identityToken: "tok",
      endpoints: {
        fulcioURL: "https://fulcio.example.test",
        rekorURL: "https://rekor.example.test",
      },
    });
    expect(MockedFulcioSigner.mock.calls[0]![0]).toMatchObject({
      fulcioBaseURL: "https://fulcio.example.test",
    });
    expect(MockedRekorWitness.mock.calls[0]![0]).toMatchObject({
      rekorBaseURL: "https://rekor.example.test",
    });
  });

  it("falls back to sigstore's public defaults when endpoints are unset (the facade's own composition)", async () => {
    armBuilder();
    await signBundleSigstore({
      bundleBytes: new TextEncoder().encode("data"),
      identityToken: "tok",
    });
    expect(MockedFulcioSigner.mock.calls[0]![0]).toMatchObject({
      fulcioBaseURL: "https://fulcio.sigstore.dev",
    });
    expect(MockedRekorWitness.mock.calls[0]![0]).toMatchObject({
      rekorBaseURL: "https://rekor.sigstore.dev",
    });
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
