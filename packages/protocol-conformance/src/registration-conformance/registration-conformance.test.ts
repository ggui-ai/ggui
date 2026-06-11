/**
 * Registration-conformance catalog meta-tests.
 *
 * Two jobs:
 *   1. Pin the published catalog shape (count, accept/reject split,
 *      load-bearing `RegistrationConformanceCase` fields).
 *   2. Prove the catalog is internally coherent + the runner grades
 *      honestly: a faithful, spec-correct gate passes every case; a
 *      deliberately wrong gate fails the cases it should.
 *
 * ## Why a kit-local reference gate, not the shipping one
 *
 * The shipping gate trio — `assertNoDuplicateGadgetHooks`,
 * `assertGadgetsRegistered`, `assertPublicEnvSatisfied` — lives in
 * `@ggui-ai/mcp-server-handlers`, a server implementation. A
 * vendor-neutral conformance kit MUST NOT depend on a specific
 * implementation: the dependency direction is implementation → kit,
 * never the reverse. So this meta-test verifies the catalog against a
 * compact gate built here from SPEC §7.7.2 / §7.7.3 / §7.9, using only
 * `@ggui-ai/protocol` primitives. That proves every case is
 * satisfiable by a spec-correct gate (catches a mis-authored `expect`).
 *
 * The drift-catch against the SHIPPING gates belongs implementation-side
 * — `assert-gadgets.conformance.test.ts` in
 * `@ggui-ai/mcp-server-handlers` grades the real trio via
 * `runRegistrationConformance`. That keeps the dependency edge pointing
 * the right way.
 */
import {
  gadgetExportName,
  gadgetIdentityKey,
  listContractGadgets,
  type DataContract,
  type GadgetDescriptor,
} from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';

import {
  gadgetRegistrationCases,
  runRegistrationConformance,
  type GateOutcome,
} from './index.js';

/**
 * A faithful minimal implementation of the gadget gate stack —
 * independent of `@ggui-ai/mcp-server-handlers`.
 *
 *   1. Registry membership (§7.7.2): walks every `(package, export)`
 *      the contract references; classifies a miss as
 *      `gadget_not_registered` (export name unknown) or
 *      `gadget_package_mismatch` (name registered, wrong package),
 *      rejecting the most-fundamental category first. §7.7.3 pins this
 *      gate FIRST relative to the env gate, so it runs before checks 2
 *      and 3.
 *   2. Public-env satisfaction (§7.7.3): every DECLARED wrapper's
 *      `requires[]` key must be present in `appPublicEnv` —
 *      `gadget_public_env_missing` otherwise. Registered-but-undeclared
 *      wrappers are out of scope.
 *   3. Duplicate export names (§7.9): the same export name under two
 *      packages rejects `duplicate_gadget_hook`. The catalog authors
 *      its duplicate cases so every pair otherwise resolves cleanly —
 *      this check's order relative to 1–2 is deliberately unpinned
 *      (the shipping implementation runs it first; this reference runs
 *      it last; both conform).
 */
function referenceGate(
  contract: DataContract,
  appGadgets: readonly GadgetDescriptor[],
  appPublicEnv: Readonly<Record<string, string>>,
): GateOutcome {
  const declared = listContractGadgets(contract);
  if (declared.length === 0) return { outcome: 'accept' };

  const registeredPairs = new Set<string>();
  const packagesByExportName = new Map<string, Set<string>>();
  const descriptorByPair = new Map<string, GadgetDescriptor>();
  for (const descriptor of appGadgets) {
    for (const exp of descriptor.exports) {
      const name = gadgetExportName(exp);
      const pairKey = gadgetIdentityKey({ name, package: descriptor.package });
      registeredPairs.add(pairKey);
      descriptorByPair.set(pairKey, descriptor);
      const packages = packagesByExportName.get(name) ?? new Set<string>();
      packages.add(descriptor.package);
      packagesByExportName.set(name, packages);
    }
  }

  // 1 — §7.7.2 registry membership, most-fundamental category first.
  let notRegistered = false;
  let packageMismatch = false;
  for (const use of declared) {
    if (registeredPairs.has(gadgetIdentityKey(use))) continue;
    const packages = packagesByExportName.get(use.name);
    if (packages === undefined || packages.size === 0) {
      notRegistered = true;
    } else {
      packageMismatch = true;
    }
  }
  if (notRegistered) return { outcome: 'reject', code: 'gadget_not_registered' };
  if (packageMismatch) {
    return { outcome: 'reject', code: 'gadget_package_mismatch' };
  }

  // 2 — §7.7.3 public-env satisfaction, declared wrappers only.
  for (const use of declared) {
    const descriptor = descriptorByPair.get(gadgetIdentityKey(use));
    for (const required of descriptor?.requires ?? []) {
      if (!Object.prototype.hasOwnProperty.call(appPublicEnv, required)) {
        return { outcome: 'reject', code: 'gadget_public_env_missing' };
      }
    }
  }

  // 3 — §7.9 duplicate export name across packages.
  const seenNames = new Set<string>();
  for (const use of declared) {
    if (seenNames.has(use.name)) {
      return { outcome: 'reject', code: 'duplicate_gadget_hook' };
    }
    seenNames.add(use.name);
  }

  return { outcome: 'accept' };
}

