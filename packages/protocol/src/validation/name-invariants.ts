/**
 * Name-uniqueness and reserved-namespace invariants for `DataContract`.
 *
 * Two stable error codes:
 *
 *   - `CTR_DUP_NAME`     — the same key appears in two or more of
 *                          `actionSpec`, `streamSpec`, `contextSpec`.
 *                          Collisions are author bugs: the boilerplate
 *                          generator emits identifiers from these keys
 *                          (action handlers, channel subscribers, slot
 *                          state hooks), and a collision either shadows
 *                          or compiles to ambiguous source. The agent's
 *                          downstream reasoning also fragments —
 *                          "submit" can't be both a discrete event AND
 *                          observable state without confusing the
 *                          actions-vs-context placement rule.
 *
 *   - `CTR_RESERVED_NAME` — a key on `actionSpec` or `contextSpec`
 *                          starts with the `_ggui:` reserved prefix.
 *                          `streamSpec` already enforces this in
 *                          `validateContractStructure` (server-owned
 *                          reserved channels can't be agent-declared);
 *                          this invariant extends the rule to the other
 *                          two inbound specs so the reserved namespace
 *                          is uniformly off-limits to authors. Today no
 *                          reserved actions or context slots exist, but
 *                          the protocol reserves the namespace forward
 *                          for runtime-owned signals.
 *
 * Pure checks; return violations rather than throwing. Callers that
 * want fail-fast semantics use {@link assertNameInvariants}. Folded
 * into `validateContractStructure` so the structural-validator surface
 * picks up these rules without per-caller wiring.
 *
 * Companion to {@link CrossReferenceError} in `./cross-references` —
 * the two modules ship the "phase 2: references" rule registry.
 */

import type { DataContract } from '../types/data-contract';
import type { ContractViolation } from './contract-validator';
import {
  RESERVED_CHANNEL_PREFIX,
  isReservedChannelName,
} from './reserved-channels';

/**
 * Stable error code for collisions across the three inbound spec maps
 * (`actionSpec` / `streamSpec` / `contextSpec`). The boilerplate
 * generator emits identifiers from these keys; a collision is an
 * author bug that the protocol catches at render.
 */
export const CTR_DUP_NAME = 'CTR_DUP_NAME';

/**
 * Stable error code for keys in the `_ggui:` reserved namespace on
 * `actionSpec` or `contextSpec`. `streamSpec` already enforces the
 * same rule in `validateContractStructure`.
 */
export const CTR_RESERVED_NAME = 'CTR_RESERVED_NAME';

/**
 * Name-invariant violation. Adds a stable `code` field on top of
 * `ContractViolation` so consumers can switch on the code rather than
 * pattern-matching message strings.
 */
export interface NameInvariantViolation extends ContractViolation {
  code: typeof CTR_DUP_NAME | typeof CTR_RESERVED_NAME;
}

/** Spec maps that share the inbound name namespace. */
const SPEC_FIELDS = ['actionSpec', 'streamSpec', 'contextSpec'] as const;
type SpecField = (typeof SPEC_FIELDS)[number];

/**
 * Validate that no name appears in more than one of `actionSpec`,
 * `streamSpec`, `contextSpec`. Emits one violation per colliding name
 * (not one per spec the name appears in) so the agent sees a single
 * actionable line per collision.
 *
 * Order is stable: collisions are reported in the order names first
 * appear when scanning `actionSpec` → `streamSpec` → `contextSpec`.
 */
export function checkNameCollisions(
  contract: DataContract,
): NameInvariantViolation[] {
  // Build name → list of spec fields where it appears
  const byName = new Map<string, SpecField[]>();
  for (const field of SPEC_FIELDS) {
    const spec = contract[field];
    if (!spec || typeof spec !== 'object') continue;
    for (const name of Object.keys(spec)) {
      const existing = byName.get(name);
      if (existing) {
        existing.push(field);
      } else {
        byName.set(name, [field]);
      }
    }
  }

  const violations: NameInvariantViolation[] = [];
  for (const [name, fields] of byName) {
    if (fields.length < 2) continue;
    violations.push({
      code: CTR_DUP_NAME,
      field: `${fields[0]}.${name}`,
      message: `Name '${name}' is declared in multiple specs: ${fields.join(', ')}. Each name MUST appear in exactly one of actionSpec / streamSpec / contextSpec — the boilerplate generator emits identifiers from these keys and collisions produce shadowed or ambiguous source.`,
      expected: 'unique name across inbound specs',
      received: fields.join(' + '),
    });
  }

  return violations;
}

/**
 * Validate that no `actionSpec` or `contextSpec` key uses the
 * `_ggui:` reserved namespace. `streamSpec` reserved-channel rejection
 * lives in `validateContractStructure` (the reserved namespace there
 * carries server-side semantics like the `_ggui:contract-error`
 * channel); this invariant extends the rule uniformly across the
 * other two inbound spec maps.
 *
 * Future runtime-owned action or context signals would carry the
 * `_ggui:` prefix and would be emitted by the runtime, not declared
 * by authors. Today no such signals exist, but the prefix is reserved
 * forward.
 */
export function checkReservedNames(
  contract: DataContract,
): NameInvariantViolation[] {
  const violations: NameInvariantViolation[] = [];

  for (const field of ['actionSpec', 'contextSpec'] as const) {
    const spec = contract[field];
    if (!spec || typeof spec !== 'object') continue;
    for (const name of Object.keys(spec)) {
      if (!isReservedChannelName(name)) continue;
      violations.push({
        code: CTR_RESERVED_NAME,
        field: `${field}.${name}`,
        message: `${field}.${name} is in the reserved '${RESERVED_CHANNEL_PREFIX}' namespace — names starting with that prefix are reserved for runtime-owned signals and cannot be agent-declared.`,
        expected: `name not starting with '${RESERVED_CHANNEL_PREFIX}'`,
        received: name,
      });
    }
  }

  return violations;
}

/**
 * Run every name-invariant check. Returns the aggregated violation
 * list — order is stable: collisions first, reserved names second.
 *
 * Pure check; doesn't throw. Callers that want fail-fast semantics
 * use {@link assertNameInvariants}.
 */
export function checkNameInvariants(
  contract: DataContract,
): NameInvariantViolation[] {
  return [...checkNameCollisions(contract), ...checkReservedNames(contract)];
}

/**
 * Throwable form of {@link checkNameInvariants}. Use at protocol
 * boundaries where a name collision or reserved-namespace use is a
 * contract bug the caller must fix (render handler, blueprint
 * registration).
 *
 * Carries the full violation list so error renderers can show every
 * offending name in one pass instead of fix-and-retry per-field.
 */
export class NameInvariantError extends Error {
  readonly code = 'name_invariant_violation' as const;
  readonly violations: readonly NameInvariantViolation[];

  constructor(violations: readonly NameInvariantViolation[]) {
    const summary = violations
      .map((v) => `[${v.code}] ${v.message}`)
      .join(' | ');
    super(`Contract name-invariant check failed: ${summary}`);
    this.name = 'NameInvariantError';
    this.violations = violations;
  }
}

/**
 * Throw-on-violation wrapper around {@link checkNameInvariants}.
 * No-op when the contract's names are consistent.
 *
 * Designed to slot alongside `assertCrossReferences` at render time:
 * cross-reference invariants catch dangling pointers between specs;
 * name invariants catch malformed name spaces within specs. Both
 * surface author-recoverable failures before any state mutation.
 */
export function assertNameInvariants(contract: DataContract): void {
  const violations = checkNameInvariants(contract);
  if (violations.length > 0) {
    throw new NameInvariantError(violations);
  }
}
