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
import type { Visibility } from '../types.js';

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

  // Visibility segments the key (H1 prefix split) — a blob written
  // `public` must be invisible to a `private` read of the same triple,
  // exactly like the prefix-split object keys of the durable impls.
  const key = (
    scope: string,
    name: string,
    version: string,
    visibility: Visibility,
  ): string => `${visibility}/${scope}/${name}/${version}`;

  return {
    async putBundle(scope, name, version, visibility, bytes) {
      bundles.set(key(scope, name, version, visibility), new Uint8Array(bytes));
      return this.bundleUrl(scope, name, version, visibility);
    },
    async getBundle(scope, name, version, visibility) {
      const bytes = bundles.get(key(scope, name, version, visibility));
      return bytes === undefined ? null : new Uint8Array(bytes);
    },
    async putSignature(scope, name, version, visibility, signature) {
      signatures.set(key(scope, name, version, visibility), signature);
      return this.signatureUrl(scope, name, version, visibility);
    },
    async getSignature(scope, name, version, visibility) {
      return signatures.get(key(scope, name, version, visibility)) ?? null;
    },
    async putManifest(scope, name, version, visibility, manifest) {
      manifests.set(key(scope, name, version, visibility), manifest);
      return this.manifestUrl(scope, name, version, visibility);
    },
    async getManifest(scope, name, version, visibility) {
      return manifests.get(key(scope, name, version, visibility)) ?? null;
    },
    bundleUrl(scope, name, version, visibility) {
      return `${bundleHost}/bundles/${visibility}/${scope}/${name}/${version}/bundle.js`;
    },
    signatureUrl(scope, name, version, visibility) {
      return `${bundleHost}/bundles/${visibility}/${scope}/${name}/${version}/bundle.js.sig`;
    },
    manifestUrl(scope, name, version, visibility) {
      return `${bundleHost}/bundles/${visibility}/${scope}/${name}/${version}/manifest.json`;
    },
  };
}
