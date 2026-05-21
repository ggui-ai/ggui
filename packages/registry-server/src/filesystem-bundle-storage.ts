/**
 * Filesystem-backed {@link BundleStorage} for the OSS registry server.
 *
 * Blob layout:
 *
 *   <root>/bundles/<scope>/<name>/<version>/bundle.js
 *   <root>/bundles/<scope>/<name>/<version>/bundle.js.sig
 *   <root>/bundles/<scope>/<name>/<version>/manifest.json
 *
 * Scope is written verbatim (`@my-org/...`) because the leading `@`
 * is filename-safe on every supported OS. The URL composition mirrors
 * the same path so the public URL the install CLI follows resolves
 * directly against the file (the hono server's `/bundles/*` route
 * streams the file).
 *
 * ## Path-traversal defense
 *
 * Every {scope, name, version} input is checked for `..`, `/`
 * (except the leading scope `@` which contains no `/`), and `\\`.
 * Scopes contain a single leading `@` then `[a-z0-9-]+` per the
 * manifest schema; `name` is kebab-case; `version` is semver. We reject
 * defensively at the storage layer in addition to the schema enforcement.
 *
 * ## Immutability
 *
 * Re-puts overwrite the file — the per-version row immutability
 * invariant on {@link RegistryStorage.putArtifactVersionIfAbsent}
 * prevents true re-publishes from ever reaching this layer, so
 * overwrite-on-collision is safe (in practice unreachable).
 *
 * ## Protocol & Contract Bar
 *
 * Inherits the {@link BundleStorage} contract verbatim. The contract
 * test exercises bundle / signature / manifest round-trips + URL
 * composition + missing-blob reads (returns null, never throws).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactManifest } from '@ggui-ai/artifact-manifest';
import { isGadgetSignature } from '@ggui-ai/gadget-signing';
import type { BundleStorage } from '@ggui-ai/registry-core';

export interface FilesystemBundleStorageOptions {
  /** Absolute path to the bundle storage root. */
  readonly root: string;
  /**
   * URL prefix for `bundleUrl` / `signatureUrl` / `manifestUrl`. Must
   * not end with a slash. Example: `http://localhost:9001`.
   */
  readonly bundleHost: string;
}

export function createFilesystemBundleStorage(
  options: FilesystemBundleStorageOptions,
): BundleStorage {
  const bundlesRoot = join(options.root, 'bundles');
  const bundleHost = stripTrailingSlash(options.bundleHost);

  const dirFor = (scope: string, name: string, version: string): string => {
    rejectTraversal(scope, 'scope');
    rejectTraversal(name, 'name');
    rejectTraversal(version, 'version');
    return join(bundlesRoot, scope, name, version);
  };

  return {
    async putBundle(scope, name, version, bytes) {
      const dir = dirFor(scope, name, version);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'bundle.js'), bytes);
      return this.bundleUrl(scope, name, version);
    },
    async getBundle(scope, name, version) {
      const path = join(dirFor(scope, name, version), 'bundle.js');
      return readFileOrNull(path);
    },
    async putSignature(scope, name, version, signature) {
      const dir = dirFor(scope, name, version);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'bundle.js.sig'),
        JSON.stringify(signature, null, 2),
        'utf8',
      );
      return this.signatureUrl(scope, name, version);
    },
    async getSignature(scope, name, version) {
      const path = join(dirFor(scope, name, version), 'bundle.js.sig');
      const text = await readTextOrNull(path);
      if (text === null) return null;
      // Runtime-validate the parsed shape against the `GadgetSignature`
      // union so a malformed on-disk signature can't slip through.
      // Force-narrowing to `Ed25519Signature` would compile clean but
      // would silently drop the sigstore-only fields of a sigstore
      // signature, since both signature kinds persist here.
      const parsed: unknown = JSON.parse(text);
      if (!isGadgetSignature(parsed)) return null;
      return parsed;
    },
    async putManifest(scope, name, version, manifest) {
      const dir = dirFor(scope, name, version);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8',
      );
      return this.manifestUrl(scope, name, version);
    },
    async getManifest(scope, name, version) {
      const path = join(dirFor(scope, name, version), 'manifest.json');
      const text = await readTextOrNull(path);
      return text === null ? null : (JSON.parse(text) as ArtifactManifest);
    },
    bundleUrl(scope, name, version) {
      rejectTraversal(scope, 'scope');
      rejectTraversal(name, 'name');
      rejectTraversal(version, 'version');
      return `${bundleHost}/bundles/${scope}/${name}/${version}/bundle.js`;
    },
    signatureUrl(scope, name, version) {
      rejectTraversal(scope, 'scope');
      rejectTraversal(name, 'name');
      rejectTraversal(version, 'version');
      return `${bundleHost}/bundles/${scope}/${name}/${version}/bundle.js.sig`;
    },
    manifestUrl(scope, name, version) {
      rejectTraversal(scope, 'scope');
      rejectTraversal(name, 'name');
      rejectTraversal(version, 'version');
      return `${bundleHost}/bundles/${scope}/${name}/${version}/manifest.json`;
    },
  };
}

/**
 * Defensive path-traversal reject. `scope`, `name`, `version` are all
 * regex-validated by the manifest schema at parse time. This is the
 * second wall — if a caller bypasses the schema, the storage layer
 * still rejects. Scope is allowed to contain a single `/` ONLY if it's
 * the first character after `@` AND the value is exactly the canonical
 * scope form — but scopes are `@ns` (no `/`), so `/` is unambiguously
 * rejected here.
 */
function rejectTraversal(value: string, fieldName: string): void {
  if (value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new Error(
      `path-traversal: filesystem bundle storage rejects ${fieldName}=${JSON.stringify(value)} (contains "..", "/", or "\\")`,
    );
  }
}

async function readFileOrNull(path: string): Promise<Uint8Array | null> {
  try {
    const buf = await readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
