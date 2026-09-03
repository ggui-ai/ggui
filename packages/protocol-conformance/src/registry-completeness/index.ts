/**
 * Registry-completeness catalog — the structural obligations a
 * deployment's refusal-code registry MUST satisfy (ggui#786, ruling
 * 5b).
 *
 * ## Why this is a pure-function catalog, graded differently
 *
 * Unlike every other catalog here, this one grades DATA rather than a
 * function: the closed set of refusal codes a deployment declares. The
 * caller passes the registry; each pin inspects every row and reports
 * the rows that violate it.
 *
 * ## The four PORTABLE pins, and the two that are deliberately absent
 *
 * Ruling 5b names six checks. Four are portable — a third-party adopter
 * with their own registry can run them, and they are the four below.
 *
 * Two read repo SOURCE and therefore cannot ship as conformance: the
 * docstring rule ("an agent MUST NOT auto-retry an after-fix refusal
 * whose fixBy is not caller") and the grep for code literals minted
 * outside the registry file. This package publishes only `dist` +
 * `README.md`, so a source walk could never run for an adopter, and the
 * files that rule names live outside this tree entirely. Both live in
 * `@ggui-ai/protocol`'s own suite, where the invariant is owned and the
 * paths are stable. The omission is DECLARED here rather than hidden.
 *
 * ## Why the `fixBy` pin is one-directional
 *
 * The pin below asserts only that an `after-fix` row NAMES who acts. It
 * does not assert `fixBy` is absent elsewhere, because that is a naming
 * discipline rather than a reader-observable obligation: a reader
 * branches on `retry`, and a `fixBy` beside a `never` misleads a human
 * without changing what any implementation does.
 *
 * ggui's own registry is stricter — `fixBy` is REQUIRED on `after-fix`,
 * PERMITTED on `later` (the operator who restores a transiently
 * unavailable surface) and FORBIDDEN on `next-period` and `never` — and
 * enforces it at the type level in its definer, pinned in
 * `@ggui-ai/protocol`'s own suite. Adopters are welcome to that rule;
 * the kit does not make it a conformance obligation. The one thing that
 * must never happen, and IS graded here, is an `after-fix` row that
 * does not say WHO acts — the one an agent could misread as its own to
 * retry.
 */

/** One registry row, in the kit's own loose vocabulary. */
export interface RefusalRegistryRow {
  /** MUST equal the row's key in the registry. */
  readonly code: string;
  /** MUST be non-empty — the surfaces this state is refused on. */
  readonly surfaces: readonly string[];
  /** MUST be one of the four recognized retry classes. */
  readonly retry: string;
  /** Who acts. REQUIRED when `retry` is `after-fix`. */
  readonly fixBy?: string | undefined;
  /** Where the code is produced. */
  readonly emitter: string;
  /** What state the code names. */
  readonly description: string;
}

/**
 * A registry as the kit reads it: code → row. Decoupled from
 * `@ggui-ai/protocol`'s own types on purpose — an adopter's registry is
 * graded through this view, and a deliberately broken registry must be
 * expressible for the negative cases.
 */
export type RefusalRegistryView = {
  readonly [code: string]: RefusalRegistryRow;
};

/** The four recognized retry classes (ggui#786 rulings v2 + v4). */
const RECOGNIZED_RETRIES: readonly string[] = [
  'after-fix',
  'next-period',
  'later',
  'never',
];

/** One structural pin, applied to every row of a registry. */
export interface RegistryCompletenessPin {
  /** Unique pin name. */
  readonly name: string;
  /** The obligation this pin fixes in place. */
  readonly description: string;
  /**
   * Report why `row` (declared under `code`) violates the pin, or
   * `null` when it satisfies it.
   */
  readonly violation: (code: string, row: RefusalRegistryRow) => string | null;
}

/** Every portable pin the kit ships, in deterministic order. */
export const registryCompletenessPins: readonly RegistryCompletenessPin[] = [
  {
    name: 'surfaces-non-empty',
    description:
      'Every entry lists at least one surface it is emitted on. A row nobody emits anywhere is a name reserved with no obligation behind it, which is the drift a closed registry exists to prevent. One code MAY list several surfaces — one state can surface in more than one place.',
    violation: (_code, row) =>
      row.surfaces.length > 0 ? null : 'surfaces is empty',
  },
  {
    name: 'code-equals-key',
    description:
      "Every entry's `code` equals the key it is declared under. The key is what emitters look a row up by and the code is what reaches the wire; if they disagree, the registry stops being the single namespace it claims to be.",
    violation: (code, row) =>
      row.code === code ? null : `code '${row.code}' does not equal key '${code}'`,
  },
  {
    name: 'after-fix-names-fixby',
    description:
      "Every `after-fix` entry names WHO acts, in `fixBy`. Without it, 'retry after the fix' cannot be told apart from 'retry now' — and an agent may only act on a fix that is its own. A row whose `retry` is not a recognized class ALSO fails this pin: the obligation is undecidable for it, and a pin that silently passes a row it could not evaluate is a false gate.",
    violation: (_code, row) => {
      if (!RECOGNIZED_RETRIES.includes(row.retry)) {
        return `retry '${row.retry}' is not a recognized class, so the fixBy obligation cannot be evaluated`;
      }
      if (row.retry !== 'after-fix') return null;
      return row.fixBy === undefined ? 'after-fix entry carries no fixBy' : null;
    },
  },
  {
    name: 'retry-in-closed-set',
    description:
      "Every entry's `retry` is one of `after-fix`, `next-period`, `later`, `never`. The class is what a reader branches on to decide whether to wait, act, or stop; an unrecognized value leaves it with no defined behaviour.",
    violation: (_code, row) =>
      RECOGNIZED_RETRIES.includes(row.retry)
        ? null
        : `retry '${row.retry}' is outside the closed set`,
  },
];

/** One pin a registry failed, with every offending row named. */
export interface RegistryCompletenessMismatch {
  readonly name: string;
  readonly description: string;
  /** One entry per violating row: `<code>: <why>`. */
  readonly violations: readonly string[];
}

/** Outcome of grading a registry against the pins. */
export interface RegistryCompletenessResult {
  /** Names of pins the registry satisfies. */
  readonly passed: readonly string[];
  /** Pins the registry violates — empty iff fully conformant. */
  readonly failed: readonly RegistryCompletenessMismatch[];
}

/**
 * Grade a refusal registry against {@link registryCompletenessPins}.
 *
 * Every pin is applied to every row, in declaration order; a pin passes
 * only when NO row violates it. A conformant registry produces an empty
 * `failed` array.
 */
export function runRegistryCompletenessConformance(
  registry: RefusalRegistryView,
): RegistryCompletenessResult {
  const entries = Object.entries(registry);
  const passed: string[] = [];
  const failed: RegistryCompletenessMismatch[] = [];
  for (const pin of registryCompletenessPins) {
    const violations: string[] = [];
    for (const [code, row] of entries) {
      const why = pin.violation(code, row);
      if (why !== null) violations.push(`${code}: ${why}`);
    }
    if (violations.length === 0) {
      passed.push(pin.name);
    } else {
      failed.push({ name: pin.name, description: pin.description, violations });
    }
  }
  return { passed, failed };
}
