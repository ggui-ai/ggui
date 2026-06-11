/**
 * Drift-catch: the SHIPPING gadget gate trio ↔ the
 * `@ggui-ai/protocol-conformance` registration-conformance catalog.
 *
 * The kit's own meta-test (`registration-conformance.test.ts` in the
 * kit) grades a faithful in-test gate built from SPEC §7.7.2 / §7.7.3
 * / §7.9 — that proves the catalog itself is coherent, while keeping
 * the vendor-neutral kit free of any dependency on a server
 * implementation.
 *
 * THIS test closes the other half: it grades the real gates the render
 * seam actually calls (`render.ts`, in its composition order —
 * `assertNoDuplicateGadgetHooks` → `assertGadgetsRegistered` →
 * `assertPublicEnvSatisfied`) against the same catalog. The dependency
 * edge points the right way (implementation → kit, a devDependency of
 * this package). If a shipping gate ever drifts from the obligations
 * the catalog freezes — a reject slug renamed off the SPEC §7.9 wire
 * literal, the §7.7.3 registry-before-env precedence flipped, an
 * accept path narrowed (e.g. the env gate validating
 * registered-but-undeclared wrappers) — the failure surfaces HERE, in
 * the implementation package, not in the kit.
 *
 * Note the catalog pins only the SPEC-mandated precedence
 * (registry-gate-before-env-gate, §7.7.3); its duplicate-hook cases
 * are authored to be otherwise fully resolvable, so the duplicate
 * check's first position in the composition below is the shipping
 * order, not a catalog requirement.
 */
import type { DataContract, GadgetDescriptor } from '@ggui-ai/protocol';
import {
  gadgetRegistrationCases,
  runRegistrationConformance,
  type GateOutcome,
} from '@ggui-ai/protocol-conformance/registration-conformance';
import { describe, expect, it } from 'vitest';

import {
  assertGadgetsRegistered,
  GadgetNotRegisteredError,
  GadgetPackageMismatchError,
} from './assert-gadgets.js';
import {
  assertNoDuplicateGadgetHooks,
  DuplicateGadgetHookError,
} from './assert-no-duplicate-gadget-hooks.js';
import {
  assertPublicEnvSatisfied,
  GadgetPublicEnvMissingError,
} from './assert-public-env.js';

/**
 * Adapt the throwing shipping gates to the kit's `GateOutcome`-returning
 * gate signature: a clean return through all three is `accept`; the
 * four classified rejection errors map to their `code`. Any other
 * throw is itself a non-conformant gate — rethrow so it surfaces loud
 * rather than being silently scored as a miss.
 */
function shippingGate(
  contract: DataContract,
  appGadgets: readonly GadgetDescriptor[],
  appPublicEnv: Readonly<Record<string, string>>,
): GateOutcome {
  try {
    assertNoDuplicateGadgetHooks(contract);
    assertGadgetsRegistered(contract, appGadgets);
    assertPublicEnvSatisfied(contract, appGadgets, appPublicEnv);
    return { outcome: 'accept' };
  } catch (err) {
    if (
      err instanceof DuplicateGadgetHookError ||
      err instanceof GadgetNotRegisteredError ||
      err instanceof GadgetPackageMismatchError ||
      err instanceof GadgetPublicEnvMissingError
    ) {
      return { outcome: 'reject', code: err.code };
    }
    throw err;
  }
}

describe('the shipping gadget gate trio conforms to the registration-conformance catalog', () => {
  it('grades every catalog case exactly as the SPEC requires', () => {
    const result = runRegistrationConformance(shippingGate);
    expect(
      result.failed,
      `the shipping gadget gates drifted from the registration-conformance catalog:\n${result.failed
        .map(
          (f) =>
            `  - ${f.name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(
              f.actual,
            )}`,
        )
        .join('\n')}`,
    ).toEqual([]);
    // Sanity: the runner actually exercised the full catalog — a gate
    // that graded zero cases would also report zero failures.
    expect(gadgetRegistrationCases.length).toBeGreaterThan(0);
    expect(result.passed.length).toBe(gadgetRegistrationCases.length);
  });
});