describe('gadget registration-conformance catalog', () => {
  it('ships 13 cases — 7 reject, 6 accept', () => {
    expect(gadgetRegistrationCases.length).toBe(13);
    const rejects = gadgetRegistrationCases.filter(
      (c) => c.expect.outcome === 'reject',
    );
    const accepts = gadgetRegistrationCases.filter(
      (c) => c.expect.outcome === 'accept',
    );
    expect(rejects.length).toBe(7);
    expect(accepts.length).toBe(6);
  });

  it('covers every SPEC §7.9 gadget-gate reject slug', () => {
    const rejectCodes = new Set(
      gadgetRegistrationCases.flatMap((c) =>
        c.expect.outcome === 'reject' ? [c.expect.code] : [],
      ),
    );
    expect([...rejectCodes].sort()).toEqual([
      'duplicate_gadget_hook',
      'gadget_not_registered',
      'gadget_package_mismatch',
      'gadget_public_env_missing',
    ]);
  });

  it('every case has the load-bearing RegistrationConformanceCase fields', () => {
    const names = new Set<string>();
    for (const testCase of gadgetRegistrationCases) {
      expect(typeof testCase.name).toBe('string');
      expect(testCase.name.length).toBeGreaterThan(0);
      expect(names.has(testCase.name)).toBe(false); // unique
      names.add(testCase.name);
      expect(typeof testCase.description).toBe('string');
      expect(testCase.description.length).toBeGreaterThan(0);
      expect(typeof testCase.contract).toBe('object');
      expect(Array.isArray(testCase.appGadgets)).toBe(true);
      // appPublicEnv is required on every case: a flat string map,
      // `{}` when the app has no public env configured.
      expect(typeof testCase.appPublicEnv).toBe('object');
      expect(Array.isArray(testCase.appPublicEnv)).toBe(false);
      expect(
        Object.values(testCase.appPublicEnv).every(
          (v) => typeof v === 'string',
        ),
      ).toBe(true);
      // Reject cases MUST carry a code; accepts MUST NOT.
      if (testCase.expect.outcome === 'reject') {
        expect(typeof testCase.expect.code).toBe('string');
        expect(testCase.expect.code.length).toBeGreaterThan(0);
      } else {
        expect(testCase.expect.outcome).toBe('accept');
      }
    }
  });

  it('reject cases sort before accept cases (deterministic order)', () => {
    const firstAccept = gadgetRegistrationCases.findIndex(
      (c) => c.expect.outcome === 'accept',
    );
    const tail = gadgetRegistrationCases.slice(firstAccept);
    expect(tail.every((c) => c.expect.outcome === 'accept')).toBe(true);
  });

  it('a spec-correct gate passes every case (catalog is coherent)', () => {
    const result = runRegistrationConformance(referenceGate);
    // A faithful gate produces zero mismatches. A non-empty `failed`
    // array means a case carries a mis-authored `expect`.
    expect(result.failed).toEqual([]);
    expect(result.passed.length).toBe(gadgetRegistrationCases.length);
  });

  it('an always-accept gate fails every reject case (runner grades)', () => {
    const result = runRegistrationConformance(() => ({ outcome: 'accept' }));
    const rejectCount = gadgetRegistrationCases.filter(
      (c) => c.expect.outcome === 'reject',
    ).length;
    expect(result.failed.length).toBe(rejectCount);
    expect(result.failed.every((f) => f.expected.outcome === 'reject')).toBe(
      true,
    );
  });

  it('an env-blind gate fails exactly the public-env reject case', () => {
    // Runs checks 1 and 3 but never reads `appPublicEnv` — the drift
    // the new catalog slice exists to catch. It must fail
    // gate-public-env-missing (graded accept, expected reject) and the
    // priority case still passes (registry miss outranks the env miss
    // it cannot see), so the failure set is exactly one case.
    const result = runRegistrationConformance((contract, appGadgets) =>
      referenceGate(contract, appGadgets, {
        GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'env-blind-stub',
      }),
    );
    expect(result.failed.map((f) => f.name)).toEqual([
      'gate-public-env-missing',
    ]);
  });

  it('an inverting gate fails every case (runner catches every mismatch kind)', () => {
    // Invert the spec-correct verdict on every case — accept↔reject —
    // so the runner must flag all thirteen, proving it grades both the
    // accept→reject and reject→accept directions, not just one.
    const result = runRegistrationConformance(
      (contract, appGadgets, appPublicEnv) => {
        const correct = referenceGate(contract, appGadgets, appPublicEnv);
        return correct.outcome === 'accept'
          ? { outcome: 'reject', code: 'gadget_not_registered' }
          : { outcome: 'accept' };
      },
    );
    expect(result.failed.length).toBe(gadgetRegistrationCases.length);
    expect(result.passed).toEqual([]);
  });
});
