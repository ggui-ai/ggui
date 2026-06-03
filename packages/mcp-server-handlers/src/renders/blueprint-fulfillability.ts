/**
 * Blueprint fulfillability — the deterministic reuse PRECONDITION.
 *
 * A cached blueprint is only worth proposing for reuse when the REQUESTING
 * agent can actually drive it. Reuse hands the agent the cached contract,
 * and that contract's actions hint tools (`actionSpec[*].nextStep`) and its
 * stream channels pull from tools (`streamSpec[*].source.tool`). If the
 * requesting agent does not declare those tools, the reused UI is a dead
 * end — its buttons hint a tool the agent cannot call, its channels name a
 * source the agent cannot feed. So the gate: the agent's declared
 * `agentCapabilities.tools` (a set keyed by bare toolName) MUST superset the
 * blueprint's REQUIRED tools.
 *
 * Beyond mere presence, a shared tool must still be SHAPE-compatible: the
 * blueprint recorded each required tool's `toolInfo.inputSchema` at its
 * registration. If the agent's CURRENT tool has DROPPED a field the
 * blueprint recorded as required, the cached UI may try to send a field the
 * agent no longer requires/accepts. v1 is conservative: every field the
 * blueprint recorded as required must still appear in the agent's current
 * required-field set (a required-superset check). Adding a newly-required
 * field is compatible (the agent's required set still covers the
 * blueprint's); dropping a previously-required field is not.
 *
 * Version is NOT part of identity. `(server, toolName)` is the canonical
 * cross-framework identity; `serverInfo.version` is metadata. A version bump
 * with an unchanged schema must still reuse — so this check never consults
 * version.
 *
 * Pure — no store, no LLM. Mirrors the style of `blueprint-coverage.ts`.
 */

import type { AgentCapabilitiesSpec, DataContract } from '@ggui-ai/protocol';

/**
 * The union of MCP tools a contract REQUIRES the agent to be able to call —
 * every `actionSpec[*].nextStep` hint plus every `streamSpec[*].source.tool`
 * channel source (and the legacy `streamSpec[*].tool` refresh hint).
 * Deduplicated; order-insensitive.
 */
export function requiredTools(contract: DataContract): string[] {
  const tools = new Set<string>();
  for (const action of Object.values(contract.actionSpec ?? {})) {
    if (typeof action.nextStep === 'string') tools.add(action.nextStep);
  }
  for (const channel of Object.values(contract.streamSpec ?? {})) {
    if (typeof channel.source?.tool === 'string') tools.add(channel.source.tool);
    else if (typeof channel.tool === 'string') tools.add(channel.tool);
  }
  return [...tools];
}

/**
 * Result of {@link isFulfillable}. `ok` is the gate; `missingTools` and
 * `schemaConflicts` name exactly why a candidate was declined (for warn /
 * trace lines). `ok` ⇔ both lists empty.
 */
export interface FulfillResult {
  readonly ok: boolean;
  readonly missingTools: string[];
  readonly schemaConflicts: string[];
}

/**
 * True iff the requesting agent (its `agentCapabilities.tools`) can fulfill
 * the cached blueprint `contract`. See the module docstring for the gate.
 */
export function isFulfillable(
  contract: DataContract,
  agentTools: AgentCapabilitiesSpec['tools'] | undefined,
): FulfillResult {
  const have = agentTools ?? {};
  const missingTools: string[] = [];
  const schemaConflicts: string[] = [];
  for (const tool of requiredTools(contract)) {
    const agentEntry = have[tool];
    if (!agentEntry) {
      missingTools.push(tool);
      continue;
    }
    // Server-identity gate: a shared bare tool name owned by a DIFFERENT MCP
    // server is NOT the same tool. `(serverInfo.name, toolName)` is the
    // canonical cross-framework identity — the exact-key reuse path already
    // hashes on it (Slice 1); here we close the same collision on the
    // semantic (RAG+judge) reuse path. GRACEFUL: only when BOTH sides declare
    // `serverInfo.name` and they differ do we decline; if either side omits
    // it (Tier-2 / pre-canonicalization blueprints), fall back to bare-name
    // matching so existing reuse still holds.
    const blueprintServer = contract.agentCapabilities?.tools?.[tool]?.serverInfo?.name;
    const agentServer = agentEntry.serverInfo?.name;
    if (
      blueprintServer !== undefined &&
      agentServer !== undefined &&
      blueprintServer !== agentServer
    ) {
      schemaConflicts.push(tool);
      continue;
    }
    const recorded = contract.agentCapabilities?.tools?.[tool]?.toolInfo?.inputSchema;
    const current = agentEntry.toolInfo.inputSchema;
    if (recorded && !inputSchemaSatisfies(current, recorded)) {
      schemaConflicts.push(tool);
    }
  }
  return {
    ok: missingTools.length === 0 && schemaConflicts.length === 0,
    missingTools,
    schemaConflicts,
  };
}

/**
 * v1 conservative shape-compat: the agent's CURRENT required-field set must
 * COVER every field the blueprint RECORDED as required. Adding an optional
 * field keeps the current required set a superset → compatible; dropping a
 * previously-required field breaks the cover → incompatible.
 */
function inputSchemaSatisfies(
  current: { required?: string[] },
  recorded: { required?: string[] },
): boolean {
  const cur = current.required ?? [];
  const rec = recorded.required ?? [];
  return rec.every((field) => cur.includes(field));
}
