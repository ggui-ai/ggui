/**
 * The kit's own unit lane for the output-schema catalog (ggui#1333): every
 * case under `./cases/` is graded by {@link runOutputSchemaConformance} and
 * must land exactly where it says — the accept cases with no violation, the
 * reject cases with the closed objects' PATHS, so a drift in the walk (a
 * depth it stops reading, a wrapper it skips) is red here before it is a
 * false pass for an adopter.
 */
import { describe, expect, it } from 'vitest';
import acceptNoOutputSchema from './cases/accept-no-output-schema.json' with { type: 'json' };
import acceptOpenAtEveryDepth from './cases/accept-open-at-every-depth.json' with { type: 'json' };
import rejectClosedNestedOnly from './cases/reject-closed-nested-only.json' with { type: 'json' };
import rejectClosedTopLevel from './cases/reject-closed-top-level.json' with { type: 'json' };
import {
  OUTPUT_SCHEMA_OPEN_DESCRIPTION,
  closedObjectsIn,
  runOutputSchemaConformance,
  type AdvertisedToolsListView,
} from './index.js';

interface OutputSchemaCase {
  readonly name: string;
  readonly description: string;
  readonly toolsList: AdvertisedToolsListView;
  readonly expect: {
    readonly passed: readonly string[];
    readonly failed: readonly { readonly name: string; readonly violations: readonly string[] }[];
  };
}

const CASES: readonly OutputSchemaCase[] = [
  acceptOpenAtEveryDepth,
  acceptNoOutputSchema,
  rejectClosedTopLevel,
  rejectClosedNestedOnly,
];

describe('output-schema catalog — an advertised output object MUST NOT be closed (ggui#1333)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const result = runOutputSchemaConformance(c.toolsList);
      expect(result.passed).toEqual(c.expect.passed);
      expect(result.failed.map(({ name, violations }) => ({ name, violations }))).toEqual(c.expect.failed);
      for (const f of result.failed) expect(f.description).toBe(OUTPUT_SCHEMA_OPEN_DESCRIPTION);
    });
  }

  it('the walk reads arrays by index and objects by key, and reports nothing for an open or scalar node', () => {
    expect(closedObjectsIn({ anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: false }] })).toEqual([
      '$.anyOf[1]',
    ]);
    expect(closedObjectsIn({ type: 'object', additionalProperties: {} })).toEqual([]);
    expect(closedObjectsIn('not a schema')).toEqual([]);
    expect(closedObjectsIn(null)).toEqual([]);
  });

  it('the four cases are two accepts and two rejects, each name unique', () => {
    expect(CASES.map((c) => c.name).sort()).toEqual([
      'accept-no-output-schema',
      'accept-open-at-every-depth',
      'reject-closed-nested-only',
      'reject-closed-top-level',
    ]);
  });
});
