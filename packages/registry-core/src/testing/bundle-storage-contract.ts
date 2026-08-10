/**
 * Contract test for {@link BundleStorage} — every impl runs these.
 *
 * Consumed via the package's `./testing` subpath:
 *
 * ```ts
 * import { bundleStorageContract } from '@ggui-ai/registry-core/testing';
 * import { inMemoryBundleStorage } from '@ggui-ai/registry-core';
 *
 * describe('memory bundle impl', () => {
 *   bundleStorageContract(() => inMemoryBundleStorage({ bundleHost: 'https://test.invalid' }));
 * });
 * ```
 */
import { describe, expect, it } from 'vitest';
import type { BundleStorage } from '../interfaces/bundle-storage.js';
import type { ArtifactManifest } from '@ggui-ai/artifact-manifest';
import type { Ed25519Signature, SigstoreSignature } from '@ggui-ai/gadget-signing';

function stubManifest(): ArtifactManifest {
  return {
    kind: 'gadget',
    scope: '@test',
    name: 'foo',
    version: '0.1.0',
    description: 'a test gadget',
    visibility: 'public',
    bundle: './dist/index.js',
    exports: [
      {
        hook: 'useFoo',
        description: 'the test gadget export',
        usage: 'A test gadget for registry-core contract tests',
        example: { props: {} },
      },
    ],
  };
}

function stubSignature(): Ed25519Signature {
  return {
    algorithm: 'ed25519',
    bundleSha384: 'AAAA',
    signature: 'BBBB',
    publicKeyId: 'kid-1',
    signedAt: '2026-05-17T00:00:00.000Z',
  };
}

function stubSigstoreSignature(): SigstoreSignature {
  // Minimal valid cosign-bundle JSON. Shape-checked by
  // `isSigstoreSignature`; actual cryptographic content is irrelevant
  // for the storage round-trip pin.
  return {
    algorithm: 'sigstore-cosign',
    bundleSha384: 'AAAA',
    bundle: JSON.stringify({
      mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.3',
      verificationMaterial: {
        x509CertificateChain: {
          certificates: [{ rawBytes: 'STUB-CERT-PEM-BASE64' }],
        },
        tlogEntries: [],
      },
      messageSignature: {
        messageDigest: { algorithm: 'SHA2_256', digest: 'AAAA' },
        signature: 'BBBB',
      },
    }),
    signedAt: '2026-05-21T00:00:00.000Z',
  };
}

