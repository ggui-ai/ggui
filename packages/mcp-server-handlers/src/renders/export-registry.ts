import type { EnumerableVectorStore, VectorStore } from '@ggui-ai/mcp-server-core';
import type { DataContract, BlueprintVariance } from '@ggui-ai/protocol';

export interface ExportableBlueprint {
  readonly contract: DataContract;
  readonly componentCode: string;
  readonly generator: string;
  readonly variance: BlueprintVariance;
}

function isEnumerable(s: VectorStore): s is EnumerableVectorStore {
  return 'listByScope' in s && typeof (s as EnumerableVectorStore).listByScope === 'function';
}

/**
 * Enumerate every reusable TEMPLATE blueprint stored under `scope` in a
 * vector store, with its inline component code — the export source for a
 * distributable pool. A blueprint is a completed template, so non-template
 * rows (none expected) are skipped. Throws if the store is not enumerable
 * (e.g. an ephemeral / hosted store with no cheap list API).
 */
export async function listRegistryBlueprintsForExport(
  vectorStore: VectorStore,
  scope: string,
): Promise<readonly ExportableBlueprint[]> {
  if (!isEnumerable(vectorStore)) {
    throw new Error('export: vector store is not enumerable; configure a persistent (sqlite) vectors driver');
  }
  const out: ExportableBlueprint[] = [];
  for (const entry of await vectorStore.listByScope(scope)) {
    const m = entry.metadata;
    const contractRaw = m['contract'];
    const codeRaw = m['componentCode'];
    if (typeof contractRaw !== 'string' || typeof codeRaw !== 'string') continue;
    if (m['kind'] !== 'template') continue;
    const varianceRaw = m['variance'];
    out.push({
      // parsed from stored JSON
      contract: JSON.parse(contractRaw) as DataContract,
      componentCode: codeRaw,
      generator: typeof m['generator'] === 'string' ? m['generator'] : 'unknown',
      // parsed from stored JSON
      variance: typeof varianceRaw === 'string' ? (JSON.parse(varianceRaw) as BlueprintVariance) : {},
    });
  }
  return out;
}
