/**
 * `BundleStorage` — bundle + signature + manifest blob storage. A
 * hosted implementation may serve blobs from object storage behind a
 * CDN; the open-source server backs it with the filesystem under
 * `<root>/bundles/<visibility>/<scope>/<name>/<version>/`. A memory
 * impl is provided for tests.
 *
 * Each `put*` method returns the fully-qualified URL the consumer
 * (iframe runtime, install CLI) can fetch. The URL prefix is
 * determined by the impl's constructor — a CDN alias for a
 * CDN-fronted implementation, or `http://localhost:9001` (or
 * whatever the server is bound to) for the open-source server.
 *
 * ## Visibility-split key layout (load-bearing)
 *
 * Every blob lives under a visibility-segmented key:
 *
 *   bundles/public/<scope>/<name>/<version>/{bundle.js,bundle.js.sig,manifest.json}
 *   bundles/private/<scope>/<name>/<version>/{...}
 *
 * Placement IS the access-control boundary: the `bundles/public/`
 * prefix may be served anonymously (CDN, static route); the
 * `bundles/private/` prefix MUST only be reachable through an
 * authenticated route that authorizes the caller against the
 * artifact's publisher or scope owner. An impl that flattens the two
 * prefixes back together silently republishes every private artifact.
 *
 * Bundles are immutable post-publish. Public-prefix responses MUST
 * emit `Cache-Control: public, max-age=31536000, immutable` — SRI
 * integrity depends on it. Private-prefix responses stay immutable but
 * MUST NOT be shared-cacheable (`Cache-Control: private, …`). The OSS
 * server's bundle routes set these headers explicitly; a CDN-fronted
 * implementation sets the public policy on its cache behavior.
 *
 * ## Protocol & Contract Bar
 *
 * **Parties:**
 * - Producer: {@link publishArtifact} writes bundle (gadgets),
 *   signature (gadgets), and manifest (always) on every publish, at
 *   the key the manifest's `visibility` selects.
 * - Consumer: iframe-runtime (bundleUrl), install CLI (signatureUrl,
 *   manifestUrl), audit tooling (manifestUrl on yanked versions).
 *
 * **Obligations:**
 * - `put*` methods MUST be idempotent — re-publishes of the same
 *   `(scope, name, version)` triple write identical bytes (the
 *   per-version row immutability invariant on {@link RegistryStorage}
 *   prevents true re-publishes; the bundle-storage layer needs no
 *   conflict semantics).
 * - Key composition MUST segment on `visibility` — a blob written
 *   `public` is invisible to a `private` read of the same triple, and
 *   vice versa.
 * - URL composition methods (`bundleUrl`, `signatureUrl`,
 *   `manifestUrl`) MUST be pure — no I/O, no async — and MUST embed
 *   the same visibility segment the corresponding `put*` used, so the
 *   persisted row URLs point at the blob's real location. Consumers
 *   cache URLs liberally.
 *
 * **Failure mode:**
 * - Transport-level failures throw; the publish op wraps and returns
 *   500.
 * - Missing-blob reads return `null`; never throw. A visibility
 *   mismatch reads as a miss.
 *
 * **Observable violation:**
 * - Contract test {@link bundleStorageContract} covers: bundle
 *   round-trip preserves bytes; signature round-trip preserves the
 *   structured object; manifest round-trip preserves the full
 *   discriminated-union shape; URL methods compose without side effects
 *   and embed the visibility segment; missing reads return null;
 *   cross-visibility reads return null.
 */
import type { ArtifactManifest } from '@ggui-ai/artifact-manifest';
import type { GadgetSignature } from '@ggui-ai/gadget-signing';
import type { Visibility } from '../types.js';

export interface BundleStorage {
  /** Write gadget bundle bytes. Returns the fetch URL. */
  putBundle(
    scope: string,
    name: string,
    version: string,
    visibility: Visibility,
    bytes: Uint8Array,
  ): Promise<string>;
  /** Read gadget bundle bytes. `null` on miss (including visibility mismatch). */
  getBundle(
    scope: string,
    name: string,
    version: string,
    visibility: Visibility,
  ): Promise<Uint8Array | null>;

  /**
   * Write the signature envelope. Returns the fetch URL.
   *
   * The envelope is a {@link GadgetSignature} — a discriminated union
   * over `algorithm` (`ed25519` for private gadgets, `sigstore-cosign`
   * for public). Impls serialize via `JSON.stringify(signature)` and
   * store the resulting bytes verbatim.
   */
  putSignature(
    scope: string,
    name: string,
    version: string,
    visibility: Visibility,
    signature: GadgetSignature,
  ): Promise<string>;
  /** Read the signature envelope. `null` on miss (including visibility mismatch). */
  getSignature(
    scope: string,
    name: string,
    version: string,
    visibility: Visibility,
  ): Promise<GadgetSignature | null>;

  /** Write the manifest verbatim. Returns the fetch URL. */
  putManifest(
    scope: string,
    name: string,
    version: string,
    visibility: Visibility,
    manifest: ArtifactManifest,
  ): Promise<string>;
  /** Read the manifest. `null` on miss (including visibility mismatch). */
  getManifest(
    scope: string,
    name: string,
    version: string,
    visibility: Visibility,
  ): Promise<ArtifactManifest | null>;

  /** Compose the bundle URL (embeds the visibility segment). No I/O. */
  bundleUrl(scope: string, name: string, version: string, visibility: Visibility): string;
  /** Compose the signature URL (embeds the visibility segment). No I/O. */
  signatureUrl(scope: string, name: string, version: string, visibility: Visibility): string;
  /** Compose the manifest URL (embeds the visibility segment). No I/O. */
  manifestUrl(scope: string, name: string, version: string, visibility: Visibility): string;
}