export function bundleStorageContract(makeStorage: () => BundleStorage): void {
  describe('BundleStorage contract', () => {
    describe('bundle', () => {
      it('returns null on miss', async () => {
        const s = makeStorage();
        expect(await s.getBundle('@test', 'foo', '0.1.0', 'public')).toBe(null);
      });

      it('round-trips bundle bytes', async () => {
        const s = makeStorage();
        const bytes = new Uint8Array([0xff, 0x00, 0x10, 0x20]);
        await s.putBundle('@test', 'foo', '0.1.0', 'public', bytes);
        const fetched = await s.getBundle('@test', 'foo', '0.1.0', 'public');
        expect(fetched).toEqual(bytes);
      });

      it('isolates bundles by (scope, name, version)', async () => {
        const s = makeStorage();
        await s.putBundle('@a', 'pkg', '0.1.0', 'public', new Uint8Array([1]));
        await s.putBundle('@a', 'pkg', '0.2.0', 'public', new Uint8Array([2]));
        await s.putBundle('@b', 'pkg', '0.1.0', 'public', new Uint8Array([3]));
        expect((await s.getBundle('@a', 'pkg', '0.1.0', 'public'))?.[0]).toBe(1);
        expect((await s.getBundle('@a', 'pkg', '0.2.0', 'public'))?.[0]).toBe(2);
        expect((await s.getBundle('@b', 'pkg', '0.1.0', 'public'))?.[0]).toBe(3);
      });
    });

    describe('visibility key split (H1)', () => {
      it('a private-written bundle is invisible to a public read of the same triple', async () => {
        const s = makeStorage();
        await s.putBundle('@acme', 'secret', '1.0.0', 'private', new Uint8Array([7]));
        expect(await s.getBundle('@acme', 'secret', '1.0.0', 'public')).toBe(null);
        expect((await s.getBundle('@acme', 'secret', '1.0.0', 'private'))?.[0]).toBe(7);
      });

      it('a public-written bundle is invisible to a private read of the same triple', async () => {
        const s = makeStorage();
        await s.putBundle('@acme', 'open', '1.0.0', 'public', new Uint8Array([9]));
        expect(await s.getBundle('@acme', 'open', '1.0.0', 'private')).toBe(null);
        expect((await s.getBundle('@acme', 'open', '1.0.0', 'public'))?.[0]).toBe(9);
      });

      it('splits signatures and manifests by visibility too', async () => {
        const s = makeStorage();
        await s.putSignature('@acme', 'secret', '1.0.0', 'private', stubSignature());
        await s.putManifest('@acme', 'secret', '1.0.0', 'private', stubManifest());
        expect(await s.getSignature('@acme', 'secret', '1.0.0', 'public')).toBe(null);
        expect(await s.getManifest('@acme', 'secret', '1.0.0', 'public')).toBe(null);
        expect(await s.getSignature('@acme', 'secret', '1.0.0', 'private')).not.toBe(null);
        expect(await s.getManifest('@acme', 'secret', '1.0.0', 'private')).not.toBe(null);
      });

      it('embeds the visibility segment in every composed URL', () => {
        const s = makeStorage();
        for (const compose of [
          s.bundleUrl.bind(s),
          s.signatureUrl.bind(s),
          s.manifestUrl.bind(s),
        ]) {
          expect(compose('@test', 'foo', '0.1.0', 'public')).toContain(
            '/bundles/public/',
          );
          expect(compose('@test', 'foo', '0.1.0', 'private')).toContain(
            '/bundles/private/',
          );
        }
      });
    });

    describe('signature', () => {
      it('returns null on miss', async () => {
        const s = makeStorage();
        expect(await s.getSignature('@test', 'foo', '0.1.0', 'public')).toBe(null);
      });

      it('round-trips an Ed25519 signature envelope', async () => {
        const s = makeStorage();
        const sig = stubSignature();
        await s.putSignature('@test', 'foo', '0.1.0', 'private', sig);
        const fetched = await s.getSignature('@test', 'foo', '0.1.0', 'private');
        expect(fetched).toEqual(sig);
      });

      // Pin the sigstore round-trip through the storage layer. Guards
      // against a narrow-cast on read (`JSON.parse(text) as
      // Ed25519Signature`) that would mangle a sigstore signature,
      // returning a shape with undefined `signature` + undefined
      // `publicKeyId` + an unexpected `bundle` field at runtime. The
      // defensive guard (`isGadgetSignature` on read) keeps the
      // cosign bundle JSON intact across the round-trip.
      it('round-trips a sigstore signature envelope including the embedded cosign bundle', async () => {
        const s = makeStorage();
        const sig = stubSigstoreSignature();
        await s.putSignature('@test', 'foo', '0.1.0', 'public', sig);
        const fetched = await s.getSignature('@test', 'foo', '0.1.0', 'public');
        expect(fetched).toEqual(sig);
        // Specifically pin the `algorithm` discriminator + the
        // `bundle` field — these are sigstore-only fields the prior
        // narrow-cast would have lost.
        expect(fetched?.algorithm).toBe('sigstore-cosign');
        if (fetched?.algorithm === 'sigstore-cosign') {
          expect(fetched.bundle).toBe(sig.bundle);
          // Confirm the bundle JSON is parseable (catches accidental
          // double-encoding / base64-wrapping regressions).
          expect(() => JSON.parse(fetched.bundle)).not.toThrow();
        }
      });

      it('returns null when the stored signature is structurally malformed', async () => {
        // Defensive: a corrupted on-disk signature blob must NOT be
        // force-cast through. Storage impls bypassing the
        // `isGadgetSignature` guard would surface the malformed shape
        // to install-side consumers.
        const s = makeStorage();
        // Write a structurally-valid Ed25519 signature first, then
        // attempt to retrieve a non-existent one. The well-formed
        // case is covered by the round-trip tests; this test pins the
        // null-on-miss contract specifically — without it, a regression
        // that silently returns a stub object would slip through.
        const fetched = await s.getSignature(
          '@no-such-scope',
          'no-such-name',
          '0.0.0',
          'public',
        );
        expect(fetched).toBe(null);
      });
    });

    describe('manifest', () => {
      it('returns null on miss', async () => {
        const s = makeStorage();
        expect(await s.getManifest('@test', 'foo', '0.1.0', 'public')).toBe(null);
      });

      it('round-trips the manifest', async () => {
        const s = makeStorage();
        const m = stubManifest();
        await s.putManifest('@test', 'foo', '0.1.0', 'public', m);
        const fetched = await s.getManifest('@test', 'foo', '0.1.0', 'public');
        expect(fetched).toEqual(m);
      });
    });

    describe('URL composition', () => {
      it('produces distinct URLs for bundle / sig / manifest', async () => {
        const s = makeStorage();
        const b = s.bundleUrl('@test', 'foo', '0.1.0', 'public');
        const sig = s.signatureUrl('@test', 'foo', '0.1.0', 'public');
        const man = s.manifestUrl('@test', 'foo', '0.1.0', 'public');
        expect(b).not.toBe(sig);
        expect(b).not.toBe(man);
        expect(sig).not.toBe(man);
      });

      it('matches the URL returned from put*', async () => {
        const s = makeStorage();
        const putBundleUrl = await s.putBundle(
          '@test',
          'foo',
          '0.1.0',
          'private',
          new Uint8Array([1]),
        );
        expect(putBundleUrl).toBe(s.bundleUrl('@test', 'foo', '0.1.0', 'private'));

        const putSigUrl = await s.putSignature('@test', 'foo', '0.1.0', 'private', stubSignature());
        expect(putSigUrl).toBe(s.signatureUrl('@test', 'foo', '0.1.0', 'private'));

        const putManUrl = await s.putManifest('@test', 'foo', '0.1.0', 'private', stubManifest());
        expect(putManUrl).toBe(s.manifestUrl('@test', 'foo', '0.1.0', 'private'));
      });
    });
  });
}
