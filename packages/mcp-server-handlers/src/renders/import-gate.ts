/**
 * `gateImportedBlueprint` — the cross-deployment persistence-contract gate.
 *
 * A blueprint authored under one deployment can be re-imported by another
 * (seed pool, per-app installed rows). Without a gate, two silent failures
 * are possible:
 *
 *   1. The artifact was generated against a DIFFERENT protocol shape (its
 *      component code or contract assumes a removed/renamed field) — reusing
 *      it serves stale code that no longer matches the runtime.
 *   2. The importer's tool-identity catalog DIVERGES from the exporter's, so
 *      the same intent canonicalizes to a different contract key → the reuse
 *      lookup misses and the deployment silently cold-regenerates (paying for
 *      generation it thought it had cached, and producing a fresh variant).
 *
 * This gate makes both fail LOUD: a `!ok` result with a `reason` (caller skips
 * + reports the record) instead of accepting it into the reuse pool. Non-fatal
 * observations land in `warnings`.
 *
 * Structural `GateInput` so both call sites supply it: a `PortableBlueprint`
 * (seed pool) and a pod installed-row view both structurally satisfy it.
 */
import type { DataContract } from '@ggui-ai/protocol';
import { blueprintKey, computeToolCatalogHash } from '@ggui-ai/protocol/blueprint-key';
import { canonicalizeToolIdentity, type ToolIdentityCatalog } from './canonicalize-tool-identity.js';
import { assertContractNoRetiredFields } from './assert-contract-no-retired-fields.js';

export interface GateInput {
  readonly contract: DataContract;
  /** Shipped key, for the catalog re-key check (omit when unknown). */
  readonly contractHash?: string;
  /**
   * Required: `fromPortableBlueprint` (the upstream artifact
   * narrower) already hard-rejects unstamped records, so an
   * unstamped value reaching this gate is not a real state — the
   * gate checks era equality, never absence.
   */
  readonly generatorProtocolVersion: string;
  readonly toolIdentityCatalogHash?: string;
}

export interface ImportGateCtx {
  /** The importing deployment's `PROTOCOL_VERSION`. */
  readonly protocolVersion: string;
  /** The importing deployment's per-app tool-identity catalog. */
  readonly catalog: ToolIdentityCatalog;
}

export interface ImportGateResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly warnings: readonly string[];
}

export function gateImportedBlueprint(input: GateInput, ctx: ImportGateCtx): ImportGateResult {
  const warnings: string[] = [];

  // 1. Retired contract fields → hard reject (authored against a removed
  //    protocol shape; serving it would silently ignore/mis-handle the field).
  try {
    assertContractNoRetiredFields(input.contract);
  } catch (e) {
    return {
      ok: false,
      reason: `retired contract field: ${e instanceof Error ? e.message : String(e)}`,
      warnings,
    };
  }

  // 2. Generator era. The stamp is required upstream
  //    (fromPortableBlueprint rejects unstamped records), so the only
  //    check left is era equality.
  if (input.generatorProtocolVersion !== ctx.protocolVersion) {
    return {
      ok: false,
      reason: `generator era mismatch: artifact ${input.generatorProtocolVersion} vs deployment ${ctx.protocolVersion}`,
      warnings,
    };
  }

  // 3. Tool-identity catalog re-key — only when a catalog hash was shipped.
  //    When the shipped catalog hash matches ours, the contract canonicalizes
  //    identically and the reuse key is stable → no further check needed.
  //    When it differs, re-canonicalize against OUR catalog and recompute the
  //    key: if that key would no longer match the shipped contractHash, the
  //    intent would silently mis-key (cold-gen) → reject. Otherwise accept
  //    with a warning (the divergence is cosmetic for this contract).
  if (input.toolIdentityCatalogHash !== undefined) {
    if (computeToolCatalogHash(ctx.catalog) !== input.toolIdentityCatalogHash) {
      const recomputed = blueprintKey(canonicalizeToolIdentity(input.contract, ctx.catalog));
      if (input.contractHash !== undefined && recomputed !== input.contractHash) {
        return {
          ok: false,
          reason:
            'tool-identity catalog divergence → contract key would mis-match (silent cold-gen avoided)',
          warnings,
        };
      }
      warnings.push(
        'catalog hash differs but recomputed key matches (or no shipped hash) — accepted',
      );
    }
  } else {
    warnings.push('unstamped catalog hash — accepted for back-compat');
  }

  return { ok: true, warnings };
}
