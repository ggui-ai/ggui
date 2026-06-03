import {
  isEnumerableVectorStore,
  type VectorStore,
} from '@ggui-ai/mcp-server-core';
import type { DataContract, BlueprintVariance } from '@ggui-ai/protocol';

export interface ExportableBlueprint {
  readonly contract: DataContract;
  readonly componentCode: string;
  readonly variance: BlueprintVariance;
}

/**
 * Enumerate every reusable TEMPLATE blueprint stored under `scope` in a
 * vector store, with its inline component code — the export source for a
 * distributable pool. A blueprint is a completed template, so non-template
 * rows (none expected) are skipped. Throws if the store is not enumerable
 * (e.g. an ephemeral / hosted store with no cheap list API).
 *
 * Corrupt rows are skipped, not fatal: an unparseable `contract` drops the
 * single row (matches `rowToBlueprint`), and an unparseable `variance`
 * defaults to `{}`. One bad row never aborts the whole export.
 */
export async function listRegistryBlueprintsForExport(
  vectorStore: VectorStore,
  scope: string,
): Promise<readonly ExportableBlueprint[]> {
  if (!isEnumerableVectorStore(vectorStore)) {
    throw new Error('export: vector store is not enumerable; configure a persistent (sqlite) vectors driver');
  }
  const out: ExportableBlueprint[] = [];
  // metadata keys mirror blueprintToMetadata in blueprint-registry.ts
  for (const entry of await vectorStore.listByScope(scope)) {
    const m = entry.metadata;
    const contractRaw = m['contract'];
    const codeRaw = m['componentCode'];
    if (typeof contractRaw !== 'string' || typeof codeRaw !== 'string') continue;
    if (m['kind'] !== 'template') continue;
    let contract: DataContract;
    try {
      contract = JSON.parse(contractRaw) as DataContract; // parsed from stored JSON
    } catch {
      continue; // skip corrupt row
    }
    const varianceRaw = m['variance'];
    let variance: BlueprintVariance = {};
    if (typeof varianceRaw === 'string') {
      try {
        variance = JSON.parse(varianceRaw) as BlueprintVariance; // parsed from stored JSON
      } catch {
        /* default {} */
      }
    }
    out.push({ contract, componentCode: codeRaw, variance });
  }
  return out;
}
