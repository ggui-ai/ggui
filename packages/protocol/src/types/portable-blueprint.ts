import type { DataContract } from "./data-contract.js";
import type { BlueprintVariance } from "./blueprint.js";
import type { BlueprintSource } from "./blueprint-source.js";

/**
 * Current `PortableBlueprint` record schema version. v2 (2026-06) made
 * provenance non-negotiable: `source` + `generatorProtocolVersion` are
 * required. v1 records are REJECTED by importers — a rejected seed
 * entry is just a cold-gen, so the fix is to re-export the pool, never
 * to coerce.
 */
export const PORTABLE_BLUEPRINT_SCHEMA_VERSION = 2;

/**
 * One self-contained, JSON-serializable blueprint record in a
 * distributable shared-pool artifact. A blueprint is a COMPLETED
 * TEMPLATE (a whole generated UI keyed by a contract) — not a
 * component — so there is no `kind`/atomic-taxonomy field; that
 * taxonomy belongs to the separate component library. Carries the
 * component code inline (the stored Blueprint references code by hash;
 * the artifact must travel with the bytes). `contractHash` /
 * `variantKey` are shipped for diagnostics + integrity and are
 * recomputed on load.
 */
export interface PortableBlueprint {
  readonly schemaVersion: typeof PORTABLE_BLUEPRINT_SCHEMA_VERSION;
  readonly contract: DataContract;
  readonly componentCode: string;
  readonly variance: BlueprintVariance;
  readonly contractHash: string;
  readonly variantKey: string;
  /**
   * Provenance of the component code. Required — an artifact that
   * cannot say where its code came from is rejected at import, not
   * tolerated as "unlabeled".
   */
  readonly source: BlueprintSource;
  /**
   * Generator era at export time (`PROTOCOL_VERSION`). Required —
   * importers reject blueprints whose generator era is incompatible
   * with theirs rather than serve code generated against a different
   * protocol shape.
   */
  readonly generatorProtocolVersion: string;
  /**
   * Intent prose the blueprint was registered under — the semantic
   * (Tier-2) matching input at the import side. Optional: artifacts
   * exported before this field existed still import, with the
   * importer deriving intent from its own fallbacks. When present it
   * MUST be non-empty.
   */
  readonly intent?: string;
  /**
   * SHA256(16) of the tool-identity catalog used to canonicalize
   * `contract` at export. Importers re-canonicalize against their own
   * catalog and recompute the key; a divergence means the same intent
   * would mis-key and silently cold-gen — so it is rejected. Optional
   * because the catalog is a runtime artifact built from live MCP
   * handshakes — an offline pool export has no catalog to hash.
   */
  readonly toolIdentityCatalogHash?: string;
}
