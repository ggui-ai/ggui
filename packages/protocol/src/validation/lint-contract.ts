/**
 * Unified protocol-linter entry points for `DataContract`.
 *
 * Two reporting modes share one rule registry:
 *
 *   - {@link validateContract} — strict; runs phased validation and
 *     throws {@link ContractValidationError} on the FIRST phase that
 *     produces errors. Used at every protocol boundary (push handler,
 *     blueprint registration, future synth output gate).
 *
 *   - {@link lintContract} — graded; runs ALL phases unconditionally
 *     and returns errors + warnings together. Used by authoring
 *     tools (synth's self-correction loop, blueprint registration's
 *     warning surfaces, future contract-author tooling).
 *
 * **Phased execution** (stop-at-first-error-class for `validateContract`):
 *
 *   ```
 *   phase 1: shape          (zod wire-shape validation)
 *   phase 2: retired        (CTR_RETIRED_FIELD — dead top-level fields)
 *   phase 3: schema-meta    (CTR_SCHEMA_META_INVALID — Ajv strict on inner schemas)
 *   phase 4: references     (CTR_REF_*, CTR_DUP_NAME, CTR_RESERVED_NAME)
 *   phase 5: schema compat  (CTR_SCHEMA_INCOMPAT)
 *   phase 6: hygiene        (LINT_*  — graded, warnings only)
 *   ```
 *
 * Errors are reported one phase at a time during strict validation so
 * the LLM gets a clean signal during iterative authoring — fixing a
 * shape bug first, then references, then schemas, then hygiene. The
 * graded mode emits every issue at once so authoring tools can
 * present a complete checklist.
 */

import { ZodError } from 'zod';
import type { DataContract } from '../types/data-contract';
import { dataContractSchema } from '../schemas/data-contract';
import {
  checkCrossReferences,
  type CrossReferenceViolation,
} from './cross-references';
import {
  checkNameInvariants,
  type NameInvariantViolation,
} from './name-invariants';
import {
  checkSchemaCompat,
  type SchemaCompatViolation,
} from './schema-compat-invariants';
import { checkContractSchemasValid } from './schema-meta-validation';
import {
  checkHygiene,
  checkRetiredContractFields,
  type HygieneWarning,
} from './hygiene-rules';

/**
 * Severity classification for a {@link ContractIssue}. Strict
 * `validateContract` throws on `'error'`; graded `lintContract`
 * surfaces both, partitioned by severity.
 */
export type ContractIssueSeverity = 'error' | 'warn';

/**
 * Phase classification for a {@link ContractIssue}. Surfaced so
 * authoring tools can render issues grouped by phase + drive the
 * "fix one phase at a time" UX.
 */
export type ContractLintPhase =
  | 'shape'
  | 'retired'
  | 'schema-meta'
  | 'references'
  | 'schema-compat'
  | 'hygiene';

/**
 * One observation about a contract from the linter's perspective.
 *
 * Stable-code-keyed (vs. the existing per-module `ContractViolation`
 * shape) so authoring tools can pattern-match on `code` and drive
 * fix workflows. The pre-existing per-module violation types
 * (`CrossReferenceViolation`, `NameInvariantViolation`,
 * `SchemaCompatViolation`) map into this shape via the internal
 * conversion helpers in this file; consumers of `lintContract` /
 * `validateContract` see only `ContractIssue`.
 */
export interface ContractIssue {
  /** Stable error code (e.g., 'CTR_REF_NEXT_STEP', 'CTR_DUP_NAME'). */
  readonly code: string;
  readonly severity: ContractIssueSeverity;
  readonly phase: ContractLintPhase;
  /**
   * Field path into the contract identifying the offending entry.
   * Uses dotted JS-style notation matching the per-module
   * `ContractViolation.field` convention
   * (`actionSpec.archive.nextStep`).
   */
  readonly path: string;
  /** Human-readable violation prose. */
  readonly message: string;
  /**
   * Optional remediation hint. Future hygiene-phase rules emit a
   * fix recipe here ("declare `usage` on this entry"); invariant
   * rules embed the recipe directly in `message` today.
   */
  readonly fixHint?: string;
}

/**
 * Aggregate result of {@link lintContract}. Errors and warnings are
 * partitioned at construction; consumers that want a flat list can
 * concatenate.
 */
export interface ContractLintResult {
  readonly errors: readonly ContractIssue[];
  readonly warnings: readonly ContractIssue[];
}

/**
 * Strict-mode failure. Carries the offending phase + every issue
 * the failing phase produced so error renderers can show every fix
 * in one pass without re-running the linter.
 *
 * The `phase` field discriminates the error class: shape errors
 * surface as a single rolled-up zod failure; reference / schema-compat
 * errors carry one issue per violation.
 */
