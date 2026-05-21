/**
 * Source-contract types for UI artifacts.
 *
 * Studio (hosted), local `ggui dev` (filesystem-backed), and any
 * future UI source implement {@link UiRegistry}. The contract
 * spans reads (required) + optional writes + optional change
 * subscriptions. Deliberately does NOT include search, ranking,
 * embeddings, or sync — those live at higher layers (see
 * `BlueprintProvider` in `@ggui-ai/mcp-server-core`).
 *
 * Design rules this shape enforces:
 *
 * 1. **Identity comes from the manifest, not the registry.** Two
 *    registries serving the same logical UI return entries with
 *    the same `id`. `contentHash` distinguishes versions; `id`
 *    survives edits.
 * 2. **Bundles and manifests are separable.** `list` / `get`
 *    return metadata. `getBundle` fetches the compiled artifact.
 *    Consumers that only need the catalog never pay for compiled
 *    bytes.
 * 3. **Capability probe is data, not duck typing.** Don't
 *    `try/catch` optional methods — read `capabilities.writable`
 *    / `capabilities.observable` first. Keeps the contract
 *    declarative.
 * 4. **Write outcome is discriminated.** `WriteResult` is a tagged
 *    union so callers handle `id-conflict`, `validation-failed`,
 *    and `not-supported` explicitly. No throw-to-signal.
 */
import type { UiManifest } from '@ggui-ai/project-config';

/**
 * A single UI entry as served by a registry — the authoring
 * manifest plus the version-marker for the compiled artifact.
 *
 * `id` is the stable identity from `ggui.ui.json#id`; it MUST
 * equal `manifest.id`. Registries that store both fields MUST
 * keep them in sync.
 */
export interface UiManifestEntry {
  /** Stable, machine-oriented identity. Equals `manifest.id`. */
  id: string;

  /**
   * Content hash of the compiled bundle — the artifact-version
   * marker. Registries use this for conflict detection on writes:
   * the client computes the target hash, includes it in the
   * request, and the registry rejects mismatches.
   *
   * A registry that doesn't (yet) compile sources MAY populate
   * this from `manifest.contentHash` when present, or leave it as
   * an empty string for dev-only sources. Production registries
   * SHOULD always have a real hash.
   */
  contentHash: string;

  /** Full authored manifest. */
  manifest: UiManifest;
}

/**
 * The compiled artifact ready to render.
 *
 * `code` is either an inline string (small bundles, dev servers)
 * or a streamable `ReadableStream` (large bundles, cloud origins).
 * Consumers that stream SHOULD check whether the bundle exceeds
 * their in-memory budget before calling `.text()`.
 */
export interface UiBundle {
  /** Compiled JS (usually ESM). Use a stream for large bundles. */
  code: string | ReadableStream;
  /** Optional inline source-map (usually base64 data URL). */
  sourceMap?: string;
  /** MIME / content type, e.g. `'application/javascript+react'`. */
  contentType: string;
}

/**
 * Change event emitted by an observable registry (local file
 * watcher, cloud fan-out, etc.). Registries that don't observe
 * return `capabilities.observable === false` and don't implement
 * `subscribe`.
 */
export type UiRegistryEvent =
  | { type: 'added'; id: string }
  | { type: 'changed'; id: string; contentHash: string }
  | { type: 'removed'; id: string };

/**
 * Discriminated write outcome. Success carries the new
 * `contentHash`. Failures name a specific reason so callers can
 * react without parsing error messages.
 *
 * - `id-conflict` — the registry already has an entry for `id`
 *   with a different hash. Caller decides whether to force-replace
 *   (re-write with the conflicting hash) or merge.
 * - `validation-failed` — the registry ran schema / policy checks
 *   and the entry didn't pass. `issues` is human-readable.
 * - `not-supported` — the registry is read-only or can't write
 *   this particular entry shape. Caller should have probed
 *   `capabilities.writable` first; this is a belt-and-suspenders
 *   signal for implementations that discover limitations late.
 */
export type WriteResult =
  | { ok: true; contentHash: string }
  | { ok: false; reason: 'id-conflict'; existingHash: string }
  | { ok: false; reason: 'validation-failed'; issues: string[] }
  | { ok: false; reason: 'not-supported'; message?: string };

/**
 * Capability probe. Callers consult these flags to branch the UI
 * (show/hide "Publish", show/hide "Live reload") instead of
 * detecting methods at runtime.
 */
export interface UiRegistryCapabilities {
  /** `true` if `write` + `remove` are safe to call. */
  readonly writable: boolean;
  /** `true` if `subscribe` is implemented. */
  readonly observable: boolean;
}

/**
 * The source contract every UI registry implements.
 *
 * Read methods are required. Write + subscribe are optional; pair
 * each with its `capabilities` flag so callers can probe before
 * invoking.
 */
export interface UiRegistry {
  /**
   * Enumerate every UI in this registry. Order is implementation-
   * defined — callers that care about stable ordering should sort
   * by `id` or `manifest.name`. Large registries MAY paginate in
   * future revisions; v1 returns the full set.
   */
  list(): Promise<UiManifestEntry[]>;

  /**
   * Fetch a single entry by id. Returns `undefined` when the id
   * isn't present — NOT an error. Throw only on transport /
   * permission failures.
   */
  get(id: string): Promise<UiManifestEntry | undefined>;

  /**
   * Fetch the compiled bundle for an id. Returns `undefined` when
   * the id isn't present OR when the registry has a manifest but
   * no compiled artifact (e.g. source-only dev registry).
   */
  getBundle(id: string): Promise<UiBundle | undefined>;

  /**
   * Subscribe to change events. Present only when
   * `capabilities.observable === true`. Returns an unsubscribe
   * function. Registries MAY replay recent events on subscribe;
   * consumers MUST be idempotent to duplicates.
   */
  subscribe?(handler: (event: UiRegistryEvent) => void): () => void;

  /**
   * Add or replace an entry. Present only when
   * `capabilities.writable === true`.
   *
   * `bundle` is optional because some registries (e.g. a
   * manifest-only index) only track metadata. Registries that
   * require bundles MUST reject a bundle-less write with
   * `not-supported`.
   */
  write?(
    entry: UiManifestEntry,
    bundle?: UiBundle,
  ): Promise<WriteResult>;

  /**
   * Delete an entry by id. Present only when
   * `capabilities.writable === true`. No-op for missing ids.
   */
  remove?(id: string): Promise<void>;

  /** Capability probe. Always present, always truthful. */
  readonly capabilities: UiRegistryCapabilities;
}
