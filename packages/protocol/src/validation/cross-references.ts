/**
 * Cross-reference invariants for `DataContract`. Validates that every
 * intra-contract pointer resolves to a declared catalog entry on the
 * SAME contract — i.e., the contract is internally consistent.
 *
 * The protocol exposes two such pointers:
 *
 *   - `actionSpec[*].nextStep`     → `agentCapabilities.tools[*]` key
 *   - `streamSpec[*].source.tool`  → `agentCapabilities.tools[*]` key
 *
 * These are pure in-contract checks. A contract that declares
 * `nextStep: 'archive_email'` MUST also declare `archive_email` in its
 * own `agentCapabilities.tools` catalog — same-MCP and cross-MCP both
 * funnel through this single resolution path (the catalog is the
 * declarative source of truth for every referenced tool). Violations
 * are author-recoverable at push time.
 */

import type { DataContract, ActionSpec, StreamSpec, AgentCapabilitiesSpec } from '../types/data-contract';
import type { ContractViolation } from './contract-validator';

/**
 * Stable error code emitted when an `actionSpec[*].nextStep` value
 * does not resolve to a declared `agentCapabilities.tools[*]` key on
 * the same contract.
 *
 * Intended for downstream consumers that switch on the code rather
 * than pattern-matching message strings.
 */
export const CTR_REF_NEXT_STEP = 'CTR_REF_NEXT_STEP';

/**
 * Stable error code emitted when a `streamSpec[*].source.tool` value
 * does not resolve to a declared `agentCapabilities.tools[*]` key on
 * the same contract.
 *
 * Intended for downstream consumers that switch on the code rather
 * than pattern-matching message strings. Mentioned by name in
 * `packages/protocol/src/types/data-contract.ts` (StreamChannelEntry
 * docstring) — keep in sync.
 */
export const CTR_REF_STREAM_SOURCE = 'CTR_REF_STREAM_SOURCE';

/**
 * Cross-reference violation — adds a stable `code` field on top of
 * `ContractViolation`. Lives here rather than on the base type so
 * existing structural violations stay code-less; cross-ref violations
 * are designed to be machine-discriminated.
 */
export interface CrossReferenceViolation extends ContractViolation {
  code: typeof CTR_REF_NEXT_STEP | typeof CTR_REF_STREAM_SOURCE;
}

function agentToolKeys(spec: AgentCapabilitiesSpec | undefined): readonly string[] {
  if (!spec) return [];
  return Object.keys(spec.tools);
}

/**
 * Validate every `actionSpec[*].nextStep` resolves to a declared
 * `agentCapabilities.tools[*]` key on the same contract. Entries
 * without a `nextStep` are skipped (they're pure event signals — the
 * agent decides unconstrained by author intent).
 *
 * When `agentCapabilities` is undefined but a `nextStep` is declared,
 * the reference still doesn't resolve — a violation surfaces. Authors
 * can fix by adding the referenced tool to `agentCapabilities.tools`
 * or by dropping the `nextStep` hint (no-hint action remains valid).
 */
export function checkActionNextStepRefs(
  actionSpec: ActionSpec | undefined,
  agentCapabilities: AgentCapabilitiesSpec | undefined,
): CrossReferenceViolation[] {
  if (!actionSpec) return [];
  const violations: CrossReferenceViolation[] = [];
  const knownTools = agentToolKeys(agentCapabilities);

  for (const [actionName, entry] of Object.entries(actionSpec)) {
    if (entry === null || typeof entry !== 'object') continue;
    const nextStep = entry.nextStep;
    if (nextStep === undefined) continue;
    if (knownTools.includes(nextStep)) continue;

    const known = knownTools.length > 0 ? knownTools.join(', ') : '(none)';
    violations.push({
      code: CTR_REF_NEXT_STEP,
      field: `actionSpec.${actionName}.nextStep`,
      message: `actionSpec.${actionName}.nextStep references '${nextStep}', which is not declared in agentCapabilities.tools. Declared: ${known}.`,
      expected: knownTools.join(' | ') || '(declare in agentCapabilities.tools)',
      received: nextStep,
    });
  }

  return violations;
}

