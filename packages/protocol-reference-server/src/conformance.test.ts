/**
 * The payoff test — runs `@ggui-ai/protocol-conformance` against a
 * booted `ReferenceServer`, asserts the expected pass / skip shape.
 *
 * This is the empirical proof of Protocol #6 (vendor-neutral
 * separation). If this test passes, an implementation that does
 * not depend on `@ggui-ai/mcp-server*` can satisfy the conformance
 * kit — the vendor-neutrality claim is grounded.
 *
 * Expected outcome:
 *   - 9 fixtures PASS (see {@link EXPECTED_PASSING}).
 *   - 3 fixtures SKIP (see {@link EXPECTED_SKIPPED}) — browser-level
 *     directives the host throws on (`renderer-url-override`,
 *     `ui-initialize-response-override`) or the matcher's
 *     `unmatchable-on-ws` for Path-B claims (`props-update`). See
 *     `match-behavior.ts` for the Path-A vs Path-B partition.
 *   - 0 fixtures FAIL — `KNOWN_FAILURES_AT_v0` is empty.
 */
import { runConformance } from '@ggui-ai/protocol-conformance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createReferenceConformanceHost } from './conformance-host.js';
import { ReferenceServer } from './server.js';

/**
 * Fixtures the reference server reliably passes today.
 *
 *   - `bootstrap-success`: WS subscribe → ack round-trip works
 *     end-to-end with zero `@ggui-ai/mcp-server*` dependency — the
 *     minimum Protocol #6 claim grounded.
 *
 *   - `action-ack-sequence`: the `create-session` directive declares
 *     `actionSpec: {toggleTask: {}}`; the kit dispatches a canonical
 *     `data:submit` action message; the server appends the envelope
 *     to the GguiSession's consume-buffer ledger and acks with
 *     `payload.sequence` echoing the action's `requestId`
 *     (validate → append → ack, mirroring the first-party ordering).
 *     Proves the persistence half of the single action-routing model
 *     is observable on pure WS. The retrieval half (`ggui_consume`)
 *     is an MCP tool call outside this WS-only server's scope — a
 *     declared kit grading gap, not a skipped obligation.
 *
 *   - `undeclared-action-rejected`: same setup, but the dispatched
 *     action names an entry absent from the declared actionSpec. The
 *     server replies an `error` frame with code `CONTRACT_VIOLATION`
 *     (echoing the `requestId`) and appends nothing. Proves the
 *     declared-action contract gates the consume buffer.
 *
 *   - `action-payload-schema-violation`: the `create-session`
 *     directive declares an entry WITH a payload schema (the host
 *     maps it onto the protocol's `ActionEntry.schema`); the
 *     dispatched action names the declared entry but its `data`
 *     violates the schema. The action router's `validateActionData`
 *     (the protocol's own validator — the same one the first-party
 *     server enforces with) rejects it: `error` frame, code
 *     `CONTRACT_VIOLATION`, nothing appended. Proves the SPEC §4.6
 *     receipt-validation half of the declared-action contract.
 *
 *   - `version-match`: the kit's subscribe DECLARES
 *     `supportedVersions` (the fixture's `'current'` sentinel,
 *     resolved to the kit's compiled `PROTOCOL_SCHEMA_VERSION`); this
 *     server's advertised version is in the set, so the handshake
 *     completes AND the ack advertises `payload.serverVersion` equal
 *     to that canonical — which the kit's `serverVersion: 'current'`
 *     ack assertion requires. The happy-path half of Protocol #3,
 *     graded for real: a versionless ack (or an always-reject server)
 *     fails it.
 *
 *   - `version-mismatch`: declares a per-render
 *     `server-version-override` of `'99.99-unsupported'`. The kit's
 *     subscribe carries the same `'current'`-resolved
 *     `supportedVersions` declaration (which excludes the override by
 *     construction); the WS handler reads the GguiSession-scoped
 *     override (set on the `GguiSession` record by
 *     `setVersionOverride()`), notices the advertised version is not
 *     in the client's accepted set, and emits the canonical
 *     `error{payload.code:'UPGRADE_REQUIRED',
 *     serverVersion}` frame. Proves the rejection half of Protocol #3
 *     with parallel-fixture isolation (other GguiSessions on the same
 *     server still advertise the canonical default).
 *
 *   - `app-mismatch`: the `create-session` directive binds the render
 *     to appId `'conformance-other'`; the runner's subscribe always
 *     carries appId `'conformance'`. SPEC §12.2 makes the tenancy
 *     check a MUST — the subscribe handler rejects with an `error`
 *     frame, code `APP_MISMATCH` (§12.2.3), registering no subscriber
 *     and emitting no ack. Proves the GguiSession-exists-but-different-
 *     app rejection is distinct from SESSION_NOT_FOUND.
 *
 *   - `host-context-observed-persists`: the kit dispatches the
 *     `host_context_observed` Client→Server observation frame; the
 *     server validates it against the protocol's
 *     `HostContextProjection` and persists `payload.hostContext` onto
 *     `GguiSession.hostContext` (idempotent overwrite, no response
 *     frame). The kit grades the stateful obligation through this
 *     host's `readSessionField('hostContext')` introspection seam —
 *     the kit's third grading mechanism (session-state), beside the
 *     wire-frame matchers and the pure-function catalogs.
 *
 *   - `absent-appid-defaults`: the kit's subscribe OMITS `appId`
 *     (`subscribe.omitAppId`). SPEC §12.2 makes `appId` optional —
 *     absence resolves the caller's identity-default app, which for
 *     this no-auth server is the deployment-level
 *     `DEPLOYMENT_DEFAULT_APP_ID`. The provision-on-subscribe path
 *     binds the resolved value; the kit grades it by session-state
 *     read-back of the row's `appId` through `readSessionField` —
 *     proving the default binds a real tenant, never an undefined
 *     one.
 */
