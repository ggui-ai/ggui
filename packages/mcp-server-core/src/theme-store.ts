/**
 * ThemeStore — the runtime theme-registration persistence port
 * (ggui#598-C, the founder-ruled fundamental; FROZEN 2026-08-22).
 *
 * ## What this port is
 *
 * C makes brand themes REGISTRABLE at runtime instead of compiled into
 * the design package: an operator registers a DTCG theme document for
 * their app; the server validates it against the consumed-token
 * manifest (coverage conformance — the #598 slice-2 validator) and
 * persists it here; renders resolve it as the app's BASE token ladder
 * and deliver it over the wire (resolved-mode emission, v0).
 *
 * ## What the store holds — bytes + identity, never shape
 *
 * The record persists the registration document as CANONICAL JSON
 * BYTES plus a content hash — the blueprint-registry precedent
 * (contract-as-string): the STORE owns durability and identity; the
 * VALIDATOR (design package, registration seam) owns the document's
 * shape. This keeps the port free of cross-package theme types and
 * makes byte-faithful round-trips the store's whole contract — a
 * backend that reorders map keys cannot exist here by construction
 * (the #579/#585 lesson: document stores that re-marshal JSON are not
 * hash-rebuild sources).
 *
 * ## Frozen semantics (pinned by the in-memory reference tests)
 *
 * - Records key on `(appId, themeId)`; `appId` is the tenancy unit —
 *   cross-app reads return null by construction.
 * - `put` upserts; `registeredAt` is first-write, `updatedAt` moves.
 * - `list` is app-scoped, themeId-sorted.
 * - `delete` is idempotent-with-report (true exactly once).
 * - Theme ids obey {@link isValidThemeId}; ids colliding with the
 *   static preset registry are refused AT REGISTRATION (the handler's
 *   obligation, not the store's — the store is id-agnostic).
 *
 * Reference adapter: `InMemoryThemeStore` (`/in-memory` entry). Cloud
 * provides the durable adapter (DDB/S3) behind the same port —
 * storing the document column as a STRING, never a native map (see
 * the byte-fidelity note above).
 */

/** One registered theme, as persisted. */
export interface StoredTheme {
  /** Owning app — the tenancy unit. */
  readonly appId: string;
  /** Registered id; obeys {@link isValidThemeId}. */
  readonly themeId: string;
  /**
   * The registration document as canonical JSON bytes — the
   * `{light, dark?}` DTCG registration, serialized. The store never
   * parses it; the validator owns shape at the registration seam.
   */
  readonly document: string;
  /** sha256 (lowercase hex) over {@link document} — the identity join key. */
  readonly documentHash: string;
  /** First-registration timestamp (ms epoch). Stable across upserts. */
  readonly registeredAt: number;
  /** Last-write timestamp (ms epoch). */
  readonly updatedAt: number;
}

/** The persistence port. All methods are tenancy-scoped by `appId`. */
export interface ThemeStore {
  get(appId: string, themeId: string): Promise<StoredTheme | null>;
  /** Upsert by `(appId, themeId)` — the record is written verbatim. */
  put(theme: StoredTheme): Promise<void>;
  /** The app's registered themes, sorted by `themeId`. */
  list(appId: string): Promise<readonly StoredTheme[]>;
  /** Remove one registration. True iff a record existed. */
  delete(appId: string, themeId: string): Promise<boolean>;
}

/**
 * The frozen theme-id grammar: lowercase kebab, alnum-bounded, 3–64
 * chars — a user-facing namespace, deliberately narrow (the founder
 * flag on namespace POLICY — reservations, collisions across tenants —
 * is a separate ruling; this grammar is the syntactic floor any policy
 * sits on).
 */
const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Validate a candidate theme id against the frozen grammar. */
export function isValidThemeId(candidate: string): boolean {
  return THEME_ID_RE.test(candidate);
}
