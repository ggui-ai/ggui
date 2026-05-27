/**
 * Registration-conformance catalog — accept / reject cases for the
 * gadget push-time registry gate (SPEC §7.7.2 — `assertGadgetsRegistered`).
 *
 * ## Why this is a pure-function catalog, not a behavioral fixture
 *
 * The push-time gadget gate answers a pure question: given a contract
 * and the app's registered `App.gadgets` catalog, does every
 * `(package, export)` the contract references resolve — and if not,
 * which precise reject code applies? There is no render, no
 * transport, no wire frame in that question — it is a deterministic
 * classification, exactly like the `clientCapabilities` schema check
 * in `../schema-conformance`.
 *
 * Modeling it as a WebSocket behavioral fixture would mean inventing a
 * wire frame the real protocol never emits (the gate runs at MCP-push
 * time, before any live channel exists) — the dishonest modeling the
 * kit's Path-A / Path-B partition exists to forbid. So the gate gets
 * the same treatment as the wire schema: a catalog of cases graded
 * against a caller-supplied gate function.
 *
 * ## Polyglot, decoupled
 *
 * Each case ships as raw JSON under `./cases/`. {@link runRegistrationConformance}
 * takes the gate as a callback — the kit never imports a concrete gate
 * implementation here, so adopters drive their OWN gate. The reference
 * binding (`./registration-conformance.test.ts`) wraps
 * `@ggui-ai/mcp-server-handlers`'s `assertGadgetsRegistered`.
 *
 * The `DataContract` / `GadgetDescriptor` types ARE imported (type-only)
 * from `@ggui-ai/protocol` — unlike the behavioral fixture vocabulary
 * in `../types.ts`, these are the gate's actual input contract, not a
 * frozen authored union; the runner's `gate` signature MUST match the
 * real function for the reference binding to be cast-free.
 */
import type { DataContract, GadgetDescriptor } from '@ggui-ai/protocol';

import gateExportNotRegistered from './cases/gate-export-not-registered.json' with { type: 'json' };
import gateNoGadgetsAccept from './cases/gate-no-gadgets-accept.json' with { type: 'json' };
import gatePackageMismatch from './cases/gate-package-mismatch.json' with { type: 'json' };
import gatePriorityNotRegisteredOutranksMismatch from './cases/gate-priority-not-registered-outranks-mismatch.json' with { type: 'json' };
import gateRegisteredResolvesAccept from './cases/gate-registered-resolves-accept.json' with { type: 'json' };
import gateStdlibHookAccept from './cases/gate-stdlib-hook-accept.json' with { type: 'json' };
import gateTypoClassifiesAsNotRegistered from './cases/gate-typo-classifies-as-not-registered.json' with { type: 'json' };

/**
 * The precise reject codes the gadget gate classifies a miss into.
 * Mirrors `GadgetGateErrorCode`'s registry-gate arms in
 * `@ggui-ai/mcp-server-handlers`. Extensibly-closed `(string & {})`
 * tail so a later protocol revision's code rides through without a kit
 * bump — same discipline as `ContractErrorCode` in `../types.ts`.
 */
export type GadgetGateRejectCode =
  | 'gadget_not_registered'
  | 'gadget_package_mismatch'
  | (string & {});

/**
 * The outcome of running the gate against one `(contract, appGadgets)`
 * pair. A conformant gate either accepts the push or rejects it with
 * one classified code.
 */
export type GateOutcome =
  | { readonly outcome: 'accept' }
  | { readonly outcome: 'reject'; readonly code: GadgetGateRejectCode };

/**
 * One registration-conformance case. Authored as JSON under `./cases/`,
 * consumed via {@link gadgetRegistrationCases}, graded by
 * {@link runRegistrationConformance}.
 *
 * The shape IS the public API — additive changes only, mirroring the
 * `TestCase` / `SchemaConformanceCase` discipline.
 */
export interface RegistrationConformanceCase {
  /** Unique case name. MUST match the JSON filename without `.json`. */
  readonly name: string;
  /** What gate obligation this case proves. */
  readonly description: string;
  /** The contract whose `clientCapabilities.gadgets` the gate walks. */
  readonly contract: DataContract;
  /** The app's registered gadget catalog the gate resolves against. */
  readonly appGadgets: readonly GadgetDescriptor[];
  /** The outcome a spec-conformant gate MUST produce. */
  readonly expect: GateOutcome;
}

/**
 * Every gadget registration-gate case the kit ships, in deterministic
 * order — rejects first (grouped by the obligation they probe), then
 * accepts.
 */
export const gadgetRegistrationCases: readonly RegistrationConformanceCase[] = [
  gateExportNotRegistered as RegistrationConformanceCase,
  gatePackageMismatch as RegistrationConformanceCase,
  gatePriorityNotRegisteredOutranksMismatch as RegistrationConformanceCase,
  gateTypoClassifiesAsNotRegistered as RegistrationConformanceCase,
  gateStdlibHookAccept as RegistrationConformanceCase,
  gateRegisteredResolvesAccept as RegistrationConformanceCase,
  gateNoGadgetsAccept as RegistrationConformanceCase,
];

/** One case the gate under test graded wrong. */
export interface RegistrationConformanceMismatch {
  readonly name: string;
  /** The outcome the catalog says a conformant gate MUST produce. */
  readonly expected: GateOutcome;
  /** The outcome the gate under test actually produced. */
  readonly actual: GateOutcome;
}

/** Outcome of grading a gate against the catalog. */
export interface RegistrationConformanceResult {
  /** Names of cases the gate graded correctly. */
  readonly passed: readonly string[];
  /** Cases the gate graded wrong — empty iff fully conformant. */
  readonly failed: readonly RegistrationConformanceMismatch[];
}

function gateOutcomeEquals(a: GateOutcome, b: GateOutcome): boolean {
  if (a.outcome !== b.outcome) return false;
  if (a.outcome === 'reject' && b.outcome === 'reject') {
    return a.code === b.code;
  }
  return true;
}

/**
 * Grade a gadget registration gate against the catalog.
 *
 * `gate` MUST be a pure classification of `(contract, appGadgets)` —
 * return `{outcome:'accept'}` when every referenced `(package, export)`
 * resolves, or `{outcome:'reject', code}` with the precise reject code
 * otherwise. The kit deliberately does NOT import a concrete gate —
 * adopters pass their own (the reference binding wraps
 * `assertGadgetsRegistered`; see `./registration-conformance.test.ts`).
 * A conformant gate produces an empty `failed` array.
 *
 * `gate` is invoked exactly once per case, in {@link gadgetRegistrationCases}
 * order; it MUST be pure and MUST NOT throw (a throwing gate is itself
 * non-conformant — wrap it so a classified rejection becomes a
 * returned `GateOutcome`).
 */
export function runRegistrationConformance(
  gate: (
    contract: DataContract,
    appGadgets: readonly GadgetDescriptor[],
  ) => GateOutcome,
): RegistrationConformanceResult {
  const passed: string[] = [];
  const failed: RegistrationConformanceMismatch[] = [];
  for (const testCase of gadgetRegistrationCases) {
    const actual = gate(testCase.contract, testCase.appGadgets);
    if (gateOutcomeEquals(actual, testCase.expect)) {
      passed.push(testCase.name);
    } else {
      failed.push({
        name: testCase.name,
        expected: testCase.expect,
        actual,
      });
    }
  }
  return { passed, failed };
}
