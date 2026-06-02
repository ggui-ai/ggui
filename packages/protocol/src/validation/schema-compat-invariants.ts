/**
 * Protocol-level schema-compatibility invariants for `DataContract`.
 *
 * Ships one stable error code:
 *
 *   - `CTR_SCHEMA_INCOMPAT` — an `actionSpec[*].schema` is not a
 *     subset of the referenced `agentCapabilities.tools[*].inputSchema`,
 *     OR a `streamSpec[*].schema` is not a superset of the
 *     referenced `agentCapabilities.tools[*].outputSchema`. Direction is
 *     fixed by the data flow: action payloads travel UI → tool, so
 *     the action's accepted values must fit the tool's accepted
 *     inputs; stream payloads travel tool → channel, so the
 *     channel's accepted values must cover the tool's possible
 *     outputs.
 *
 * **Scope vs server-level F4.** This invariant runs PURELY against
 * the contract's own catalog — `actionSpec[*].schema` /
 * `streamSpec[*].schema` vs `agentCapabilities.tools[*].inputSchema` /
 * `outputSchema`, all of which are author-declared JSON Schemas
 * already on the contract. No tool registry, no zod conversion, no
 * server state. The server-level F4 check (`checkRenderSchemaCompat`
 * in `@ggui-ai/mcp-server`) compares the same `actionSpec` /
 * `streamSpec` schemas against the SERVER-REGISTERED tools' actual
 * zod schemas; it covers the operator-side "did the deployed tool
 * change schema since the contract was authored?" failure mode. Both
 * checks compose:
 *
 *   - Protocol-level CTR_SCHEMA_INCOMPAT: author-visible bug.
 *     "Your contract's action.schema doesn't fit the inputSchema
 *     you yourself declared on this tool entry."
 *   - Server-level SchemaCompatError: operator-visible bug. "The
 *     deployed tool's actual inputSchema doesn't match what the
 *     contract declares."
 *
 * Skipped silently when the referenced agentTool has no declared
 * `inputSchema`/`outputSchema` (the catalog entry is incomplete; the
 * check has no anchor and degrades to "no opinion"). Skipped when
 * the action/channel has no `schema` (void-payload entries — nothing
 * to compare).
 *
 * Companion to `cross-references` and `name-invariants` — together
 * they ship companion rule registries to cross-references and
 * name-invariants under the unified `lintContract` API.
 */

import type {
  ActionEntry,
  AgentToolEntry,
  AgentCapabilitiesSpec,
  DataContract,
  JsonSchema,
  StreamChannelEntry,
} from '../types/data-contract';
import type { ContractViolation } from './contract-validator';
import { isSchemaSubset, type SubsetViolation } from './schema-subset';

// `SubsetViolation` is used as the parameter type for the local
// `describe` helper below; it is intentionally NOT carried on the
// public `SchemaCompatViolation` (the rich shape doesn't fit
// `ContractViolation extends JsonObject`).

/**
 * Stable error code for protocol-level schema-compatibility
 * violations on action ⊆ inputSchema or channel ⊇ outputSchema.
 */
export const CTR_SCHEMA_INCOMPAT = 'CTR_SCHEMA_INCOMPAT';

/**
 * Discriminator on the side of the contract the violation came
 * from. Surfaced on the violation so consumers can render the
 * action vs. stream cases differently without parsing the field
 * path.
 */
export type SchemaCompatSide = 'action' | 'stream';

/**
 * Schema-compat invariant violation. Carries the stable error code
 * plus side / specName / toolName so consumers can pivot rendering
 * on the action vs stream case without parsing the field path.
 *
 * The granular `isSchemaSubset` violation list is NOT carried on the
 * violation (the rich `SubsetViolation` shape doesn't fit the
 * `ContractViolation extends JsonObject` constraint). The message
 * includes the first mismatch's reason + path; callers needing the
 * full list can re-run {@link checkSchemaCompat} subcomponents
 * directly.
 */
export interface SchemaCompatViolation extends ContractViolation {
  code: typeof CTR_SCHEMA_INCOMPAT;
  /** Which side of the contract was checked. */
  side: SchemaCompatSide;
  /** The action / channel name on the contract. */
  specName: string;
  /** The agentCapabilities.tools key resolved to perform the check. */
  toolName: string;
}

function buildToolMap(
  agentCapabilities: AgentCapabilitiesSpec | undefined,
): ReadonlyMap<string, AgentToolEntry> {
  if (!agentCapabilities) return new Map();
  return new Map(Object.entries(agentCapabilities.tools));
}

/**
 * Validate every `actionSpec[*].schema` is a subset of the
 * referenced `agentCapabilities.tools[nextStep].inputSchema`.
 *
 * Skips entries where:
 *   - no `nextStep` is declared (pure event signal — the agent owns
 *     dispatch; nothing to compare),
 *   - the referenced agentTool has no declared `inputSchema` (the
 *     catalog entry is incomplete; the check has no anchor),
 *   - the referenced agentTool is missing entirely (a separate
 *     invariant `CTR_REF_NEXT_STEP` covers that).
 *
 * When the action has no `schema`, the wire shape is modeled as
 * `{type: 'object', properties: {}, additionalProperties: false}` —
 * "void payload." This matches the F4 convention so the protocol-
 * level check stays compatible with the server-level posture.
 */
