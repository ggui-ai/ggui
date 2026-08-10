/**
 * `publishArtifact` — REAL-crypto sigstore publish path (F3,
 * 2026-08-10).
 *
 * Nothing here is module-mocked. The publish op runs a genuinely
 * sigstore-signed public publish end-to-end: a bundle signed by the
 * REAL `signBundleSigstore` (real ephemeral key, real cert issuance
 * against the mock CA, real transparency-log entry) flows through the
 * F1 visibility↔algorithm pairing gate, the F0 scope claim, the REAL
 * `verifyBundleSigstore` (TUF-resolved mock trust root via the F2/F3
 * `sigstoreTuf` seam), and lands with the real leaf-cert pin on
 * `authorPublicKey`. The mocked suites in `publish.test.ts` keep the
 * cheap gate-order/error-path coverage; THIS file proves the crypto
 * path actually executes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  extractSigstoreLeafCertPem,
  signBundleSigstore,
  type SigstoreSignature,
} from '@ggui-ai/gadget-signing';
import {
  startSigstoreMockStack,
  type SigstoreMockStack,
} from '@ggui-ai/gadget-signing/testing';
import type { ArtifactManifest } from '@ggui-ai/artifact-manifest';
import { publishArtifact, type PublishArtifactDeps } from './publish.js';
import { searchArtifacts } from './search.js';
import { inMemoryRegistryStorage } from '../impls/memory-registry-storage.js';
import { inMemoryBundleStorage } from '../impls/memory-bundle-storage.js';
import { base64Encode, sha384Base64 } from '../utils/base64.js';

const PUBLIC_GADGET_MANIFEST: ArtifactManifest = {
  kind: 'gadget',
  scope: '@sigstore-real',
  name: 'weather',
  version: '1.0.0',
  bundle: 'src/index.ts',
  visibility: 'public',
  description: 'A real-crypto sigstore publish fixture',
  tags: ['f3', 'sigstore-real'],
  exports: [
    {
      hook: 'useWeather',
      description: 'A real-crypto sigstore publish fixture',
      usage: 'Renders a weather card for a given city',
      example: { city: 'SF' },
    },
  ],
} as ArtifactManifest;

const VALID_BUNDLE_TEXT = `
import { useState } from 'react';
import { jsx } from 'react/jsx-runtime';
export function useWeather() { return { temp: 72 }; }
`;

describe('publishArtifact — real sigstore crypto (F3)', () => {
  let stack: SigstoreMockStack;

  beforeAll(async () => {
    stack = await startSigstoreMockStack();
  });

  afterAll(() => {
    stack.teardown();
  });

  function deps(
    storage = inMemoryRegistryStorage(),
    overrides: Partial<PublishArtifactDeps> = {},
  ): PublishArtifactDeps {
    return {
      storage,
      bundleStorage: inMemoryBundleStorage({ bundleHost: 'http://localhost:9001' }),
      authn: { subject: 'public-publisher-1' },
      clock: () => new Date('2026-08-10T12:00:00.000Z'),
      registryHostname: 'localhost:9001',
      sigstoreTuf: stack.tuf,
      ...overrides,
    };
  }

  async function signedGadget(): Promise<{
    bundleBytes: Uint8Array;
    signature: SigstoreSignature;
  }> {
    const bundleBytes = new TextEncoder().encode(VALID_BUNDLE_TEXT);
    const signature = await signBundleSigstore({
      bundleBytes,
      identityToken: stack.identityToken(),
      endpoints: stack.signEndpoints,
    });
    return { bundleBytes, signature };
  }

  it('public gadget publish: real sign → F1 gate → F0 claim → REAL verify → 201 with the genuine leaf cert pinned', async () => {
    const storage = inMemoryRegistryStorage();
    const { bundleBytes, signature } = await signedGadget();

    const result = await publishArtifact(
      {
        manifest: PUBLIC_GADGET_MANIFEST,
        bundle: base64Encode(bundleBytes),
        bundleSha384: sha384Base64(bundleBytes),
        signature,
      },
      deps(storage),
    );

    expect(result.ok, `publish failed: ${JSON.stringify(result.body)}`).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);
    expect(result.body.artifactId).toBe('@sigstore-real/weather');

    // The version row pins the REAL Fulcio-mock leaf cert (v0.3
    // single-certificate bundle shape — the F3 discovery that the old
    // hand-built fixtures never exercised).
    const row = await storage.getArtifactVersion('@sigstore-real/weather', '1.0.0');
    expect(row?.visibility).toBe('public');
    const leaf = extractSigstoreLeafCertPem(signature);
    expect(leaf).toBeDefined();
    expect(row?.authorPublicKey).toBe(leaf);
    // Decodes to genuine DER (ASN.1 SEQUENCE tag).
    expect(Buffer.from(leaf!, 'base64')[0]).toBe(0x30);

    // F0 passed honestly: the publish claimed the scope for the caller.
    const owner = await storage.getScopeOwner('@sigstore-real');
    expect(owner?.ownerSubject).toBe('public-publisher-1');
    expect(owner?.verification).toBe('unverified');

    // Public row → listable. The op-level half of the L3 wire
    // assertion (search lists the sigstore-published public row).
    const search = await searchArtifacts({ kind: 'gadget' }, { storage });
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(
      search.body.results.map((r) => r.artifactId),
    ).toContain('@sigstore-real/weather');
  });

  it('REAL crypto rejects a transplanted signature with 400 signature_invalid', async () => {
    const storage = inMemoryRegistryStorage();
    // Sign DIFFERENT bytes, then present the published bundle with a
    // corrected fast-hash claim — only the genuine cryptographic
    // check inside verifyBundleSigstore can catch this.
    const publishedBytes = new TextEncoder().encode(VALID_BUNDLE_TEXT);
    const otherBytes = new TextEncoder().encode('export function useWeather(){return 1;}');
    const foreign = await signBundleSigstore({
      bundleBytes: otherBytes,
      identityToken: stack.identityToken(),
      endpoints: stack.signEndpoints,
    });
    const transplanted: SigstoreSignature = {
      ...foreign,
      bundleSha384: sha384Base64(publishedBytes),
    };

    const result = await publishArtifact(
      {
        manifest: PUBLIC_GADGET_MANIFEST,
        bundle: base64Encode(publishedBytes),
        bundleSha384: sha384Base64(publishedBytes),
        signature: transplanted,
      },
      deps(storage),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('signature_invalid');
    expect(result.body.message).toMatch(/sigstore verification failed/);
    // No row lands on a failed verify.
    expect(await storage.getArtifactVersion('@sigstore-real/weather', '1.0.0')).toBe(
      null,
    );
  });

  it('F1 pairing rejects a REAL sigstore signature on a private manifest', async () => {
    const { bundleBytes, signature } = await signedGadget();
    const privateManifest: ArtifactManifest = {
      ...PUBLIC_GADGET_MANIFEST,
      visibility: 'private',
    } as ArtifactManifest;

    const result = await publishArtifact(
      {
        manifest: privateManifest,
        bundle: base64Encode(bundleBytes),
        bundleSha384: sha384Base64(bundleBytes),
        signature,
      },
      deps(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('visibility_algorithm_mismatch');
  });

  it('public blueprint publish: real sign over canonical manifest bytes → 201 + leaf pinned', async () => {
    const storage = inMemoryRegistryStorage();
    const blueprintManifest: ArtifactManifest = {
      kind: 'blueprint',
      scope: '@sigstore-real',
      name: 'login',
      version: '0.1.0',
      visibility: 'public',
      description: 'A real-crypto sigstore blueprint fixture',
      source: 'export default function Login(){ return <div>Login</div>; }',
      variance: { persona: 'casual-shopper', seedPrompt: 'A simple login form' },
    } as ArtifactManifest;

    // Blueprints sign canonicalJson(manifest) — no bundle bytes.
    const payload = new TextEncoder().encode(canonicalJson(blueprintManifest));
    const signature = await signBundleSigstore({
      bundleBytes: payload,
      identityToken: stack.identityToken(),
      endpoints: stack.signEndpoints,
    });

    const result = await publishArtifact(
      { manifest: blueprintManifest, signature },
      deps(storage),
    );
    expect(result.ok, `publish failed: ${JSON.stringify(result.body)}`).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);
    expect(result.body.installCommand).toContain('ggui blueprint install');

    const row = await storage.getArtifactVersion('@sigstore-real/login', '0.1.0');
    expect(row?.compiledDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.authorPublicKey).toBe(extractSigstoreLeafCertPem(signature));
  });
});