/**
 * Validate every `streamSpec[*].source.tool` resolves to a declared
 * `agentCapabilities.tools[*]` key on the same contract. Channels
 * without a `source` declaration are skipped (they're agent-written by
 * some other mechanism, or server-owned reserved channels).
 *
 * When `agentCapabilities` is undefined but a `source.tool` is
 * declared, the reference still doesn't resolve — a violation
 * surfaces. Authors fix by adding the referenced tool to
 * `agentCapabilities.tools` or by dropping `source` (channel becomes
 * agent-written rather than tool-sourced).
 */
export function checkStreamSourceRefs(
  streamSpec: StreamSpec | undefined,
  agentCapabilities: AgentCapabilitiesSpec | undefined,
): CrossReferenceViolation[] {
  if (!streamSpec) return [];
  const violations: CrossReferenceViolation[] = [];
  const knownTools = agentToolKeys(agentCapabilities);

  for (const [channelName, entry] of Object.entries(streamSpec)) {
    if (entry === null || typeof entry !== 'object') continue;
    const source = entry.source;
    if (!source) continue;
    const toolName = source.tool;
    if (typeof toolName !== 'string' || toolName.length === 0) continue;
    if (knownTools.includes(toolName)) continue;

    const known = knownTools.length > 0 ? knownTools.join(', ') : '(none)';
    violations.push({
      code: CTR_REF_STREAM_SOURCE,
      field: `streamSpec.${channelName}.source.tool`,
      message: `streamSpec.${channelName}.source.tool references '${toolName}', which is not declared in agentCapabilities.tools. Declared: ${known}.`,
      expected: knownTools.join(' | ') || '(declare in agentCapabilities.tools)',
      received: toolName,
    });
  }

  return violations;
}

/**
 * Run every cross-reference invariant. Returns the aggregated
 * violation list — order is stable: `nextStep` invariants first,
 * `stream.source` invariants second.
 *
 * Pure check; doesn't throw. Callers that want fail-fast semantics
 * use {@link assertCrossReferences}.
 */
export function checkCrossReferences(
  contract: DataContract,
): CrossReferenceViolation[] {
  return [
    ...checkActionNextStepRefs(contract.actionSpec, contract.agentCapabilities),
    ...checkStreamSourceRefs(contract.streamSpec, contract.agentCapabilities),
  ];
}

/**
 * Throwable form of {@link checkCrossReferences}. Use at protocol
 * boundaries where an unresolved cross-reference is a contract bug
 * the caller must fix (push handler, blueprint registration).
 *
 * Carries the full violation list so error renderers can show every
 * dangling reference in one pass instead of fix-and-retry per-field.
 */
export class CrossReferenceError extends Error {
  readonly code = 'cross_reference_unresolved' as const;
  readonly violations: readonly CrossReferenceViolation[];

  constructor(violations: readonly CrossReferenceViolation[]) {
    const summary = violations
      .map((v) => `[${v.code}] ${v.message}`)
      .join(' | ');
    super(`Contract cross-reference invariants failed: ${summary}`);
    this.name = 'CrossReferenceError';
    this.violations = violations;
  }
}

/**
 * Throw-on-violation wrapper around {@link checkCrossReferences}.
 * No-op when the contract is internally consistent.
 *
 * Invoked at handshake AND push time: contract-internal mistakes
 * surface at the earliest possible boundary so the agent can fix and
 * retry on the SAME handshakeId.
 */
export function assertCrossReferences(contract: DataContract): void {
  const violations = checkCrossReferences(contract);
  if (violations.length > 0) {
    throw new CrossReferenceError(violations);
  }
}
