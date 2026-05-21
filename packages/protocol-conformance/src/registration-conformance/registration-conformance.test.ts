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
 * The shipping gate — `assertGadgetsRegistered` — lives in
 * `@ggui-ai/mcp-server-handlers`, a server implementation. A
 * vendor-neutral conformance kit MUST NOT depend on a specific
 * implementation: the dependency direction is implementation → kit,
 * never the reverse. So this meta-test verifies the catalog against a
 * ~20-line gate built here from SPEC §7.7.2, using only
 * `@ggui-ai/protocol` primitives. That proves the seven cases are
 * satisfiable by a spec-correct gate (catches a mis-authored `expect`).
 *
 * The drift-catch against the SHIPPING gate belongs implementation-side
 * — a test in `@ggui-ai/mcp-server-handlers` that grades its real
 * `assertGadgetsRegistered` via `runRegistrationConformance`. That keeps
 * the dependency edge pointing the right way.
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
 * A faithful minimal implementation of the SPEC §7.7.2 registration
 * gate — independent of `@ggui-ai/mcp-server-handlers`. Walks every
 * `(package, export)` the contract references; classifies a miss as
 * `gadget_not_registered` (export name unknown) or
 * `gadget_package_mismatch` (name registered, wrong package), throwing
 * the most-fundamental category first.
 */
function referenceGate(
  contract: DataContract,
  appGadgets: readonly GadgetDescriptor[],
): GateOutcome {
  const declared = listContractGadgets(contract);
  if (declared.length === 0) return { outcome: 'accept' };

  const registeredPairs = new Set<string>();
  const packagesByExportName = new Map<string, Set<string>>();
  for (const descriptor of appGadgets) {
    for (const exp of descriptor.exports) {
      const name = gadgetExportName(exp);
      registeredPairs.add(gadgetIdentityKey({ name, package: descriptor.package }));
      const packages = packagesByExportName.get(name) ?? new Set<string>();
      packages.add(descriptor.package);
      packagesByExportName.set(name, packages);
    }
  }

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

  // Most-fundamental category first — `gadget_not_registered` outranks.
  if (notRegistered) return { outcome: 'reject', code: 'gadget_not_registered' };
  if (packageMismatch) {
    return { outcome: 'reject', code: 'gadget_package_mismatch' };
  }
  return { outcome: 'accept' };
}

describe('gadget registration-conformance catalog', () => {
  it('ships 7 cases — 4 reject, 3 accept', () => {
    expect(gadgetRegistrationCases.length).toBe(7);
    const rejects = gadgetRegistrationCases.filter(
      (c) => c.expect.outcome === 'reject',
    );
    const accepts = gadgetRegistrationCases.filter(
      (c) => c.expect.outcome === 'accept',
    );
    expect(rejects.length).toBe(4);
    expect(accepts.length).toBe(3);
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
    // A faithful §7.7.2 gate produces zero mismatches. A non-empty
    // `failed` array means a case carries a mis-authored `expect`.
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

  it('an inverting gate fails every case (runner catches every mismatch kind)', () => {
    // Invert the spec-correct verdict on every case — accept↔reject —
    // so the runner must flag all seven, proving it grades both the
    // accept→reject and reject→accept directions, not just one.
    const result = runRegistrationConformance((contract, appGadgets) => {
      const correct = referenceGate(contract, appGadgets);
      return correct.outcome === 'accept'
        ? { outcome: 'reject', code: 'gadget_not_registered' }
        : { outcome: 'accept' };
    });
    expect(result.failed.length).toBe(gadgetRegistrationCases.length);
    expect(result.passed).toEqual([]);
  });
});
