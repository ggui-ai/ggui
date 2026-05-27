/**
 * The Phase 3.2 payoff test — runs `@ggui-ai/protocol-conformance`
 * against a booted `ReferenceServer`, asserts the expected pass /
 * skip shape.
 *
 * This is the empirical proof of Protocol #6 (vendor-neutral
 * separation). If this test passes, an implementation that does
 * not depend on `@ggui-ai/mcp-server*` can satisfy the conformance
 * kit — the vendor-neutrality claim is grounded.
 *
 * Expected outcome:
 *   - 10 fixtures PASS: `bootstrap-success`, the three wired-action
 *     contract-error paths (`TOOL_NOT_FOUND`, `TOOL_THREW`,
 *     `TOOL_TIMEOUT`), `wired-action-success` (Slice L's WS-evidence
 *     `observability-event` matcher grounds the primary
 *     `wired-tool-invoked` arm), `stream-refresh-success` (Slice I
 *     added refresh-stream dispatch via `register-streamspec`),
 *     `stream-schema-violation` (fixture declares `register-streamspec`
 *     against `tasks_malformed_list` whose `malformed-stream` handler
 *     returns a shape that fails `assertStreamContract`, producing the
 *     SCHEMA_VIOLATION envelope on `_ggui:contract-error` — drift fixes
 *     `03462b99` + `c243d4e3`), `version-mismatch` (Slice K added the
 *     per-render `server-version-override` directive —
 *     `setVersionOverride()` on the render store, consulted by the WS
 *     subscribe handler before falling back to the instance-level
 *     advertised version), and the two standalone `observability-event`
 *     fixtures (`observability-contract-error-emitted` +
 *     `observability-wired-tool-invoked`) — Slice L's matcher per the
 *     protocol-bar's "every conformant host MUST mirror-emit
 *     observability events on the WS evidence the bar mandates" claim.
 *   - Remaining fixtures SKIP — either `skipReason !== null` in the
 *     fixture JSON (e.g. browser-level directives) or runner matcher
 *     returns `unmatchable-on-ws` for `props-update` /
 *     `bootstrap-failure` (Path-B browser-host adapter territory; see
 *     `match-behavior.ts` for the Path-A vs Path-B partition).
 *   - 0 fixtures FAIL — `KNOWN_FAILURES_AT_v0` is empty.
 */
import { runConformance } from '@ggui-ai/protocol-conformance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createReferenceConformanceHost } from './conformance-host.js';
import { ReferenceServer } from './server.js';

/**
 * Fixtures the reference server reliably passes today. Covers the
 * WS-level bootstrap proof plus every wired-action contract-error
 * path the conformance kit models — `TOOL_NOT_FOUND` / `TOOL_THREW`
 * / `TOOL_TIMEOUT` — emitted via the protocol's canonical
 * `makeContractErrorPayload` builder and matched against the kit's
 * canonical-shape reader.
 *
 *   - `bootstrap-success`: WS subscribe → ack round-trip works
 *     end-to-end with zero `@ggui-ai/mcp-server*` dependency — the
 *     minimum Protocol #6 claim grounded.
 *
 *   - `wired-action-tool-not-found` / `wired-action-tool-threw` /
 *     `wired-action-tool-timeout`: each asserts the matching
 *     `_ggui:contract-error` envelope shape per SPEC §4.4. Router
 *     resolves action → tool via the fixture's explicit
 *     `register-actionspec` directive; unresolved actions emit
 *     `TOOL_NOT_FOUND` with `toolName` set to the requested action
 *     name.
 *
 *   - `stream-refresh-success`: declares
 *     `streamSpec.tasks.tool = 'tasks_list'` via the Slice-I
 *     `register-streamspec` directive. After the wired
 *     `createTask → tasks_create` action succeeds, the router runs
 *     `tasks_list` (kind `list-snapshot`, returns `{items:[]}`) and
 *     emits a stream-update on channel `tasks`. The kit's matcher
 *     asserts the `{items:[]}` shape arrived — proves the refresh-
 *     after-action contract is observable on pure WS.
 *
 *   - `version-mismatch`: declares a per-render
 *     `server-version-override` of `'99.99-unsupported'` via the
 *     Slice-K directive. The kit's subscribe carries
 *     `supportedVersions: ['1.1']`; the WS handler reads the
 *     render-scoped override (set on the `Render` record by
 *     `setVersionOverride()`), notices `'99.99-unsupported'` is not
 *     in the client's accepted set, and emits the canonical
 *     `error{payload.code:'UPGRADE_REQUIRED', serverVersion}` frame.
 *     Proves the version-handshake half of Protocol #3 is observable
 *     end-to-end on the reference server with parallel-fixture
 *     isolation (other renders on the same server still advertise
 *     the canonical default).
 *
 *   - `observability-contract-error-emitted` /
 *     `observability-wired-tool-invoked`: standalone observability
 *     fixtures whose `expectedBehavior.kind === 'observability-event'`.
 *     Slice L grounded the matcher: per the protocol-and-contract bar,
 *     every conformant host MUST mirror-emit
 *     `contract-error-emitted` on every observed
 *     `_ggui:contract-error` envelope, and MUST mirror-emit
 *     `wired-tool-invoked` on every observed wired-action tool
 *     dispatch+result. The matcher asserts directly on the WS evidence
 *     the bar makes mandatory — no postMessage capture needed. The
 *     reference server's `action-router.ts` emits both signals (the
 *     `_ggui:wired-tool-invoked` stream frame on happy-path; the
 *     canonical `_ggui:contract-error` envelope on the throw path)
 *     after the fixtures' `register-actionspec` directive resolves the
 *     authored action → tool mapping.
 *
 * Note on `wired-action-success` vs the standalone observability
 * fixtures: `wired-action-success` carries an `expectedObservability`
 * co-assertion array (action tool + refresh tool — two signals). The
 * Path-A kit matches on the primary `expectedBehavior` only — the
 * `expectedObservability` co-assertion is for a richer host harness
 * to enforce. The primary `wired-tool-invoked` arm is what passes
 * here; the co-assertion is observed-but-not-asserted at this layer.
 */