export class ContractValidationError extends Error {
  readonly code = 'contract_validation_failed' as const;
  readonly phase: ContractLintPhase;
  readonly issues: readonly ContractIssue[];

  constructor(phase: ContractLintPhase, issues: readonly ContractIssue[]) {
    const summary = issues.map((i) => `[${i.code}] ${i.message}`).join(' | ');
    super(`Contract validation failed at phase '${phase}': ${summary}`);
    this.name = 'ContractValidationError';
    this.phase = phase;
    this.issues = issues;
  }
}

// =============================================================================
// Phase 1 — shape (zod wire-shape validation)
// =============================================================================

function phaseShape(contract: unknown): {
  issues: ContractIssue[];
  parsed: DataContract | null;
} {
  const parsed = dataContractSchema.safeParse(contract);
  if (parsed.success) return { issues: [], parsed: parsed.data };
  return { issues: zodErrorToIssues(parsed.error), parsed: null };
}

function zodErrorToIssues(error: ZodError): ContractIssue[] {
  return error.issues.map((issue) => ({
    code: zodIssueCode(issue.code),
    severity: 'error' as const,
    phase: 'shape' as const,
    path: issue.path.join('.') || '<root>',
    message: issue.message,
  }));
}

/**
 * Map a zod issue code to the linter's stable code namespace. The
 * mapping is intentionally narrow — every unknown zod code rolls up
 * to `CTR_SHAPE_INVALID`; consumers that want zod-level granularity
 * can re-parse with `dataContractSchema.safeParse` themselves.
 */
function zodIssueCode(zodCode: string): string {
  switch (zodCode) {
    case 'invalid_type':
      return 'CTR_SHAPE_INVALID_TYPE';
    case 'unrecognized_keys':
      return 'CTR_SHAPE_UNRECOGNIZED_KEYS';
    default:
      return 'CTR_SHAPE_INVALID';
  }
}

// =============================================================================
// Phase — retired fields (CTR_RETIRED_FIELD)
// =============================================================================

/**
 * Retired top-level field carriers (`wiredTools`, `libraries`,
 * `dispatch`, …) are a fatal contract bug: the field rides through the
 * `.passthrough()` schema but names dead protocol surface. Promoted
 * from a hygiene WARNING to an ERROR so it routes through the same gate
 * as every other contract error — the handshake repair loop remaps it
 * (an LLM correctly re-nests `wiredTools` → `agentCapabilities.tools`),
 * and `ggui_render`'s override path rejects it. Shares the one detector
 * (`checkRetiredContractFields`) with the author-time surface + the
 * push-gate assert, so the retired vocabulary can't drift across sites.
 */
function phaseRetired(contract: DataContract): ContractIssue[] {
  return checkRetiredContractFields(contract).map((w): ContractIssue => ({
    code: 'CTR_RETIRED_FIELD',
    severity: 'error',
    phase: 'retired',
    path: w.path,
    message: w.message,
    ...(w.fixHint !== undefined ? { fixHint: w.fixHint } : {}),
  }));
}

// =============================================================================
// Phase — schema-meta (CTR_SCHEMA_META_INVALID, Ajv strict meta-validation)
// =============================================================================

/**
 * Inner JSON Schema meta-validation — each `schema:` field must compile
 * under Ajv strict mode. Distinct from phase-1 shape: zod validates the
 * WRAPPER shape, but the wrapped JSON Schema rides through
 * `.passthrough()` unvalidated. Runs before references / schema-compat,
 * which read these schemas. This is the check the push/handshake assert
 * set had that `validateContract` was previously missing — folding it in
 * here is what makes the strict gate complete (and therefore safe to use
 * as the single boundary gate).
 */
function phaseSchemaMeta(contract: DataContract): ContractIssue[] {
  return checkContractSchemasValid(contract).map((v): ContractIssue => ({
    code: 'CTR_SCHEMA_META_INVALID',
    severity: 'error',
    phase: 'schema-meta',
    path: v.field,
    message: v.message,
  }));
}

// =============================================================================
// Phase 2 — references (CTR_REF_*, CTR_DUP_NAME, CTR_RESERVED_NAME)
// =============================================================================

function phaseReferences(contract: DataContract): ContractIssue[] {
  const issues: ContractIssue[] = [];
  for (const v of checkCrossReferences(contract)) {
    issues.push(crossRefViolationToIssue(v));
  }
  for (const v of checkNameInvariants(contract)) {
    issues.push(nameInvariantViolationToIssue(v));
  }
  return issues;
}

function crossRefViolationToIssue(v: CrossReferenceViolation): ContractIssue {
  return {
    code: v.code,
    severity: 'error',
    phase: 'references',
    path: v.field,
    message: v.message,
  };
}

