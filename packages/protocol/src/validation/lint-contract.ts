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
 *   phase 2: references     (CTR_REF_*, CTR_DUP_NAME, CTR_RESERVED_NAME)
 *   phase 3: schema compat  (CTR_SCHEMA_INCOMPAT)
 *   phase 4: hygiene        (LINT_*  — graded, warnings only today)
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
import { checkHygiene, type HygieneWarning } from './hygiene-rules';

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

function phaseShape(contract: unknown): ContractIssue[] {
  const parsed = dataContractSchema.safeParse(contract);
  if (parsed.success) return [];

  return zodErrorToIssues(parsed.error);
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
export function validateContract(contract: DataContract): void {
  const shapeIssues = phaseShape(contract);
  if (shapeIssues.length > 0) {
    throw new ContractValidationError('shape', shapeIssues);
  }
  // After phase 1 we know the contract structurally parses; safe to
  // cast through into the phase-2 / phase-3 helpers (they accept
  // `DataContract` directly).
  const refIssues = phaseReferences(contract);
  if (refIssues.length > 0) {
    throw new ContractValidationError('references', refIssues);
  }
  const compatIssues = phaseSchemaCompat(contract);
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
export function lintContract(contract: DataContract): ContractLintResult {
  const issues: ContractIssue[] = [];
  issues.push(...phaseShape(contract));
  // Phase 2 + 3 produce shape-dependent errors. When the shape
  // phase already failed, the contract may not match the type
  // signatures these phases assume — skip downstream phases in that
  // case to avoid throwing during the lint run. Authoring tools see
  // "fix shape first" via the shape issues; once those are clean
  // the next `lintContract` run reaches the deeper phases.
  if (issues.length === 0) {
    issues.push(...phaseReferences(contract));
    issues.push(...phaseSchemaCompat(contract));
  }
  issues.push(...phaseHygiene(contract));

  const errors: ContractIssue[] = [];
  const warnings: ContractIssue[] = [];
  for (const issue of issues) {
    if (issue.severity === 'error') errors.push(issue);
    else warnings.push(issue);
  }
  return { errors, warnings };
}
