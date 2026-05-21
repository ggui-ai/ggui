/**
 * Schema-conformance catalog — pure-schema accept / reject cases for
 * the gadget WIRE shape (`DataContract.clientCapabilities`, SPEC
 * §7.7.2).
 *
 * ## Why this is SEPARATE from the `./fixtures` behavioral catalog
 *
 * The `./fixtures` catalog asserts *behavioral* obligations — what a
 * live implementation DOES when driven by an input envelope (a
 * push-gate rejection, a bootstrap projection). Those need a host, a
 * transport, and a runner.
 *
 * This catalog asserts a *structural* obligation: which
 * `clientCapabilities` payloads a spec-conformant parser MUST accept
 * and which it MUST reject — a property of the schema alone, with no
 * session, no transport, no host. Folding it into the behavioral
 * fixture shape (`TestCase`) would mean inventing a no-op
 * `inputEnvelope` and a fake behavior kind for every case. Keeping it
 * a distinct, smaller artifact is the honest modeling.
 *
 * ## Polyglot, decoupled
 *
 * Each case ships as raw JSON under `./cases/` so a non-TypeScript
 * implementer (Python, Go, Rust) can read the catalog and grade their
 * own `clientCapabilities` parser. {@link runSchemaConformance} takes
 * the validator as a callback — the kit never imports a concrete
 * schema here, so adopters drive their OWN parser. The reference
 * binding (the kit's own meta-test) wires `@ggui-ai/protocol`'s
 * `clientCapabilitiesSpecSchema`; see `./schema-conformance.test.ts`.
 *
 * The authored vocabulary is pinned here, deliberately decoupled from
 * the live `@ggui-ai/protocol` source tree — the same drift discipline
 * `../types.ts` applies to the behavioral fixture surface.
 */
import wireBadExportNameReject from './cases/wire-bad-export-name-reject.json' with { type: 'json' };
import wireBadPackageNameReject from './cases/wire-bad-package-name-reject.json' with { type: 'json' };
import wireComponentExportAccept from './cases/wire-component-export-accept.json' with { type: 'json' };
import wireEmptyPackageReject from './cases/wire-empty-package-reject.json' with { type: 'json' };
import wireMinimalAccept from './cases/wire-minimal-accept.json' with { type: 'json' };
import wireMultiPackageAccept from './cases/wire-multi-package-accept.json' with { type: 'json' };
import wireProseAccept from './cases/wire-prose-accept.json' with { type: 'json' };
import wireRegistryMetadataReject from './cases/wire-registry-metadata-reject.json' with { type: 'json' };
import wireStaleLibrariesReject from './cases/wire-stale-libraries-reject.json' with { type: 'json' };
import wireStdlibAccept from './cases/wire-stdlib-accept.json' with { type: 'json' };
import wireTransportFieldReject from './cases/wire-transport-field-reject.json' with { type: 'json' };
import wireVersionFieldReject from './cases/wire-version-field-reject.json' with { type: 'json' };

/**
 * One schema-conformance case. Authored as JSON under `./cases/`,
 * consumed via {@link gadgetWireSchemaCases}, graded by
 * {@link runSchemaConformance}.
 *
 * The shape IS the public API — additive changes only, mirroring the
 * `TestCase` discipline in `../types.ts`.
 */
export interface SchemaConformanceCase {
  /** Unique case name. MUST match the JSON filename without `.json`. */
  readonly name: string;
  /** What structural obligation this case proves. */
  readonly description: string;
  /**
   * The `DataContract.clientCapabilities` value fed verbatim to the
   * validator. `unknown` because reject cases are deliberately
   * malformed — the catalog's whole point is feeding the parser
   * payloads its type would not admit.
   */
  readonly clientCapabilities: unknown;
  /**
   * Whether a spec-conformant `clientCapabilities` parser MUST accept
   * or reject {@link clientCapabilities}.
   */
  readonly expect: 'accept' | 'reject';
  /**
   * The normative reason a conformant parser rejects this case.
   * Present iff `expect === 'reject'`.
   */
  readonly rejectReason?: string;
}

/**
 * Every gadget-wire schema-conformance case the kit ships, in
 * deterministic order — accepts first, then rejects, each group
 * lexicographic by `name`.
 */
export const gadgetWireSchemaCases: readonly SchemaConformanceCase[] = [
  wireComponentExportAccept as SchemaConformanceCase,
  wireMinimalAccept as SchemaConformanceCase,
  wireMultiPackageAccept as SchemaConformanceCase,
  wireProseAccept as SchemaConformanceCase,
  wireStdlibAccept as SchemaConformanceCase,
  wireBadExportNameReject as SchemaConformanceCase,
  wireBadPackageNameReject as SchemaConformanceCase,
  wireEmptyPackageReject as SchemaConformanceCase,
  wireRegistryMetadataReject as SchemaConformanceCase,
  wireStaleLibrariesReject as SchemaConformanceCase,
  wireTransportFieldReject as SchemaConformanceCase,
  wireVersionFieldReject as SchemaConformanceCase,
];

/** One case the validator graded wrong. */
export interface SchemaConformanceMismatch {
  readonly name: string;
  /** What the catalog says a conformant parser MUST do. */
  readonly expected: 'accept' | 'reject';
  /** What the validator under test actually did. */
  readonly actual: 'accept' | 'reject';
  /** The reject reason from the case, when `expected === 'reject'`. */
  readonly rejectReason?: string;
}

/** Outcome of grading a validator against the catalog. */
export interface SchemaConformanceResult {
  /** Names of cases the validator graded correctly. */
  readonly passed: readonly string[];
  /** Cases the validator graded wrong — empty iff fully conformant. */
  readonly failed: readonly SchemaConformanceMismatch[];
}

/**
 * Grade a `clientCapabilities` validator against the gadget-wire
 * schema-conformance catalog.
 *
 * `validate` MUST return `true` iff its parser accepts the input as a
 * well-formed `DataContract.clientCapabilities`, `false` otherwise.
 * The kit deliberately does NOT import a concrete schema — adopters
 * pass their own parser (a zod `safeParse`, a Go struct decode, a
 * pydantic model) and the catalog grades it. A conformant validator
 * produces an empty `failed` array.
 *
 * `validate` is invoked exactly once per case; it MUST be pure and
 * MUST NOT throw (a throwing parser is itself non-conformant — wrap
 * it). Cases are graded in {@link gadgetWireSchemaCases} order.
 */
export function runSchemaConformance(
  validate: (clientCapabilities: unknown) => boolean,
): SchemaConformanceResult {
  const passed: string[] = [];
  const failed: SchemaConformanceMismatch[] = [];
  for (const testCase of gadgetWireSchemaCases) {
    const actual: 'accept' | 'reject' = validate(testCase.clientCapabilities)
      ? 'accept'
      : 'reject';
    if (actual === testCase.expect) {
      passed.push(testCase.name);
    } else {
      failed.push({
        name: testCase.name,
        expected: testCase.expect,
        actual,
        ...(testCase.rejectReason !== undefined
          ? { rejectReason: testCase.rejectReason }
          : {}),
      });
    }
  }
  return { passed, failed };
}
