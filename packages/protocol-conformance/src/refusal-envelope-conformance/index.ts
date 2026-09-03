/**
 * Refusal-envelope conformance catalog — the projection obligation for a
 * PRE-GENERATION refusal (SPEC §7.1's refused arm, ggui#786).
 *
 * ## Why this is a pure-function catalog
 *
 * Given a refusal a deployment's gate returned, the tool result a
 * conformant server emits is a pure, deterministic projection — no
 * render, no transport, no wire frame. So it gets the same treatment as
 * the wire schema (`../schema-conformance`) and the gadget URL resolver
 * (`../resolution-conformance`): a catalog of cases graded against a
 * caller-supplied projector.
 *
 * The obligation, restated from SPEC §7.1 so an implementer never has
 * to guess:
 *
 *   - The result is an `isError: true` TOOL RESULT — never a thrown
 *     error, never a JSON-RPC error. A gate that throws instead of
 *     returning a refusal is non-conformant, which is why the runner
 *     grades a throwing projector as a failure on every case rather
 *     than letting the exception escape.
 *   - `content[0].text` LEADS with the code, then the message and the
 *     fix. A courtesy line for the model; the machine-readable code is
 *     the mechanism.
 *   - `structuredContent` is `{outcome: 'refused', refusal}` and
 *     NOTHING else. A refusal commits nothing, so no identity field
 *     may appear on it.
 *   - No `_meta`. A refusal exposes no mount affordance.
 *   - A code whose registered surfaces exclude the render gate has NO
 *     render envelope; a conformant projector produces none.
 *
 * ## Polyglot, decoupled
 *
 * Each case ships as raw JSON under `./cases/`.
 * {@link runRefusalEnvelopeConformance} takes the projector as a
 * callback — the kit never imports a concrete server here, so adopters
 * drive their OWN. The reference binding
 * (`./refusal-envelope-conformance.test.ts`) builds a faithful in-test
 * projector from `@ggui-ai/protocol` primitives only; the drift-catch
 * against a SHIPPING projector belongs implementation-side, in the
 * package that owns it.
 *
 * ## Not a WS fixture
 *
 * These cases are deliberately NOT registered in `fixturesByContract`.
 * The obligation is a projection, not a WebSocket-observable behavior,
 * so registering it there would be a permanent skip on every run —
 * exactly the false gate the kit's exact skip-set pinning prevents.
 * `runConformance()` / the CLI / the reporter are untouched; the entry
 * point is the programmatic runner below.
 */
import refuseAfterFixCaller from './cases/refuse-after-fix-caller.json' with { type: 'json' };
import refuseAfterFixOwnerWithBalance from './cases/refuse-after-fix-owner-with-balance.json' with { type: 'json' };
import refuseLater from './cases/refuse-later.json' with { type: 'json' };
import refuseNever from './cases/refuse-never.json' with { type: 'json' };
import refuseNextPeriod from './cases/refuse-next-period.json' with { type: 'json' };
import refuseNonRenderSurface from './cases/refuse-non-render-surface.json' with { type: 'json' };

/**
 * The refusal a deployment's gate returned, as the projector receives
 * it. Authored here rather than imported from `@ggui-ai/protocol`:
 * this is the kit's own vocabulary, and `code` is typed loosely on
 * purpose so a catalog case can carry a registered code from ANY
 * surface — including one that must not project.
 */
export interface PreGenerationRefusalInput {
  /** A code from the deployment's refusal registry. */
  readonly code: string;
  /** Precise diagnostic — what was checked, against what. */
  readonly message: string;
  /** The one recovery step, addressed to the party that can take it. */
  readonly fix: string;
  /** How the call becomes possible again. */
  readonly retry: string;
  /** Always `intact` — a refusal reads nothing, so it consumes nothing. */
  readonly handshake: string;
  /** Present only when the refusing check read a balance. */
  readonly balanceCentsAtCheck?: number;
}

/**
 * The observable shape of the tool result a conformant server emits for
 * a refusal. Deliberately flattened to the four facts the obligation is
 * about, so an implementation in any language can report them without
 * reproducing an MCP result object.
 */
export interface ProjectedRefusalResult {
  /** MUST be true — a refusal is an in-result error, never a throw. */
  readonly isError: boolean;
  /** `content[0].text` — leads with the code, then message and fix. */
  readonly text: string;
  /** The whole `structuredContent`. */
  readonly structuredContent: {
    readonly outcome: string;
    readonly refusal: PreGenerationRefusalInput;
  };
  /** Whether the result carries any `_meta`. MUST be false. */
  readonly hasMeta: boolean;
  /**
   * Identity fields the projector put on the envelope. MUST be empty —
   * a refusal commits nothing, so any identity field means the
   * projection leaked state that does not exist.
   */
  readonly identityFields: readonly string[];
}

