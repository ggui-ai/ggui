/**
 * Fixture catalog meta-tests — pin the shape of the published
 * fixture surface. Every third-party consumer of
 * `@ggui-ai/protocol-conformance/fixtures` reads these shapes; this
 * file is the drift-catch.
 */
import { describe, expect, it } from 'vitest';

import { parseInputEnvelope } from '../run-conformance.js';
import type { SessionStateBehavior } from '../types.js';
import {
  allFixtures,
  bootstrapProtocolFixtures,
  consumeBufferFixtures,
  fixturesByContract,
  hostContextFixtures,
  reservedChannelAuthorityFixtures,
  schemaVersionHandshakeFixtures,
  subscribeTenancyFixtures,
} from './index.js';

describe('fixtures catalog', () => {
  it('ships 10 fixtures across six materialized sub-modules', () => {
    expect(allFixtures.length).toBe(10);
    // Sanity: confirm the retired wired-dispatch / refresh /
    // observability fixtures are not in the catalog under their old
    // names — the synchronous wired-action path has exactly zero
    // graders left.
    const names = new Set(allFixtures.map((f) => f.name));
    expect(names.has('wired-action-success')).toBe(false);
    expect(names.has('wired-action-tool-not-found')).toBe(false);
    expect(names.has('wired-action-tool-threw')).toBe(false);
    expect(names.has('wired-action-tool-timeout')).toBe(false);
    expect(names.has('observability-wired-tool-invoked')).toBe(false);
    expect(names.has('observability-contract-error-emitted')).toBe(false);
    expect(names.has('stream-refresh-success')).toBe(false);
    expect(names.has('stream-schema-violation')).toBe(false);
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
      'consume-buffer',
      'host-context',
      'reserved-channel-authority',
      'schema-version-handshake',
      'subscribe-tenancy',
    ]);
  });

  it('each sub-module has its documented fixture count', () => {
    expect(bootstrapProtocolFixtures.length).toBe(3);
    expect(consumeBufferFixtures.length).toBe(2);
    expect(hostContextFixtures.length).toBe(1);
    expect(reservedChannelAuthorityFixtures.length).toBe(1);
    expect(schemaVersionHandshakeFixtures.length).toBe(2);
    expect(subscribeTenancyFixtures.length).toBe(1);
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
    // The kit does not JSON-gate skip behavior. Every fixture has
    // `skipReason: null` and the runner dispatches it; per-fixture
    // skips are produced at RUNTIME when the host throws on an
    // unimplemented setup directive (e.g. `renderer-url-override`
    // against the reference server) OR when `match-behavior.ts`
    // returns `unmatchable-on-ws` for kinds requiring browser-level
    // evidence (`bootstrap-failure`, `props-update`). This keeps the
    // fixture catalog vendor-neutral — capability gaps live in host
    // adapters + matchers, not in the published JSON.
    const drivable = allFixtures.filter((f) => f.skipReason === null).map((f) => f.name);
    expect(drivable.length).toBe(allFixtures.length);
    expect(drivable.sort()).toEqual([
      'action-ack-sequence',
      'app-mismatch',
      'bootstrap-bundle-fetch-failed',
      'bootstrap-meta-missing',
      'bootstrap-success',
      'host-context-observed-persists',
      'props-update-roundtrip',
      'undeclared-action-rejected',
      'version-match',
      'version-mismatch',
    ]);
  });

  it('host-context-observed-persists expects exactly the projection it authors (verbatim persistence)', () => {
    // The first-party handler persists `payload.hostContext` AS
    // RECEIVED (projection / trimming is iframe-side, before
    // emission), so the fixture's session-state `expected` MUST be
    // byte-for-byte the projection its input envelope carries — a
    // drift between the two would grade a normalization step the
    // protocol does not define.
    const fixture = allFixtures.find((f) => f.name === 'host-context-observed-persists');
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;

    const dispatch = parseInputEnvelope(fixture.name, fixture.inputEnvelope);
    expect(dispatch.kind).toBe('host_context_observed');
    if (dispatch.kind !== 'host_context_observed') return;
    // The envelope's payload names the same render the create-session
    // setup step declares — the runner subscribes under that id and
    // the server's tenancy guard requires the two to match.
    expect(fixture.setup).toEqual([
      { type: 'create-session', sessionId: dispatch.envelope.payload.sessionId },
    ]);

    expect(fixture.expectedBehavior.kind).toBe('session-state');
    // Cast after the literal check — the extensibly-closed
    // `UnknownBehavior` arm (`kind: string & {}`) widens narrowing.
    const behavior = fixture.expectedBehavior as SessionStateBehavior;
    expect(behavior.field).toBe('hostContext');
    expect(behavior.expected).toEqual(dispatch.envelope.payload.hostContext);
  });

  it('app-mismatch binds the GguiSession to a different appId than the runner subscribes with', () => {
    // The runner's subscribe frame always claims appId 'conformance';
    // the fixture proves the §12.2 tenancy MUST only if its
    // create-session directive binds something else.
    const fixture = allFixtures.find((f) => f.name === 'app-mismatch');
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    expect(fixture.setup.length).toBe(1);
    const step = fixture.setup[0];
    expect(step.type).toBe('create-session');
    if (step.type !== 'create-session') return;
    expect(typeof step.appId).toBe('string');
    expect(step.appId).not.toBe('conformance');
    // The probe is the runner-owned subscribe — the input envelope is
    // descriptive and must NOT classify as a dispatchable frame.
    expect(parseInputEnvelope(fixture.name, fixture.inputEnvelope).kind).toBe('none');
    expect(fixture.expectedBehavior).toEqual({ kind: 'error-frame', code: 'APP_MISMATCH' });
  });
});
