/**
 * Fixture catalog meta-tests — pin the shape of the published
 * fixture surface. Every third-party consumer of
 * `@ggui-ai/protocol-conformance/fixtures` reads these shapes; this
 * file is the drift-catch.
 */
import { describe, expect, it } from 'vitest';

import {
  allFixtures,
  bootstrapProtocolFixtures,
  fixturesByContract,
  observabilityEventsFixtures,
  refreshSemanticsFixtures,
  reservedChannelAuthorityFixtures,
  schemaVersionHandshakeFixtures,
  wiredActionDispatchFixtures,
} from './index.js';

describe('fixtures catalog', () => {
  it('ships 14 fixtures across six materialized sub-modules', () => {
    expect(allFixtures.length).toBe(14);
    // Sanity: confirm the deleted canvas-mode + host-context fixtures
    // (retired alongside the Render-identity flatten in Phase A) are
    // not in the catalog under their old slugs.
    const names = new Set(allFixtures.map((f) => f.name));
    expect(names.has('canvas-bootstrap-mutual-exclusion')).toBe(false);
    expect(names.has('canvas-lifecycle-channel-emits-handshake-started')).toBe(false);
    expect(names.has('canvas-navigated-updates-active-stack-item')).toBe(false);
    expect(names.has('host-context-observed-persists')).toBe(false);
  });

  it('classifies every fixture into exactly one sub-module', () => {
    const names = new Set<string>();
    let total = 0;
    for (const fixtures of Object.values(fixturesByContract)) {
      for (const f of fixtures) {
        expect(names.has(f.name)).toBe(false); // no cross-classification
        names.add(f.name);
        total += 1;
      }
    }
    expect(total).toBe(allFixtures.length);
    expect(names.size).toBe(allFixtures.length);
  });

  it('materializes the six expected sub-modules', () => {
    expect(Object.keys(fixturesByContract).sort()).toEqual([
      'bootstrap-protocol',
      'observability-events',
      'refresh-semantics',
      'reserved-channel-authority',
      'schema-version-handshake',
      'wired-action-dispatch',
    ]);
  });

  it('each sub-module has its documented fixture count', () => {
    expect(bootstrapProtocolFixtures.length).toBe(3);
    expect(schemaVersionHandshakeFixtures.length).toBe(2);
    expect(wiredActionDispatchFixtures.length).toBe(4);
    expect(observabilityEventsFixtures.length).toBe(2);
    expect(refreshSemanticsFixtures.length).toBe(1);
    expect(reservedChannelAuthorityFixtures.length).toBe(2);
  });

  it('allFixtures is sorted lexicographically by name (deterministic)', () => {
    const names = allFixtures.map((f) => f.name);
    const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(names).toEqual(sorted);
  });

  it('every fixture has the load-bearing TestCase fields', () => {
    for (const fixture of allFixtures) {
      expect(typeof fixture.name).toBe('string');
      expect(fixture.name.length).toBeGreaterThan(0);
      expect(typeof fixture.description).toBe('string');
      expect(fixture.description.length).toBeGreaterThan(0);
      expect(fixture.skipReason === null || typeof fixture.skipReason === 'string').toBe(
        true,
      );
      expect(Array.isArray(fixture.setup)).toBe(true);
      expect(fixture.teardown === undefined || Array.isArray(fixture.teardown)).toBe(true);
      expect('inputEnvelope' in fixture).toBe(true);
      expect(typeof fixture.expectedBehavior.kind).toBe('string');
    }
  });

  it('every fixture is dispatchable (skipReason === null); per-fixture skips emerge from host throws or matcher unmatchable-on-ws at runtime', () => {
    // Phase 3.1 / 3.2 cumulative shift: the kit no longer JSON-gates
    // skip behavior. Every fixture has `skipReason: null` and the
    // runner dispatches it; per-fixture skips are produced at
    // RUNTIME when the host throws on an unimplemented setup
    // directive (e.g. `renderer-url-override` against the reference
    // server) OR when `match-behavior.ts` returns `unmatchable-on-ws`
    // for kinds requiring browser-level evidence (`bootstrap-
    // failure`, `observability-event`, `props-update`). This keeps
    // the fixture catalog vendor-neutral — capability gaps live in
    // host adapters + matchers, not in the published JSON. Slice G
    // (un-skipping the 8 Phase-3.1 kit-driven fixtures in the OSS
    // Lane 1 spec) flipped the last seven JSON skipReasons.
    const drivable = allFixtures.filter((f) => f.skipReason === null).map((f) => f.name);
    expect(drivable.length).toBe(allFixtures.length);
    expect(drivable.sort()).toEqual([
      'bootstrap-bundle-fetch-failed',
      'bootstrap-meta-missing',
      'bootstrap-success',
      'observability-contract-error-emitted',
      'observability-wired-tool-invoked',
      'props-update-roundtrip',
      'stream-refresh-success',
      'stream-schema-violation',
      'version-match',
      'version-mismatch',
      'wired-action-success',
      'wired-action-tool-not-found',
      'wired-action-tool-threw',
      'wired-action-tool-timeout',
    ]);
  });
});