const EXPECTED_PASSING = [
  'absent-appid-defaults',
  'action-ack-sequence',
  'action-payload-schema-violation',
  'app-mismatch',
  'bootstrap-success',
  'host-context-observed-persists',
  'undeclared-action-rejected',
  'version-match',
  'version-mismatch',
];

/**
 * Fixtures that SKIP on the reference server, by name. Pinning the
 * exact set (not just "skips have a reason") catches both regressions:
 * a Path-A fixture silently degrading to a skip AND a Path-B fixture
 * silently starting to "pass" through a hole in the partition.
 *
 *   - `bootstrap-bundle-fetch-failed` / `bootstrap-meta-missing`:
 *     setup needs `renderer-url-override` /
 *     `ui-initialize-response-override` — browser-level fault
 *     injection the host adapter throws on by design.
 *   - `props-update-roundtrip`: the assertion is on rendered DOM; the
 *     matcher returns `unmatchable-on-ws` (Path-B).
 */
const EXPECTED_SKIPPED = [
  'bootstrap-bundle-fetch-failed',
  'bootstrap-meta-missing',
  'props-update-roundtrip',
];

/**
 * Fixtures that fail on today's reference server for reasons tracked
 * as Protocol #6 findings. Currently empty: every Path-A fixture
 * passes and every skip is in {@link EXPECTED_SKIPPED}. Re-populate
 * only if a scope limitation regresses to a hard FAIL — the kit's
 * design intent is "no FAILs" once the server's vendor-neutral
 * surface is grounded.
 */
const KNOWN_FAILURES_AT_v0: readonly string[] = [];

describe('protocol-reference-server passes @ggui-ai/protocol-conformance', () => {
  let server: ReferenceServer;

  beforeAll(async () => {
    server = new ReferenceServer({ port: 0 }); // ephemeral port
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('the core wire-level fixtures pass', async () => {
    const host = createReferenceConformanceHost({ serverInstance: server });
    const result = await runConformance({
      serverUrl: server.baseUrl,
      auth: { kind: 'bearer', token: 'reference' },
      host,
      // Every fixture waits out the full observation window — keep it
      // short; the reference server's emissions are synchronous.
      observationTimeoutMs: 1500,
    });

    const diagnostic = [
      '',
      `passed (${result.passed.length}): ${result.passed.join(', ')}`,
      `failed (${result.failed.length}):`,
      ...result.failed.map((f) => `  - ${f.name}: ${f.message}`),
      `skipped (${result.skipped.length}):`,
      ...result.skipped.map((s) => `  - ${s.name}: ${s.reason}`),
    ].join('\n');

    // Every expected-passing fixture must be in the passed list.
    for (const name of EXPECTED_PASSING) {
      expect(
        result.passed,
        `expected fixture '${name}' to pass\n${diagnostic}`,
      ).toContain(name);
    }

    // Expected failures (known Protocol #6 findings under
    // investigation — see KNOWN_FAILURES_AT_v0 above). Any failure
    // NOT in this set is a genuine vendor-neutrality bug.
    const unexpectedFailures = result.failed.filter(
      (f) => !KNOWN_FAILURES_AT_v0.includes(f.name),
    );
    expect(
      unexpectedFailures,
      `unexpected failures beyond known Protocol #6 findings:\n${diagnostic}`,
    ).toEqual([]);

    // The pass set is exact — a fixture leaving it is a regression,
    // a fixture entering it should be pinned deliberately.
    expect([...result.passed].sort(), diagnostic).toEqual(EXPECTED_PASSING);
  }, 30_000);

  it('skipped fixtures are exactly the declared out-of-scope set', async () => {
    const host = createReferenceConformanceHost({ serverInstance: server });
    const result = await runConformance({
      serverUrl: server.baseUrl,
      auth: { kind: 'bearer', token: 'reference' },
      host,
      observationTimeoutMs: 1500,
    });

    expect(result.skipped.map((s) => s.name).sort()).toEqual(EXPECTED_SKIPPED);

    // Every skip carries an honest reason; "no host provided" cannot
    // happen here — we DO provide a host — so its presence would be a
    // runner-wiring bug.
    for (const skip of result.skipped) {
      expect(skip.reason.length).toBeGreaterThan(0);
      expect(
        skip.reason.includes('no host provided'),
        `fixture '${skip.name}' skipped for unexpected reason: ${skip.reason}`,
      ).toBe(false);
    }
  }, 30_000);
});