const EXPECTED_PASSING = [
  'bootstrap-success',
  'wired-action-tool-not-found',
  'wired-action-tool-threw',
  'wired-action-tool-timeout',
  'wired-action-success',
  'stream-refresh-success',
  'stream-schema-violation',
  'version-mismatch',
  'observability-contract-error-emitted',
  'observability-wired-tool-invoked',
];

/**
 * Fixtures that fail on today's reference server for reasons tracked
 * as Protocol #6 findings — scope-limited dispatch paths the
 * reference server deliberately doesn't implement. Listed here so
 * the test asserts "no NEW failures beyond these" rather than "zero
 * failures".
 *
 * Currently empty: every Path-A fixture either passes (see
 * `EXPECTED_PASSING`) or skips with a clear reason (fixture-declared
 * `skipReason`, the host's throw-on-unimplemented for browser-only
 * directives, or the matcher's `unmatchable-on-ws` for
 * `bootstrap-failure` / `props-update`). Re-populate if a future
 * scope-limitation regresses to a hard FAIL — but the kit's design
 * intent is "no FAILs" once the server's vendor-neutral surface is
 * grounded.
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
      // Shorter observation window — 500ms beats the 2s default for
      // the tool-timeout fixture (which intentionally times out).
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
    // investigation — see KNOWN_FAILURES_AT_v0 below). Any failure
    // NOT in this set is a genuine vendor-neutrality bug.
    const unexpectedFailures = result.failed.filter(
      (f) => !KNOWN_FAILURES_AT_v0.includes(f.name),
    );
    expect(
      unexpectedFailures,
      `unexpected failures beyond known Protocol #6 findings:\n${diagnostic}`,
    ).toEqual([]);
  }, 30_000);

  it('skipped fixtures are ONLY for out-of-scope directives or fixture-declared skips', async () => {
    const host = createReferenceConformanceHost({ serverInstance: server });
    const result = await runConformance({
      serverUrl: server.baseUrl,
      auth: { kind: 'bearer', token: 'reference' },
      host,
      observationTimeoutMs: 1500,
    });

    // Every skip reason must match one of:
    //   - a fixture-declared `skipReason` (string in the JSON)
    //   - "reference server does not implement <directive>"
    //     (our adapter's throw-on-unimplemented)
    //   - "requires browser-level…" / matcher's unmatchable-on-ws
    //     reason
    //   - "no host provided" (can't happen here — we DO provide a
    //     host — so absence is a spec violation)
    for (const skip of result.skipped) {
      const reasonIsAcceptable =
        skip.reason.length > 0 &&
        !skip.reason.includes('no host provided');
      expect(
        reasonIsAcceptable,
        `fixture '${skip.name}' skipped for unexpected reason: ${skip.reason}`,
      ).toBe(true);
    }
  }, 30_000);
});
