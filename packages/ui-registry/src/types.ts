/**
 * Source-contract types for UI artifacts.
 *
 * Local `ggui dev` (filesystem-backed) and any remote UI source
 * implement {@link UiRegistry}. The contract spans reads
 * (required) + optional change subscriptions. Deliberately does
 * NOT include search, ranking, embeddings, or sync — those live at
 * higher layers (see `BlueprintProvider` in
 * `@ggui-ai/mcp-server-core`).
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
 *    `try/catch` optional methods — read `capabilities.observable`
 *    first. Keeps the contract declarative.
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
   * marker. Consumers use it to tell two versions of the same `id`
   * apart (e.g. on a `changed` {@link UiRegistryEvent}).
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
 * Capability probe. Callers consult these flags to branch the UI
 * (show/hide "Live reload") instead of detecting methods at
 * runtime.
 */
export interface UiRegistryCapabilities {
  /** `true` if `subscribe` is implemented. */
  readonly observable: boolean;
}

/**
 * The source contract every UI registry implements.
 *
 * Read methods are required. `subscribe` is optional; probe
 * `capabilities.observable` before invoking.
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

  /** Capability probe. Always present, always truthful. */
  readonly capabilities: UiRegistryCapabilities;
}
