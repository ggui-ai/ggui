/**
 * Fixture catalog meta-tests — pin the shape of the published
 * fixture surface. Every third-party consumer of
 * `@ggui-ai/protocol-conformance/fixtures` reads these shapes; this
 * file is the drift-catch.
 */
import { jsonSchemaSchema, validateActionData } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';

import { isRecord } from '../is-record.js';
import { behaviorIs } from '../match-behavior.js';
import { parseInputEnvelope } from '../run-conformance.js';
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
  it('ships 12 fixtures across six materialized sub-modules', () => {
    expect(allFixtures.length).toBe(12);
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
    expect(consumeBufferFixtures.length).toBe(3);
    expect(hostContextFixtures.length).toBe(1);
    expect(reservedChannelAuthorityFixtures.length).toBe(1);
    expect(schemaVersionHandshakeFixtures.length).toBe(2);
    expect(subscribeTenancyFixtures.length).toBe(2);
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
      'absent-appid-defaults',
      'action-ack-sequence',
      'action-payload-schema-violation',
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

    // `behaviorIs` narrows after the literal check — the extensibly-
    // closed `UnknownBehavior` arm (`kind: string & {}`) defeats bare
    // literal narrowing. The expect above throws on mismatch, so the
    // early return is unreachable on a green run.
    const behavior = fixture.expectedBehavior;
    expect(behavior.kind).toBe('session-state');
    if (!behaviorIs(behavior, 'session-state')) return;
    expect(behavior.field).toBe('hostContext');
    expect(behavior.expected).toEqual(dispatch.envelope.payload.hostContext);
  });

  it('action-payload-schema-violation names a DECLARED action whose data genuinely violates the declared schema', () => {
    // The fixture's whole point is the payload-schema half of the
    // contract gate: name-membership alone MUST admit the dispatched
    // ActionEventValue, and the declared entry schema MUST reject it.
    // Graded here against the protocol's own arbiter
    // (`validateActionData`) so the fixture can never drift into
    // re-proving `undeclared-action-rejected` (wrong name) or into
    // authoring data the schema actually accepts (vacuous pass).
    const fixture = allFixtures.find((f) => f.name === 'action-payload-schema-violation');
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;

    // One create-session directive declaring one schema-carrying entry.
    expect(fixture.setup.length).toBe(1);
    const step = fixture.setup[0];
    expect(step.type).toBe('create-session');
    if (step.type !== 'create-session') return;
    const actionSpec = step.actionSpec;
    expect(actionSpec).toBeDefined();
    if (actionSpec === undefined) return;

    // The input envelope is a dispatchable action frame carrying an
    // ActionEventValue whose `action` IS declared.
    expect(parseInputEnvelope(fixture.name, fixture.inputEnvelope).kind).toBe('action');
    const frame = fixture.inputEnvelope;
    expect(isRecord(frame)).toBe(true);
    if (!isRecord(frame)) return;
    const envelope = frame['payload'];
    expect(isRecord(envelope)).toBe(true);
    if (!isRecord(envelope)) return;
    expect(envelope['type']).toBe('data:submit');
    const value = envelope['payload'];
    expect(isRecord(value)).toBe(true);
    if (!isRecord(value)) return;
    const actionName = value['action'];
    expect(typeof actionName).toBe('string');
    if (typeof actionName !== 'string') return;
    const entry = actionSpec[actionName];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    // The declared schema parses under the protocol's JSON-Schema
    // grammar (hosts install it via the same parse — a schema the
    // grammar rejects would skip on every host, grading nothing).
    const parsedSchema = jsonSchemaSchema.safeParse(entry.schema);
    expect(parsedSchema.success).toBe(true);
    if (!parsedSchema.success) return;

    // Schema half rejects; name-membership half alone admits.
    const withSchema = validateActionData(value, {
      [actionName]: { label: actionName, schema: parsedSchema.data },
    });
    expect(withSchema.valid).toBe(false);
    const nameOnly = validateActionData(value, {
      [actionName]: { label: actionName },
    });
    expect(nameOnly.valid).toBe(true);
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

  it('absent-appid-defaults omits the runner appId stamp and grades the bound tenant by state read-back', () => {
    // The runner's subscribe frame normally claims appId 'conformance';
    // this fixture proves the §12.2 identity-default resolution only
    // if the frame genuinely OMITS appId (subscribe.omitAppId) AND the
    // grade reads the bound tenant back (a wire-ack-only grade would
    // pass a server that acks while binding an undefined tenant — the
    // corrupt-row failure mode).
    const fixture = allFixtures.find((f) => f.name === 'absent-appid-defaults');
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    // No setup: provision-on-subscribe IS the path under test.
    expect(fixture.setup).toEqual([]);
    expect(fixture.subscribe).toEqual({ omitAppId: true });
    // The probe is the runner-owned subscribe — the input envelope is
    // descriptive (it carries the sessionId the runner subscribes
    // under) and must NOT classify as a dispatchable frame.
    expect(parseInputEnvelope(fixture.name, fixture.inputEnvelope).kind).toBe('none');
    const behavior = fixture.expectedBehavior;
    expect(behavior.kind).toBe('session-state');
    if (!behaviorIs(behavior, 'session-state')) return;
    expect(behavior.field).toBe('appId');
    // The expected tenant is the conventional 'conformance' default —
    // the same value the runner stamps when it does NOT omit appId, so
    // the identity-default and the explicit path bind identically.
    expect(behavior.expected).toBe('conformance');
  });
});
