/**
 * Props-schema conformance catalog — the arbiter fixtures for the
 * schema-precise render contract (frozen shape 2026-08-19; the six
 * pins in `docs/plans/2026-08-19-schema-precise-render.md` §2).
 *
 * Four obligations, one catalog:
 *
 *   - **DRIFT** — `buildPropsSchema(propsSpec)` MUST produce the
 *     case's `propsSchema` exactly (canonical construction: sorted
 *     keys at every schema node, closed shape materialized,
 *     `nullable` rewritten, metadata keywords stripped).
 *   - **HASH** — sha256 over the RFC 8785 canonical bytes of that
 *     schema MUST equal the case's `propsSchemaHash` (lowercase hex,
 *     64 chars). Portable: any JCS library + sha256 reproduces it.
 *   - **PROFILE** — the grammar-safe classification MUST equal the
 *     case's `propsSchemaProfile` (purely syntactic keyword
 *     membership; unknown wire values degrade to `'full'` on the
 *     consumer side, but a producer MUST emit the reference verdict).
 *   - **AUTHORITY** — every sample's validity under a validator
 *     compiled FROM THE CASE'S `propsSchema` (format-assertive
 *     dialect) MUST equal `valid`. The returned schema IS the
 *     enforced schema; the samples include the live-incident
 *     out-of-vocabulary enum value.
 *
 * Same modeling as `../schema-conformance`: structural obligations,
 * no transport, no host. Cases ship as raw JSON under `./cases/` so a
 * non-TypeScript implementer can grade their own builder/validator;
 * {@link runPropsSchemaConformance} takes the implementation as
 * callbacks — the kit never imports a concrete implementation here.
 * The reference binding (the kit's own meta-test) wires
 * `@ggui-ai/protocol`'s exports; see
 * `./props-schema-conformance.test.ts`.
 */
import emptyClosedWrapper from './cases/empty-closed-wrapper.json' with { type: 'json' };
import formatInCoreAssertive from './cases/format-in-core-assertive.json' with { type: 'json' };
import formatOutOfListFull from './cases/format-out-of-list-full.json' with { type: 'json' };
import nullableNormalization from './cases/nullable-normalization.json' with { type: 'json' };
import nullableObjectClosed from './cases/nullable-object-closed.json' with { type: 'json' };
import outOfCorePatternFull from './cases/out-of-core-pattern-full.json' with { type: 'json' };
import requiredOrderCanonical from './cases/required-order-canonical.json' with { type: 'json' };
import schedulerEnumAuthority from './cases/scheduler-enum-authority.json' with { type: 'json' };

/**
 * Authored vocabulary — pinned here, deliberately decoupled from the
 * live `@ggui-ai/protocol` source tree (the same drift discipline the
 * behavioral fixture surface applies). JSON-representable only.
 */
export interface PropsSchemaConformanceSample {
  readonly props: Record<string, unknown>;
  readonly valid: boolean;
  readonly note?: string;
}

export interface PropsSchemaConformanceCase {
  readonly id: string;
  readonly description: string;
  /** The authored PropsSpec (JSON form). */
  readonly propsSpec: Record<string, unknown>;
  /** The expected enforced-schema artifact, in canonical form. */
  readonly propsSchema: Record<string, unknown>;
  /** sha256 (lowercase hex) over the RFC 8785 bytes of `propsSchema`. */
  readonly propsSchemaHash: string;
  /** Reference profile verdict. */
  readonly propsSchemaProfile: 'grammar-safe' | 'full';
  readonly samples: readonly PropsSchemaConformanceSample[];
}

/** The published catalog, id-sorted for deterministic reporting. */
export const propsSchemaConformanceCases: readonly PropsSchemaConformanceCase[] =
  [
    emptyClosedWrapper,
    formatInCoreAssertive,
    formatOutOfListFull,
    nullableNormalization,
    nullableObjectClosed,
    outOfCorePatternFull,
    requiredOrderCanonical,
    schedulerEnumAuthority,
  ] as PropsSchemaConformanceCase[];

/** The implementation under test, as callbacks. */
export interface PropsSchemaImplementation {
  /** The enforced-schema builder (reference: `buildEnforcedPropsSchema`). */
  readonly build: (
    propsSpec: Record<string, unknown>,
  ) => Record<string, unknown>;
  /** The canonical hash (reference: `computePropsSchemaHash`). */
  readonly hash: (schema: Record<string, unknown>) => string;
  /** The profile classifier (reference: `classifyPropsSchemaProfile`). */
  readonly classify: (schema: Record<string, unknown>) => string;
  /**
   * Validity of `props` under a validator compiled from `schema`,
   * read per the pinned dialect (draft-07, format-assertive, closed
   * shape already in the bytes). Reference:
   * `validatePropsDataWithSchema(props, schema).valid`.
   */
  readonly validate: (
    props: Record<string, unknown>,
    schema: Record<string, unknown>,
  ) => boolean;
}

export interface PropsSchemaConformanceFailure {
  readonly caseId: string;
  readonly obligation: 'drift' | 'hash' | 'profile' | 'authority';
  readonly detail: string;
}

export interface PropsSchemaConformanceReport {
  readonly total: number;
  readonly failures: readonly PropsSchemaConformanceFailure[];
}

/**
 * Grade an implementation against the catalog. Deterministic; every
 * failure names the case, the obligation, and the observed value —
 * the report is the observable-violation surface of this contract.
 */
export function runPropsSchemaConformance(
  impl: PropsSchemaImplementation,
): PropsSchemaConformanceReport {
  const failures: PropsSchemaConformanceFailure[] = [];
  for (const testCase of propsSchemaConformanceCases) {
    const built = impl.build(testCase.propsSpec);
    if (JSON.stringify(built) !== JSON.stringify(testCase.propsSchema)) {
      failures.push({
        caseId: testCase.id,
        obligation: 'drift',
        detail: `built schema differs from the pinned artifact: ${JSON.stringify(built)}`,
      });
    }
    const hash = impl.hash(testCase.propsSchema);
    if (hash !== testCase.propsSchemaHash) {
      failures.push({
        caseId: testCase.id,
        obligation: 'hash',
        detail: `expected ${testCase.propsSchemaHash}, got ${hash}`,
      });
    }
    const profile = impl.classify(testCase.propsSchema);
    if (profile !== testCase.propsSchemaProfile) {
      failures.push({
        caseId: testCase.id,
        obligation: 'profile',
        detail: `expected '${testCase.propsSchemaProfile}', got '${profile}'`,
      });
    }
    for (const sample of testCase.samples) {
      const valid = impl.validate(sample.props, testCase.propsSchema);
      if (valid !== sample.valid) {
        failures.push({
          caseId: testCase.id,
          obligation: 'authority',
          detail: `props ${JSON.stringify(sample.props)} expected valid=${sample.valid}, got ${valid}${sample.note ? ` (${sample.note})` : ''}`,
        });
      }
    }
  }
  return { total: propsSchemaConformanceCases.length, failures };
}