export function checkActionSchemaCompat(
  actionSpec: DataContract['actionSpec'] | undefined,
  agentCapabilities: AgentCapabilitiesSpec | undefined,
): SchemaCompatViolation[] {
  if (!actionSpec) return [];
  const tools = buildToolMap(agentCapabilities);
  const violations: SchemaCompatViolation[] = [];

  for (const [actionName, entry] of Object.entries(actionSpec)) {
    if (!entry || typeof entry !== 'object') continue;
    const toolName = (entry as ActionEntry).nextStep;
    if (typeof toolName !== 'string' || toolName.length === 0) continue;

    const tool = tools.get(toolName);
    if (!tool) continue; // CTR_REF_NEXT_STEP covers this
    const toolInput = tool.toolInfo.inputSchema;
    if (!toolInput) continue; // catalog entry incomplete — no anchor

    const actionSchema: JsonSchema = entry.schema ?? {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };

    const result = isSchemaSubset(toolInput, actionSchema);
    if (result.compatible) continue;

    violations.push({
      code: CTR_SCHEMA_INCOMPAT,
      side: 'action',
      specName: actionName,
      toolName,
      field: `actionSpec.${actionName}.schema`,
      message: `actionSpec.${actionName}.schema is not a subset of agentCapabilities.tools.${toolName}.inputSchema — values the action accepts would be rejected by the tool. ${describe(result.violations)}`,
      expected: `subset of agentCapabilities.tools.${toolName}.inputSchema`,
      received: 'incompatible',
    });
  }

  return violations;
}

/**
 * Validate every `streamSpec[*].schema` is a SUPERSET of the
 * referenced `agentCapabilities.tools[source.tool].outputSchema`. Direction
 * inverts: streams travel tool → channel, so the channel schema
 * must accept everything the tool can return.
 *
 * Skips entries where:
 *   - no `source` is declared,
 *   - the referenced agentTool has no declared `outputSchema`,
 *   - the referenced agentTool is missing entirely
 *     (`CTR_REF_STREAM_SOURCE` covers that),
 *   - the channel has no `schema` (declarative validation is
 *     impossible without the channel's accepted shape).
 */
export function checkStreamSchemaCompat(
  streamSpec: DataContract['streamSpec'] | undefined,
  agentCapabilities: AgentCapabilitiesSpec | undefined,
): SchemaCompatViolation[] {
  if (!streamSpec) return [];
  const tools = buildToolMap(agentCapabilities);
  const violations: SchemaCompatViolation[] = [];

  for (const [channelName, entry] of Object.entries(streamSpec)) {
    if (!entry || typeof entry !== 'object') continue;
    const source = (entry as StreamChannelEntry).source;
    if (!source) continue;
    const toolName = source.tool;
    if (typeof toolName !== 'string' || toolName.length === 0) continue;

    const tool = tools.get(toolName);
    if (!tool) continue; // CTR_REF_STREAM_SOURCE covers this
    const toolOutput = tool.toolInfo?.outputSchema;
    if (!toolOutput) continue;

    const channelSchema = (entry as StreamChannelEntry).schema;
    if (!channelSchema) continue;

    // Direction: every tool-returned value must be accepted by the
    // channel schema. Channel is the superset / permissive side,
    // tool-return is the restricted side.
    const result = isSchemaSubset(channelSchema, toolOutput);
    if (result.compatible) continue;

    violations.push({
      code: CTR_SCHEMA_INCOMPAT,
      side: 'stream',
      specName: channelName,
      toolName,
      field: `streamSpec.${channelName}.schema`,
      message: `streamSpec.${channelName}.schema does not accept all values agentCapabilities.tools.${toolName}.outputSchema produces — some tool outputs would fail channel validation. ${describe(result.violations)}`,
      expected: `superset of agentCapabilities.tools.${toolName}.outputSchema`,
      received: 'incompatible',
    });
  }

  return violations;
}

function describe(violations: readonly SubsetViolation[]): string {
  if (violations.length === 0) return '';
  const first = violations[0];
  return `First mismatch: ${first.reason} at ${first.path || '<root>'}.`;
}

/**
 * Run every protocol-level schema-compat invariant. Aggregates action
 * + stream violations; order is stable (action checks first).
 */
export function checkSchemaCompat(
  contract: DataContract,
): SchemaCompatViolation[] {
  return [
    ...checkActionSchemaCompat(contract.actionSpec, contract.agentCapabilities),
    ...checkStreamSchemaCompat(contract.streamSpec, contract.agentCapabilities),
  ];
}

/**
 * Throwable form of {@link checkSchemaCompat}. Use at protocol
 * boundaries where a schema-compat violation is a contract bug the
 * author must fix.
 */
export class SchemaCompatInvariantError extends Error {
  readonly code = 'schema_compat_incompat' as const;
  readonly violations: readonly SchemaCompatViolation[];

  constructor(violations: readonly SchemaCompatViolation[]) {
    const summary = violations
      .map((v) => `[${v.code}] ${v.message}`)
      .join(' | ');
    super(`Contract schema-compat invariants failed: ${summary}`);
    this.name = 'SchemaCompatInvariantError';
    this.violations = violations;
  }
}

/**
 * Throw-on-violation wrapper around {@link checkSchemaCompat}.
 * No-op when the contract's schemas align with its own
 * agentCapabilities catalog.
 *
 * Slots alongside `assertCrossReferences` + `assertNameInvariants`
 * at push time. Different scope from the server-level
 * `SchemaCompatError` thrown by `checkRenderSchemaCompat` in
 * `@ggui-ai/mcp-server`: this check uses ONLY the contract's own
 * catalog; the server-level check uses the runtime tool registry.
 */
export function assertSchemaCompat(contract: DataContract): void {
  const violations = checkSchemaCompat(contract);
  if (violations.length > 0) {
    throw new SchemaCompatInvariantError(violations);
  }
}
