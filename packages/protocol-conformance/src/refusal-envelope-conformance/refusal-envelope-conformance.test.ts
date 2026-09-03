/**
 * Refusal-envelope conformance catalog meta-tests (ggui#786, ruling 5a).
 *
 * Two jobs, the same two the resolution catalog's meta-test has:
 *   1. Pin the published catalog shape (count, load-bearing
 *      `RefusalEnvelopeConformanceCase` fields).
 *   2. Prove the catalog is internally coherent + the runner grades
 *      honestly: a faithful, spec-correct projector passes every case;
 *      a deliberately wrong projector fails the cases it should.
 *
 * ## What is graded
 *
 * The PROJECTOR: given a pre-generation refusal a deployment's gate
 * returned, what tool result must a conformant server emit? SPEC §7.1's
 * refused arm answers it — an `isError: true` TOOL RESULT (never a
 * throw), `content[0].text` leading with the code, `structuredContent`
 * carrying `outcome: 'refused'` + `refusal` and NOTHING else, no `_meta`.
 * A code that is not on the `render-gate` surface is not projectable
 * here at all; the catalog carries one such case so "the namespace is
 * per-surface" has an observable violation rather than being prose.
 *
 * ## Why a kit-local reference projector, not the shipping one
 *
 * The shipping projector lives in `@ggui-ai/mcp-server-handlers`, a
 * server implementation, and a vendor-neutral conformance kit MUST NOT
 * depend on a specific implementation. So the reference below is built
 * here from SPEC §7.1 plus `@ggui-ai/protocol` PRIMITIVES only — the
 * registry (for the render-gate surface question) and the refusal
 * schema. That proves the cases are satisfiable by a spec-correct
 * projector. The drift-catch against the SHIPPING projector belongs
 * implementation-side: a `render-refusal-projection.conformance.test.ts`
 * in `@ggui-ai/mcp-server-handlers` that drives the real handler's
 * projection through `runRefusalEnvelopeConformance`. Without that
 * second half this catalog grades only its own reference — a silent
 * gate per docs/principles/no-silent-block.md.
 *
 * ## Not a WS fixture
 *
 * These cases are NOT registered in `fixturesByContract`. A refusal is a
 * deterministic projection, not a WebSocket-observable behaviour, so
 * registering it there would be a permanent skip on every run — exactly
 * the false gate the kit's exact skip-set pinning exists to prevent.
 * `runConformance()` / the CLI / the reporter are untouched; the entry
 * point is the programmatic runner below.
 */
import { PRE_GENERATION_REFUSAL_CODES, RENDER_GATE_REFUSAL_CODES } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';

import {
  refusalEnvelopeCases,
  runRefusalEnvelopeConformance,
  type PreGenerationRefusalInput,
  type ProjectedRefusalResult,
} from './index.js';

/**
 * A faithful minimal implementation of SPEC §7.1's refused arm,
 * independent of `@ggui-ai/mcp-server-handlers`.
 *
 * Returns `null` for a code that is not on the render-gate surface —
 * such a code has no render envelope to project, which is what the
 * per-surface namespace rule means operationally.
 */
function referenceProject(
  refusal: PreGenerationRefusalInput,
): ProjectedRefusalResult | null {
  const renderGate: readonly string[] = RENDER_GATE_REFUSAL_CODES;
  if (!renderGate.includes(refusal.code)) return null;
  return {
    isError: true,
    // Courtesy line — the code LEADS but is not the mechanism.
    text: `${refusal.code}: ${refusal.message} ${refusal.fix}`,
    structuredContent: { outcome: 'refused', refusal },
    hasMeta: false,
    // Nothing was parsed, no handshake read, nothing committed.
    identityFields: [],
  };
}

