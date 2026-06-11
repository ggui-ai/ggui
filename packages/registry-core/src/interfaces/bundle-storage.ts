/**
 * `BundleStorage` — bundle + signature + manifest blob storage. A
 * hosted implementation may serve blobs from object storage behind a
 * CDN; the open-source server backs it with the filesystem under
 * `<root>/bundles/<scope>/<name>/<version>/`. A memory impl is
 * provided for tests.
 *
 * Each `put*` method returns the fully-qualified URL the consumer
 * (iframe runtime, install CLI) can fetch. The URL prefix is
 * determined by the impl's constructor — a CDN alias for a
 * CDN-fronted implementation, or `http://localhost:9001` (or
 * whatever the server is bound to) for the open-source server.
 *
 * Bundles are immutable post-publish. Responses MUST emit
 * `Cache-Control: public, max-age=31536000, immutable` — SRI integrity
 * depends on it. The OSS server's bundle route sets this header
 * explicitly; a CDN-fronted implementation sets it via its cache
 * policy.
 *
 * ## Protocol & Contract Bar
 *
 * **Parties:**
 * - Producer: {@link publishArtifact} writes bundle (gadgets),
 *   signature (gadgets), and manifest (always) on every publish.
 * - Consumer: iframe-runtime (bundleUrl), install CLI (signatureUrl,
 *   manifestUrl), audit tooling (manifestUrl on yanked versions).
 *
 * **Obligations:**
 * - `put*` methods MUST be idempotent — re-publishes of the same
 *   `(scope, name, version)` triple write identical bytes (the
 *   per-version row immutability invariant on {@link RegistryStorage}
 *   prevents true re-publishes; the bundle-storage layer needs no
 *   conflict semantics).
 * - URL composition methods (`bundleUrl`, `signatureUrl`,
 *   `manifestUrl`) MUST be pure — no I/O, no async. Consumers cache
 *   URLs liberally.
 *
 * **Failure mode:**
 * - Transport-level failures throw; the publish op wraps and returns
 *   500.
 * - Missing-blob reads return `null`; never throw.
 *
 * **Observable violation:**
 * - Contract test {@link bundleStorageContract} covers: bundle
 *   round-trip preserves bytes; signature round-trip preserves the
 *   structured object; manifest round-trip preserves the full
 *   discriminated-union shape; URL methods compose without side effects;
 *   missing reads return null.
 */
import type { ArtifactManifest } from '@ggui-ai/artifact-manifest';
import type { GadgetSignature } from '@ggui-ai/gadget-signing';

export interface BundleStorage {
  /** Write gadget bundle bytes. Returns the public URL. */
  putBundle(scope: string, name: string, version: string, bytes: Uint8Array): Promise<string>;
  /** Read gadget bundle bytes. `null` on miss. */
  getBundle(scope: string, name: string, version: string): Promise<Uint8Array | null>;

  /**
   * Write the signature envelope. Returns the public URL.
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
    signature: GadgetSignature,
  ): Promise<string>;
  /** Read the signature envelope. `null` on miss. */
  getSignature(
    scope: string,
    name: string,
    version: string,
  ): Promise<GadgetSignature | null>;

  /** Write the manifest verbatim. Returns the public URL. */
  putManifest(
    scope: string,
    name: string,
    version: string,
    manifest: ArtifactManifest,
  ): Promise<string>;
  /** Read the manifest. `null` on miss. */
  getManifest(
    scope: string,
    name: string,
    version: string,
  ): Promise<ArtifactManifest | null>;

  /** Compose the public bundle URL. No I/O. */
  bundleUrl(scope: string, name: string, version: string): string;
  /** Compose the public signature URL. No I/O. */
  signatureUrl(scope: string, name: string, version: string): string;
  /** Compose the public manifest URL. No I/O. */
  manifestUrl(scope: string, name: string, version: string): string;
}
