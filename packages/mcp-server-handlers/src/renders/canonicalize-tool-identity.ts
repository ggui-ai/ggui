/**
 * Tool identity canonicalization — the protocol step that makes blueprint reuse
 * framework-invariant. Given a per-app catalog mapping each bare MCP tool name
 * to its canonical (`initialize`-declared) server identity, rewrite every
 * `agentCapabilities.tools[*].serverInfo` to that canonical value, into a NEW
 * contract. Keyed by BARE tool name so it canonicalizes regardless of whether
 * the agent authored a config-key name, fabricated one, or omitted it.
 *
 * Pure — no I/O, input never mutated. Runs in `decideHandshake` right after the
 * `normalizeDraft` gate (sibling step: normalize schema quirks, then normalize
 * identity, then key). The canonical name lands IN the proposed contract that
 * gets hashed, so the portable-hash property holds.
 */
import type { AgentToolEntry, DataContract } from '@ggui-ai/protocol';

/** Per-app canonical identity: bare tool name → its server's canonical serverInfo. */
export type ToolIdentityCatalog = Record<string, { name: string; version?: string }>;

export function canonicalizeToolIdentity(
  contract: DataContract,
  catalog: ToolIdentityCatalog,
): DataContract {
  const tools = contract.agentCapabilities?.tools;
  if (!tools) return contract;
  let changed = false;
  const next: Record<string, AgentToolEntry> = {};
  for (const [bareName, entry] of Object.entries(tools)) {
    const canonical = catalog[bareName];
    if (canonical === undefined) {
      next[bareName] = entry;
      continue;
    }
    next[bareName] = { ...entry, serverInfo: { ...canonical } };
    changed = true;
  }
  if (!changed) return contract;
  return { ...contract, agentCapabilities: { ...contract.agentCapabilities, tools: next } };
}
