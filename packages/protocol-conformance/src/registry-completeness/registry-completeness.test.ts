/**
 * Registry-completeness conformance catalog meta-tests (ggui#786,
 * ruling 5b).
 *
 * ## What is graded, and why the binding is kit-side
 *
 * This catalog grades a REGISTRY, not a function — the closed set of
 * pre-generation refusal codes a deployment declares. Because the
 * obligation IS a live protocol declaration (unlike the refusal
 * projector, which is an implementation behaviour), the reference
 * binding legitimately lives here and binds `@ggui-ai/protocol`'s
 * `PRE_GENERATION_REFUSAL_CODES` directly — the same posture as
 * `schema-conformance.test.ts` binding the live
 * `clientCapabilitiesSpecSchema`. That makes the run a drift-catch: if
 * the shipped registry stops satisfying a pin, this suite reds.
 *
 * ## The four portable pins, and the two that are NOT here
 *
 * Ruling 5b names six checks. Four are portable — a third-party adopter
 * with their own registry can run them:
 *
 *   1. `surfaces` non-empty on every entry (v6).
 *   2. `code === key` on every entry.
 *   3. every `after-fix` entry carries `fixBy`.
 *   4. every entry's `retry` is one of the four values.
 *
 * Two read repo source and therefore CANNOT ship as conformance: the
 * docstring rule ("an agent MUST NOT auto-retry an after-fix refusal
 * whose fixBy is not caller") and the grep for code literals outside the
 * registry file. This package ships only `dist` + `README.md`, so a
 * source walk could never run for an npm adopter, and the paths the
 * ruling names (`cloud/ggui-protocol-pod/...`,
 * `backend/amplify/functions/shared/owner-api-refusals.ts`) are outside
 * `oss/` entirely — unreachable after the subtree split. Those two live
 * in `@ggui-ai/protocol`'s own suite
 * (`src/types/__tests__/refusal-codes.test.ts`), where the invariant is
 * owned and the path is stable. The split is DECLARED, not hidden.
 *
 * Note the pins deliberately do NOT assert `fixBy` is absent on
 * non-`after-fix` rows: the landed owner-api rows carry `fixBy: operator`
 * on their `later` entries and `fixBy: tenant` on their `never` entries,
 * so `fixBy` is REQUIRED on `after-fix` and PERMITTED elsewhere.
 */
import { PRE_GENERATION_REFUSAL_CODES } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';

import {
  registryCompletenessPins,
  runRegistryCompletenessConformance,
  type RefusalRegistryView,
} from './index.js';

/** The live registry, viewed through the kit's authored vocabulary. */
const liveRegistry: RefusalRegistryView = PRE_GENERATION_REFUSAL_CODES;

describe('registry-completeness conformance catalog', () => {
  it('ships 4 portable pins', () => {
    expect(registryCompletenessPins.length).toBe(4);
  });

  it('every pin has the load-bearing fields', () => {
    const names = new Set<string>();
    for (const pin of registryCompletenessPins) {
      expect(typeof pin.name).toBe('string');
      expect(pin.name.length).toBeGreaterThan(0);
      expect(names.has(pin.name)).toBe(false); // unique
      names.add(pin.name);
      expect(typeof pin.description).toBe('string');
      expect(pin.description.length).toBeGreaterThan(0);
    }
  });

  it("the LIVE @ggui-ai/protocol registry satisfies every pin (drift-catch)", () => {
    const result = runRegistryCompletenessConformance(liveRegistry);
    expect(result.failed).toEqual([]);
    expect(result.passed.length).toBe(registryCompletenessPins.length);
  });

  it('a registry with an empty `surfaces` list fails the surfaces pin', () => {
    const result = runRegistryCompletenessConformance({
      ...liveRegistry,
      orphan_code: {
        code: 'orphan_code',
        surfaces: [],
        retry: 'never',
        emitter: 'nowhere',
        description: 'a row nobody emits on any surface',
      },
    });
    expect(result.failed.map((f) => f.name)).toContain('surfaces-non-empty');
  });

  it('a registry whose row.code drifts from its key fails the identity pin', () => {
    const result = runRegistryCompletenessConformance({
      ...liveRegistry,
      drifted_key: {
        code: 'some_other_code',
        surfaces: ['render-gate'],
        retry: 'never',
        emitter: 'a gate',
        description: 'code and key disagree',
      },
    });
    expect(result.failed.map((f) => f.name)).toContain('code-equals-key');
  });

  it('an after-fix row with no fixBy fails the fixBy pin', () => {
    const result = runRegistryCompletenessConformance({
      ...liveRegistry,
      no_fix_by: {
        code: 'no_fix_by',
        surfaces: ['render-gate'],
        retry: 'after-fix',
        emitter: 'a gate',
        description: 'after-fix without naming who acts',
      },
    });
    expect(result.failed.map((f) => f.name)).toContain('after-fix-names-fixby');
  });

  it('an unrecognised retry value fails the retry pin', () => {
    const result = runRegistryCompletenessConformance({
      ...liveRegistry,
      bad_retry: {
        code: 'bad_retry',
        surfaces: ['render-gate'],
        retry: 'soon',
        emitter: 'a gate',
        description: 'retry outside the closed set',
      },
    });
    expect(result.failed.map((f) => f.name)).toContain('retry-in-closed-set');
  });

  it('a registry violating all four pins at once fails all four (runner grades)', () => {
    // Without this, a runner that always returned `{passed: all}` would
    // satisfy the pin-shape tests above.
    const result = runRegistryCompletenessConformance({
      broken: {
        code: 'not_broken',
        surfaces: [],
        retry: 'whenever',
        emitter: 'a gate',
        description: 'every pin violated at once',
      },
    });
    expect(result.passed).toEqual([]);
    expect(result.failed.length).toBe(registryCompletenessPins.length);
  });
});
