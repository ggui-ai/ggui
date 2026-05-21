/**
 * In-process {@link BundleStorage} — process-local Maps for the bundle,
 * signature, and manifest blobs. Used by the OSS server's
 * `--storage=memory` mode, by registry-core unit tests, and by e2e
 * harnesses.
 *
 * URL composition uses a configurable `bundleHost` so e2e tests can
 * assert the URL matches the hono server's bound port. Falls back to
 * `https://example.invalid` if the caller doesn't override (unit tests
 * exercising URL composition without a real server).
 */
import type { ArtifactManifest } from '@ggui-ai/artifact-manifest';
import type { GadgetSignature } from '@ggui-ai/gadget-signing';
import type { BundleStorage } from '../interfaces/bundle-storage.js';

export interface InMemoryBundleStorageOptions {
  /**
   * URL prefix for the composed `bundleUrl` / `signatureUrl` /
   * `manifestUrl`. Should not have a trailing slash. Examples:
   *   - cloud parity: `https://dev.registry.sandbox.ggui.ai`
   *   - e2e (per-test): `http://127.0.0.1:<port>`
   */
  readonly bundleHost?: string;
}

export function inMemoryBundleStorage(
  options: InMemoryBundleStorageOptions = {},
): BundleStorage {
  const bundleHost = options.bundleHost ?? 'https://example.invalid';

  const bundles = new Map<string, Uint8Array>();
  const signatures = new Map<string, GadgetSignature>();
  const manifests = new Map<string, ArtifactManifest>();

  const key = (scope: string, name: string, version: string): string =>
    `${scope}/${name}/${version}`;

  return {
    async putBundle(scope, name, version, bytes) {
      bundles.set(key(scope, name, version), new Uint8Array(bytes));
      return this.bundleUrl(scope, name, version);
    },
    async getBundle(scope, name, version) {
      const bytes = bundles.get(key(scope, name, version));
      return bytes === undefined ? null : new Uint8Array(bytes);
    },
    async putSignature(scope, name, version, signature) {
      signatures.set(key(scope, name, version), signature);
      return this.signatureUrl(scope, name, version);
    },
    async getSignature(scope, name, version) {
      return signatures.get(key(scope, name, version)) ?? null;
    },
    async putManifest(scope, name, version, manifest) {
      manifests.set(key(scope, name, version), manifest);
      return this.manifestUrl(scope, name, version);
    },
    async getManifest(scope, name, version) {
      return manifests.get(key(scope, name, version)) ?? null;
    },
    bundleUrl(scope, name, version) {
      return `${bundleHost}/bundles/${scope}/${name}/${version}/bundle.js`;
    },
    signatureUrl(scope, name, version) {
      return `${bundleHost}/bundles/${scope}/${name}/${version}/bundle.js.sig`;
    },
    manifestUrl(scope, name, version) {
      return `${bundleHost}/bundles/${scope}/${name}/${version}/manifest.json`;
    },
  };
}