function nameInvariantViolationToIssue(
  v: NameInvariantViolation,
): ContractIssue {
  return {
    code: v.code,
    severity: 'error',
    phase: 'references',
    path: v.field,
    message: v.message,
  };
}

// =============================================================================
// Phase 3 — schema compat (CTR_SCHEMA_INCOMPAT)
// =============================================================================

function phaseSchemaCompat(contract: DataContract): ContractIssue[] {
  return checkSchemaCompat(contract).map(schemaCompatViolationToIssue);
}

function schemaCompatViolationToIssue(
  v: SchemaCompatViolation,
): ContractIssue {
  return {
    code: v.code,
    severity: 'error',
    phase: 'schema-compat',
    path: v.field,
    message: v.message,
  };
}

// =============================================================================
// Phase 4 — hygiene (LINT_*)
// =============================================================================

function phaseHygiene(contract: DataContract): ContractIssue[] {
  return checkHygiene(contract).map(hygieneWarningToIssue);
}

function hygieneWarningToIssue(w: HygieneWarning): ContractIssue {
  return {
    code: w.code,
    severity: 'warn',
    phase: 'hygiene',
    path: w.path,
    message: w.message,
    ...(w.fixHint !== undefined ? { fixHint: w.fixHint } : {}),
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Strict-mode validator. Runs the four phases in order; throws
 * {@link ContractValidationError} on the FIRST phase that produces
 * errors. Used at every protocol boundary where a malformed
 * contract is a fatal author bug.
 *
 * Phases run in dependency order:
 *
 *   1. shape — zod parse fails ⇒ nothing else makes sense
 *   2. references — refs must resolve before schema-compat can read
 *      the referenced tool's schemas
 *   3. schema-compat — checks rely on resolved references
 *   4. hygiene — warnings only; never throws (handled by lintContract)
 *
 * Hygiene-only contracts (warnings without errors) pass the strict
 * gate. Use {@link lintContract} when warnings matter.
 */
export function validateContract(contract: unknown): void {
  const shape = phaseShape(contract);
  if (shape.issues.length > 0) {
    throw new ContractValidationError('shape', shape.issues);
  }
  // Shape passed ⇒ a parsed DataContract is available for the deeper,
  // type-dependent phases. The null check narrows `c` to DataContract
  // without a cast (unreachable: no shape issues ⇒ parsed present).
  const c = shape.parsed;
  if (c === null) return;
  const retiredIssues = phaseRetired(c);
  if (retiredIssues.length > 0) {
    throw new ContractValidationError('retired', retiredIssues);
  }
  const schemaMetaIssues = phaseSchemaMeta(c);
  if (schemaMetaIssues.length > 0) {
    throw new ContractValidationError('schema-meta', schemaMetaIssues);
  }
  const refIssues = phaseReferences(c);
  if (refIssues.length > 0) {
    throw new ContractValidationError('references', refIssues);
  }
  const compatIssues = phaseSchemaCompat(c);
  if (compatIssues.length > 0) {
    throw new ContractValidationError('schema-compat', compatIssues);
  }
  // Hygiene is graded-only; not thrown by strict validator.
}

/**
 * Graded-mode linter. Runs ALL phases unconditionally and returns
 * errors + warnings partitioned. Suitable for authoring tools that
 * want a complete checklist of issues + suggestions rather than the
 * fail-fast posture of {@link validateContract}.
 *
 * Phase ordering still matters for diagnostics (issues are returned
 * in phase order); but graded mode never short-circuits, so an
 * author seeing a phase-2 reference error also sees the phase-4
 * hygiene warnings on the same contract.
 */
export function lintContract(contract: unknown): ContractLintResult {
  const issues: ContractIssue[] = [];
  const shape = phaseShape(contract);
  issues.push(...shape.issues);
  // Phases beyond shape are shape-dependent and need a parsed
  // DataContract. When shape failed, skip them (the contract may not
  // match the type signatures these phases assume); authoring tools see
  // "fix shape first" via the shape issues, and the next run reaches the
  // deeper phases once shape is clean.
  if (shape.issues.length === 0 && shape.parsed !== null) {
    const c = shape.parsed;
    issues.push(...phaseRetired(c));
    issues.push(...phaseSchemaMeta(c));
    issues.push(...phaseReferences(c));
    issues.push(...phaseSchemaCompat(c));
    issues.push(...phaseHygiene(c));
  }

  const errors: ContractIssue[] = [];
  const warnings: ContractIssue[] = [];
  for (const issue of issues) {
    if (issue.severity === 'error') errors.push(issue);
    else warnings.push(issue);
  }
  return { errors, warnings };
}
