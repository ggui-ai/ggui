/**
 * Schema-conformance catalog meta-tests.
 *
 * Two jobs:
 *   1. Pin the published catalog shape (count, accept/reject split,
 *      load-bearing `SchemaConformanceCase` fields).
 *   2. Bind the catalog to the reference validator —
 *      `@ggui-ai/protocol`'s `clientCapabilitiesSpecSchema` — and
 *      assert it grades every case correctly. This is the kit's own
 *      drift-catch: if the live wire schema diverges from the §7.7.2
 *      obligations the catalog freezes, this test fails.
 *
 * The catalog itself (`./index.ts`) never imports `@ggui-ai/protocol`
 * — only this meta-test does. Adopters drive `runSchemaConformance`
 * with their own parser; see the kit README.
 */
import { clientCapabilitiesSpecSchema } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';

import {
  gadgetWireSchemaCases,
  runSchemaConformance,
  type SchemaConformanceCase,
} from './index.js';

describe('gadget-wire schema-conformance catalog', () => {
  it('ships 12 cases — 5 accept, 7 reject', () => {
    expect(gadgetWireSchemaCases.length).toBe(12);
    const accepts = gadgetWireSchemaCases.filter((c) => c.expect === 'accept');
    const rejects = gadgetWireSchemaCases.filter((c) => c.expect === 'reject');
    expect(accepts.length).toBe(5);
    expect(rejects.length).toBe(7);
  });

  it('every case has the load-bearing SchemaConformanceCase fields', () => {
    const names = new Set<string>();
    for (const testCase of gadgetWireSchemaCases) {
      expect(typeof testCase.name).toBe('string');
      expect(testCase.name.length).toBeGreaterThan(0);
      expect(names.has(testCase.name)).toBe(false); // unique
      names.add(testCase.name);
      expect(typeof testCase.description).toBe('string');
      expect(testCase.description.length).toBeGreaterThan(0);
      expect(testCase.expect === 'accept' || testCase.expect === 'reject').toBe(
        true,
      );
      expect('clientCapabilities' in testCase).toBe(true);
      // Reject cases MUST carry a normative reason; accepts MUST NOT.
      if (testCase.expect === 'reject') {
        expect(typeof testCase.rejectReason).toBe('string');
        expect((testCase.rejectReason ?? '').length).toBeGreaterThan(0);
      } else {
        expect(testCase.rejectReason).toBeUndefined();
      }
    }
  });

  it('accept cases sort before reject cases; deterministic order', () => {
    const firstReject = gadgetWireSchemaCases.findIndex(
      (c) => c.expect === 'reject',
    );
    const tail = gadgetWireSchemaCases.slice(firstReject);
    expect(tail.every((c) => c.expect === 'reject')).toBe(true);
  });

  it('the reference clientCapabilitiesSpecSchema grades every case correctly', () => {
    const result = runSchemaConformance(
      (clientCapabilities) =>
        clientCapabilitiesSpecSchema.safeParse(clientCapabilities).success,
    );
    // A conformant validator produces zero mismatches. A non-empty
    // `failed` array means the live wire schema drifted from a §7.7.2
    // obligation the catalog freezes — fix the schema or the catalog.
    expect(result.failed).toEqual([]);
    expect(result.passed.length).toBe(gadgetWireSchemaCases.length);
  });

  it('runSchemaConformance reports a deliberately wrong validator as failed', () => {
    // An always-accept validator MUST fail every reject case — proves
    // the runner actually grades, not just rubber-stamps.
    const result = runSchemaConformance(() => true);
    const rejectCases = gadgetWireSchemaCases.filter(
      (c: SchemaConformanceCase) => c.expect === 'reject',
    );
    expect(result.failed.length).toBe(rejectCases.length);
    expect(result.failed.every((f) => f.expected === 'reject')).toBe(true);
    expect(result.failed.every((f) => f.actual === 'accept')).toBe(true);
  });
});
