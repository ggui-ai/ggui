import type { PortableBlueprint } from '../types/portable-blueprint.js';
import { PORTABLE_BLUEPRINT_SCHEMA_VERSION } from '../types/portable-blueprint.js';
import type { DataContract } from '../types/data-contract.js';
import type { BlueprintVariance } from '../types/blueprint.js';
import type { BlueprintSource } from '../types/blueprint-source.js';
import { parseBlueprintSource } from '../types/blueprint-source.js';
import { dataContractSchema } from '../schemas/data-contract.js';
import { blueprintVarianceSchema } from '../schemas/blueprint.js';
import { blueprintKey, variantKey } from './blueprint-key.js';
import { PROTOCOL_VERSION } from '../version.js';
import type { ToolCatalogShape } from './blueprint-stamp.js';
import { computeToolCatalogHash } from './blueprint-stamp.js';
import { isRecord } from '../validation/is-record.js';

export type { PortableBlueprint };
export { PORTABLE_BLUEPRINT_SCHEMA_VERSION };

/** The fields needed to mint a {@link PortableBlueprint} (keys are derived). */
export interface PortableBlueprintSource {
  readonly contract: DataContract;
  readonly componentCode: string;
  readonly variance: BlueprintVariance;
  /** Provenance of `componentCode` — travels with the artifact. */
  readonly source: BlueprintSource;
}

/**
 * Rejection message for schemaVersion-1 artifacts. v1 records predate
 * required provenance, and a blueprint pool is a cache — re-exporting
 * regenerates the records with full provenance, so there is no
 * migration shim.
 */
export const PORTABLE_BLUEPRINT_V1_REJECTION =
  're-export the pool: PortableBlueprint schemaVersion 2 requires complete provenance';

/**
 * Result of {@link fromPortableBlueprint} — the validating narrower at
 * the artifact trust boundary (JSON bytes → typed record).
 *
 * Rejection policy at the call sites: pool loaders SKIP a rejected
 * record with a log line (a rejected seed entry is just a cold-gen);
 * explicit single-artifact import paths hard-error with `reason`.
 * Coercing a rejected record into the typed shape is banned.
 */
export type PortableBlueprintImportResult =
  | {
      readonly ok: true;
      /** Canonical rebuild of the validated record (stray keys dropped). */
      readonly record: PortableBlueprint;
      /** True if the shipped contractHash/variantKey differed from the recompute. */
      readonly keyMismatch: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/** Options for {@link toPortableBlueprint}. */
export interface ToPortableBlueprintOpts {
  /**
   * Tool-identity catalog used to canonicalize the contract at export
   * time. When provided, its hash is stamped as
   * `toolIdentityCatalogHash` so importers can detect catalog drift
   * (same intent → different key). When omitted — the offline-export
   * case, where no runtime catalog exists — the stamp is left absent
   * and importers fall back to recomputing keys against their own
   * catalog.
   */
  readonly catalog?: ToolCatalogShape;
}

export function toPortableBlueprint(
  src: PortableBlueprintSource,
  opts?: ToPortableBlueprintOpts,
): PortableBlueprint {
  return {
    schemaVersion: PORTABLE_BLUEPRINT_SCHEMA_VERSION,
    contract: src.contract,
    componentCode: src.componentCode,
    variance: src.variance,
    contractHash: blueprintKey(src.contract),
    variantKey: variantKey(src.variance),
    source: src.source,
    generatorProtocolVersion: PROTOCOL_VERSION,
    ...(opts?.catalog !== undefined
      ? { toolIdentityCatalogHash: computeToolCatalogHash(opts.catalog) }
      : {}),
  };
}

/**
 * Validate one artifact record (parsed JSON, untrusted) into a typed
 * {@link PortableBlueprint}. Shipped keys are advisory — they are
 * recomputed here and a divergence is surfaced as `keyMismatch`, never
 * silently trusted.
 */
export function fromPortableBlueprint(record: unknown): PortableBlueprintImportResult {
  if (!isRecord(record)) {
    return { ok: false, reason: 'record is not an object' };
  }
  const r = record;

  if (r['schemaVersion'] !== PORTABLE_BLUEPRINT_SCHEMA_VERSION) {
    if (r['schemaVersion'] === 1) {
      return { ok: false, reason: PORTABLE_BLUEPRINT_V1_REJECTION };
    }
    return {
      ok: false,
      reason: `unsupported PortableBlueprint schemaVersion ${JSON.stringify(
        r['schemaVersion'],
      )} (expected ${PORTABLE_BLUEPRINT_SCHEMA_VERSION})`,
    };
  }

  const source = parseBlueprintSource(r['source']);
  if (source === null) {
    return {
      ok: false,
      reason:
        'missing or malformed `source` provenance (expected a BlueprintSource union value)',
    };
  }

  const generatorProtocolVersion = r['generatorProtocolVersion'];
  if (
    typeof generatorProtocolVersion !== 'string' ||
    generatorProtocolVersion.length === 0
  ) {
    return { ok: false, reason: 'missing or empty `generatorProtocolVersion`' };
  }

  const componentCode = r['componentCode'];
  if (typeof componentCode !== 'string' || componentCode.length === 0) {
    return { ok: false, reason: 'missing or empty `componentCode`' };
  }

  const shippedContractHash = r['contractHash'];
  const shippedVariantKey = r['variantKey'];
  if (typeof shippedContractHash !== 'string' || typeof shippedVariantKey !== 'string') {
    return { ok: false, reason: 'missing `contractHash` / `variantKey`' };
  }

  const toolIdentityCatalogHash = r['toolIdentityCatalogHash'];
  if (
    toolIdentityCatalogHash !== undefined &&
    typeof toolIdentityCatalogHash !== 'string'
  ) {
    return { ok: false, reason: 'malformed `toolIdentityCatalogHash` (expected string)' };
  }

  const contract = dataContractSchema.safeParse(r['contract']);
  if (!contract.success) {
    return { ok: false, reason: `malformed \`contract\`: ${contract.error.message}` };
  }

  const variance = blueprintVarianceSchema.safeParse(r['variance']);
  if (!variance.success) {
    return { ok: false, reason: `malformed \`variance\`: ${variance.error.message}` };
  }

  const keyMismatch =
    blueprintKey(contract.data) !== shippedContractHash ||
    variantKey(variance.data) !== shippedVariantKey;

  return {
    ok: true,
    record: {
      schemaVersion: PORTABLE_BLUEPRINT_SCHEMA_VERSION,
      contract: contract.data,
      componentCode,
      variance: variance.data,
      contractHash: shippedContractHash,
      variantKey: shippedVariantKey,
      source,
      generatorProtocolVersion,
      ...(toolIdentityCatalogHash !== undefined ? { toolIdentityCatalogHash } : {}),
    },
    keyMismatch,
  };
}