describe('refusal-envelope conformance catalog', () => {
  it('ships 6 cases', () => {
    expect(refusalEnvelopeCases.length).toBe(6);
  });

  it('every case has the load-bearing RefusalEnvelopeConformanceCase fields', () => {
    const names = new Set<string>();
    for (const testCase of refusalEnvelopeCases) {
      expect(typeof testCase.name).toBe('string');
      expect(testCase.name.length).toBeGreaterThan(0);
      expect(names.has(testCase.name)).toBe(false); // unique
      names.add(testCase.name);
      expect(typeof testCase.description).toBe('string');
      expect(testCase.description.length).toBeGreaterThan(0);
      expect(typeof testCase.refusal).toBe('object');
      // Every refusal carries a code that IS in the registry — the
      // catalog never invents one. A non-projectable case is an
      // owner-api / provisioning-api code, not an unregistered one.
      expect(Object.keys(PRE_GENERATION_REFUSAL_CODES)).toContain(
        testCase.refusal.code,
      );
    }
  });

  it('covers every retry class plus the non-projectable surface', () => {
    const retries = new Set(refusalEnvelopeCases.map((c) => c.refusal.retry));
    expect(retries).toContain('after-fix');
    expect(retries).toContain('next-period');
    expect(retries).toContain('never');
    // One case is deliberately not projectable on the render gate.
    expect(refusalEnvelopeCases.filter((c) => c.expect === null).length).toBe(1);
  });

  it('a spec-correct projector passes every case (catalog is coherent)', () => {
    const result = runRefusalEnvelopeConformance(referenceProject);
    // A faithful §7.1 refused-arm projector produces zero mismatches. A
    // non-empty `failed` array means a case carries a mis-authored
    // `expect`, not that the projector is wrong.
    expect(result.failed).toEqual([]);
    expect(result.passed.length).toBe(refusalEnvelopeCases.length);
  });

  it('a projector that leaks sessionId fails every projectable case (runner grades)', () => {
    // THE regression this catalog exists to guard: a refusal commits
    // nothing, so an identity field on the envelope means the
    // projection leaked committed state. Computed from the catalog
    // rather than hard-coded, so adding a case cannot go ungraded.
    const leaky = (
      refusal: PreGenerationRefusalInput,
    ): ProjectedRefusalResult | null => {
      const clean = referenceProject(refusal);
      if (clean === null) return null;
      return { ...clean, identityFields: ['sessionId'] };
    };
    const result = runRefusalEnvelopeConformance(leaky);
    const projectable = refusalEnvelopeCases.filter((c) => c.expect !== null);
    expect(result.failed.length).toBe(projectable.length);
    expect(result.failed.map((f) => f.name).sort()).toEqual(
      projectable.map((c) => c.name).sort(),
    );
  });

  it('a projector that THROWS instead of returning is non-conformant (runner grades)', () => {
    // "Returning a refusal is the ONLY way to refuse; a gate that throws
    // is a conformance failure." The runner must surface that as a
    // graded failure, never as an unhandled exception escaping the run.
    const throwing = (): ProjectedRefusalResult | null => {
      throw new Error('RenderBillingError: hard cap exceeded');
    };
    const result = runRefusalEnvelopeConformance(throwing);
    expect(result.passed).toEqual([]);
    expect(result.failed.length).toBe(refusalEnvelopeCases.length);
  });

  it('a projector that emits _meta on a refusal fails (no mount affordance)', () => {
    const withMeta = (
      refusal: PreGenerationRefusalInput,
    ): ProjectedRefusalResult | null => {
      const clean = referenceProject(refusal);
      if (clean === null) return null;
      return { ...clean, hasMeta: true };
    };
    const result = runRefusalEnvelopeConformance(withMeta);
    const projectable = refusalEnvelopeCases.filter((c) => c.expect !== null);
    expect(result.failed.length).toBe(projectable.length);
  });

  it('a projector that projects an owner-api code fails that case', () => {
    // The inverse of the leak: a code whose `surfaces` exclude
    // `render-gate` has no render envelope. Projecting one anyway is the
    // drift the per-surface namespace rule forbids.
    const overEager = (
      refusal: PreGenerationRefusalInput,
    ): ProjectedRefusalResult => ({
      isError: true,
      text: `${refusal.code}: ${refusal.message} ${refusal.fix}`,
      structuredContent: { outcome: 'refused', refusal },
      hasMeta: false,
      identityFields: [],
    });
    const result = runRefusalEnvelopeConformance(overEager);
    const nonProjectable = refusalEnvelopeCases.filter((c) => c.expect === null);
    expect(result.failed.map((f) => f.name).sort()).toEqual(
      nonProjectable.map((c) => c.name).sort(),
    );
  });
});