/**
 * One refusal-envelope case. Authored as JSON under `./cases/`,
 * consumed via {@link refusalEnvelopeCases}, graded by
 * {@link runRefusalEnvelopeConformance}.
 *
 * The shape IS the public API — additive changes only.
 */
export interface RefusalEnvelopeConformanceCase {
  /** Unique case name. MUST match the JSON filename without `.json`. */
  readonly name: string;
  /** Which projection obligation this case proves. */
  readonly description: string;
  /** The refusal fed to the projector. */
  readonly refusal: PreGenerationRefusalInput;
  /**
   * The result a spec-conformant projector MUST produce — or `null`
   * when the code has no render envelope at all (its registered
   * surfaces exclude the render gate).
   */
  readonly expect: ProjectedRefusalResult | null;
}

/**
 * Every refusal-envelope case the kit ships, in deterministic order:
 * the projectable cases by retry class (after-fix, next-period, later,
 * never), then the non-projectable surface case.
 */
export const refusalEnvelopeCases: readonly RefusalEnvelopeConformanceCase[] = [
  refuseAfterFixCaller as RefusalEnvelopeConformanceCase,
  refuseAfterFixOwnerWithBalance as RefusalEnvelopeConformanceCase,
  refuseNextPeriod as RefusalEnvelopeConformanceCase,
  refuseLater as RefusalEnvelopeConformanceCase,
  refuseNever as RefusalEnvelopeConformanceCase,
  refuseNonRenderSurface as RefusalEnvelopeConformanceCase,
];

/** One case the projector under test graded wrong. */
export interface RefusalEnvelopeMismatch {
  readonly name: string;
  /** What the catalog says a conformant projector MUST produce. */
  readonly expected: ProjectedRefusalResult | null;
  /**
   * What the projector produced — or, when it THREW instead of
   * returning, a one-line report of the throw. A gate that throws to
   * refuse is non-conformant, so the throw is graded, never rethrown.
   */
  readonly actual: ProjectedRefusalResult | null | string;
}

/** Outcome of grading a projector against the catalog. */
export interface RefusalEnvelopeConformanceResult {
  /** Names of cases the projector graded correctly. */
  readonly passed: readonly string[];
  /** Cases the projector graded wrong — empty iff fully conformant. */
  readonly failed: readonly RefusalEnvelopeMismatch[];
}

/** Structural equality over plain JSON data. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  const left = a as { readonly [key: string]: unknown };
  const right = b as { readonly [key: string]: unknown };
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (!jsonEqual(leftKeys, rightKeys)) return false;
  return leftKeys.every((key) => jsonEqual(left[key], right[key]));
}

function projectionEqual(
  a: ProjectedRefusalResult | null,
  b: ProjectedRefusalResult | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.isError === b.isError &&
    a.text === b.text &&
    a.hasMeta === b.hasMeta &&
    jsonEqual([...a.identityFields], [...b.identityFields]) &&
    jsonEqual(a.structuredContent, b.structuredContent)
  );
}

/**
 * Grade a refusal projector against the catalog.
 *
 * `project` MUST be a pure computation of `(refusal) → result | null`,
 * where `null` means "this code has no render envelope". The kit
 * deliberately does NOT import a concrete projector — adopters pass
 * their own. A conformant projector produces an empty `failed` array.
 *
 * `project` is invoked exactly once per case, in
 * {@link refusalEnvelopeCases} order. It MUST NOT throw: throwing to
 * refuse is precisely the non-conformance this catalog exists to
 * catch, so a throw is recorded as a graded FAILURE on that case
 * rather than escaping the run.
 */
export function runRefusalEnvelopeConformance(
  project: (
    refusal: PreGenerationRefusalInput,
  ) => ProjectedRefusalResult | null,
): RefusalEnvelopeConformanceResult {
  const passed: string[] = [];
  const failed: RefusalEnvelopeMismatch[] = [];
  for (const testCase of refusalEnvelopeCases) {
    let actual: ProjectedRefusalResult | null | string;
    try {
      actual = project(testCase.refusal);
    } catch (err) {
      failed.push({
        name: testCase.name,
        expected: testCase.expect,
        actual: `threw instead of returning a refusal envelope: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      continue;
    }
    if (projectionEqual(actual, testCase.expect)) {
      passed.push(testCase.name);
    } else {
      failed.push({ name: testCase.name, expected: testCase.expect, actual });
    }
  }
  return { passed, failed };
}
