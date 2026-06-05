/**
 * `runConformance()` — drive every fixture in the catalog against a
 * live implementation and return a pass / fail / skip scorecard.
 *
 * Orchestration:
 *   1. Invoke `reporter.onStart(totalFixtures)`.
 *   2. For each fixture (filtered by `config.only` if provided):
 *      a. If `fixture.skipReason !== null` → skip with the reason.
 *      b. If `fixture.setup` non-empty AND `config.host` absent →
 *         skip with "no host provided".
 *      c. Dispatch every setup step via `host.dispatchSetup()`.
 *         Throw → skip with the error message (NOT a fail).
 *      d. Open a WS transport against `config.serverUrl`.
 *      e. Send the canonical `subscribe` frame (the runner knows the
 *         wire shape — fixture's `inputEnvelope` is NOT the subscribe
 *         frame; subscribe is always runner-owned).
 *      f. If the fixture's `inputEnvelope.type === 'action'`, send
 *         it as a live-channel action frame AFTER subscribe.
 *      g. Observe frames for `config.observationTimeoutMs` (default
 *         2000ms).
 *      h. Match observed frames against `fixture.expectedBehavior`.
 *      i. Close the WS.
 *      j. Dispatch every teardown step via `host.dispatchTeardown()`.
 *         Throw → reporter warning; does NOT flip pass → fail.
 *      k. Record the outcome via reporter + accumulate in result.
 *   3. Invoke `reporter.onComplete(result)` + return.
 *
 * Scope v1: pure WS transport. Browser-level fixtures (bootstrap-
 * failure, props-update, observability-event) automatically skip via
 * the matcher's `unmatchable-on-ws` arm.
 */
import { allFixtures, fixturesByContract } from './fixtures/index.js';
import type { ConformanceHost } from './conformance-host.js';
import { matchBehavior } from './match-behavior.js';
import type {
  AuthConfig,
  ContractErrorBehavior,
  SetupStep,
  StreamUpdateBehavior,
  TeardownStep,
  TestCase,
  VersionMismatchBehavior,
} from './types.js';
import { openWsTransport, type WsTransport } from './ws-transport.js';

// =============================================================================
// Public API
// =============================================================================

export interface RunConformanceConfig {
  /**
   * Base URL of the implementation under test. The runner appends
   * `/ws` to reach the live-channel endpoint; provide `http://host:port`
   * or `https://…` and the runner derives `ws://` / `wss://`.
   */
  readonly serverUrl: string;
  /** Auth carried on the WS upgrade. See {@link AuthConfig}. */
  readonly auth: AuthConfig;
  /** Optional abort signal — cancels the run between fixtures. */
  readonly signal?: AbortSignal;
  /** Filter fixtures by name. Useful for debugging. */
  readonly only?: readonly string[];
  /** Reporter callbacks. Default is a silent reporter. */
  readonly reporter?: ConformanceReporter;
  /**
   * Conformance host the runner dispatches setup/teardown against.
   * Fixtures with non-empty `setup` skip if `host` is undefined.
   */
  readonly host?: ConformanceHost;
  /** Per-fixture observation window. Default 2000ms. */
  readonly observationTimeoutMs?: number;
}

export interface ConformanceResult {
  readonly passed: readonly string[];
  readonly failed: readonly ConformanceFailure[];
  readonly skipped: readonly SkippedFixture[];
  readonly totalMs: number;
}

export interface ConformanceFailure {
  readonly name: string;
  readonly criterion: string;
  readonly expected: unknown;
  readonly received: unknown;
  readonly message: string;
}

export interface SkippedFixture {
  readonly name: string;
  readonly reason: string;
}

export interface ConformanceReporter {
  onStart?(totalFixtures: number): void;
  onFixturePass?(name: string, elapsedMs: number): void;
  onFixtureFail?(failure: ConformanceFailure): void;
  onFixtureSkip?(name: string, reason: string): void;
  /**
   * Invoked when a teardown step throws. Non-fatal — the fixture's
   * pass/fail verdict is NOT affected. Surfaces cleanup gaps for
   * operator attention.
   */
  onTeardownWarning?(name: string, message: string): void;
  onComplete?(result: ConformanceResult): void;
}

// =============================================================================
// Runner
// =============================================================================

export async function runConformance(
  config: RunConformanceConfig,
): Promise<ConformanceResult> {
  const started = Date.now();
  const fixtures = filterFixtures(config.only);
  const reporter = config.reporter ?? {};
  reporter.onStart?.(fixtures.length);

  const passed: string[] = [];
  const failed: ConformanceFailure[] = [];
  const skipped: SkippedFixture[] = [];

  for (const fixture of fixtures) {
    if (config.signal?.aborted === true) {
      skipped.push({
        name: fixture.name,
        reason: 'aborted by signal before dispatch',
      });
      reporter.onFixtureSkip?.(fixture.name, 'aborted by signal before dispatch');
      continue;
    }

    const outcome = await runOneFixture(fixture, config, reporter);
    switch (outcome.kind) {
      case 'pass':
        passed.push(fixture.name);
        reporter.onFixturePass?.(fixture.name, outcome.elapsedMs);
        break;
      case 'fail':
        failed.push(outcome.failure);
        reporter.onFixtureFail?.(outcome.failure);
        break;
      case 'skip':
        skipped.push({ name: fixture.name, reason: outcome.reason });
        reporter.onFixtureSkip?.(fixture.name, outcome.reason);
        break;
    }
  }

  const result: ConformanceResult = {
    passed,
    failed,
    skipped,
    totalMs: Date.now() - started,
  };
  reporter.onComplete?.(result);
  return result;
}

// =============================================================================
// Per-fixture dispatch
// =============================================================================

type FixtureOutcome =
  | { readonly kind: 'pass'; readonly elapsedMs: number }
  | { readonly kind: 'fail'; readonly failure: ConformanceFailure }
  | { readonly kind: 'skip'; readonly reason: string };

async function runOneFixture(
  fixture: TestCase,
  config: RunConformanceConfig,
  _reporter: ConformanceReporter,
): Promise<FixtureOutcome> {
  const fixtureStarted = Date.now();

  if (fixture.skipReason !== null) {
    return { kind: 'skip', reason: fixture.skipReason };
  }

  if (fixture.setup.length > 0 && config.host === undefined) {
    return {
      kind: 'skip',
      reason: `fixture has ${fixture.setup.length} setup step(s) and no \`host\` was provided — supply a ConformanceHost to drive setup directives.`,
    };
  }

  // Dispatch setup via host. A throw means "host doesn't implement
  // this directive" — record as skip, NOT fail.
  if (config.host !== undefined) {
    for (const step of fixture.setup) {
      try {
        await config.host.dispatchSetup(narrowSetupStep(step));
      } catch (err) {
        return {
          kind: 'skip',
          reason: `host refused setup step type='${(step as { type?: unknown }).type ?? 'unknown'}': ${String((err as Error).message ?? err)}`,
        };
      }
    }
  }

  // Open WS + subscribe + dispatch + observe.
  let transport: WsTransport | null = null;
  try {
    const wsUrl = deriveWsUrl(config.serverUrl);
    transport = await openWsTransport({ kind: 'ws', url: wsUrl, auth: config.auth });

    const sessionId = extractSessionId(fixture);
    transport.send({
      type: 'subscribe',
      payload: {
        sessionId,
        appId: 'conformance',
        role: 'user',
        ...(maybeSupportedVersions(fixture.expectedBehavior) ?? {}),
      },
      requestId: `conformance-subscribe-${fixture.name}`,
    });

    if (shouldDispatchInputEnvelope(fixture)) {
      transport.send(fixture.inputEnvelope);
    }

    const frames = await transport.observe({
      timeoutMs: config.observationTimeoutMs ?? 2000,
    });
    const match = matchBehavior(fixture.expectedBehavior, frames);

    // Dispatch teardown regardless of match outcome. Failures in
    // teardown surface as warnings; they do not flip pass → fail.
    if (config.host !== undefined && fixture.teardown !== undefined) {
      for (const step of fixture.teardown) {
        try {
          await config.host.dispatchTeardown(narrowTeardownStep(step));
        } catch (err) {
          _reporter.onTeardownWarning?.(
            fixture.name,
            `teardown step type='${(step as { type?: unknown }).type ?? 'unknown'}' threw: ${String((err as Error).message ?? err)}`,
          );
        }
      }
    }

    if (match.kind === 'pass') {
      return { kind: 'pass', elapsedMs: Date.now() - fixtureStarted };
    }
    if (match.kind === 'fail') {
      return {
        kind: 'fail',
        failure: {
          name: fixture.name,
          criterion: criterionForFixture(fixture.name),
          expected: match.expected,
          received: match.received,
          message: match.message,
        },
      };
    }
    // match.kind === 'unmatchable-on-ws'
    return { kind: 'skip', reason: match.reason };
  } catch (err) {
    return {
      kind: 'fail',
      failure: {
        name: fixture.name,
        criterion: criterionForFixture(fixture.name),
        expected: 'transport reachable + fixture driveable',
        received: String((err as Error).message ?? err),
        message: `runner-side error dispatching fixture: ${String((err as Error).message ?? err)}`,
      },
    };
  } finally {
    if (transport !== null) await transport.close();
  }
}

// =============================================================================
// Helpers
// =============================================================================

function filterFixtures(only: readonly string[] | undefined): readonly TestCase[] {
  if (only === undefined || only.length === 0) return allFixtures;
  const allow = new Set(only);
  return allFixtures.filter((fixture) => allow.has(fixture.name));
}

function deriveWsUrl(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, '');
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return `${trimmed}/ws`;
  }
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}/ws`;
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}/ws`;
  // No scheme provided — assume plain ws.
  return `ws://${trimmed}/ws`;
}

function extractSessionId(fixture: TestCase): string {
  // Prefer a sessionId from the first `create-session` setup step —
  // this is the fixture's declared render identity. Fall back to
  // inputEnvelope.sessionId, then to the fixture name.
  for (const step of fixture.setup) {
    if (
      (step as { type?: unknown }).type === 'create-session' &&
      typeof (step as { sessionId?: unknown }).sessionId === 'string'
    ) {
      return (step as { sessionId: string }).sessionId;
    }
  }
  const envelope = fixture.inputEnvelope;
  if (
    envelope !== null &&
    typeof envelope === 'object' &&
    'sessionId' in envelope &&
    typeof (envelope as { sessionId?: unknown }).sessionId === 'string'
  ) {
    return (envelope as { sessionId: string }).sessionId;
  }
  return fixture.name;
}

/**
 * Fixtures with `inputEnvelope.type === 'action'` (or another channel-
 * 3 dispatch shape) get sent verbatim after subscribe. Fixtures with
 * `type === 'render'` are bootstrap-path — the subscribe itself is
 * the dispatch, so we skip the explicit send.
 */
function shouldDispatchInputEnvelope(fixture: TestCase): boolean {
  const envelope = fixture.inputEnvelope;
  if (envelope === null || typeof envelope !== 'object') return false;
  const type = (envelope as { type?: unknown }).type;
  return type === 'action';
}

function maybeSupportedVersions(
  behavior: TestCase['expectedBehavior'],
): { readonly supportedVersions: readonly string[] } | undefined {
  if (behavior.kind === 'version-mismatch') {
    // Cast to the specific arm — the extensibly-closed `UnknownBehavior`
    // in the union has `kind: string & {}` which widens narrowing and
    // makes TS forget it already checked the discriminant literal.
    const narrow = behavior as VersionMismatchBehavior;
    return { supportedVersions: narrow.clientAccepts };
  }
  return undefined;
}

/**
 * Map fixture name → the bar criterion it exercises, for the
 * `ConformanceFailure.criterion` field. Derived from the
 * `fixturesByContract` classification so the runner stays in sync
 * with the reporter's scorecard grouping.
 */
function criterionForFixture(name: string): string {
  for (const [slug, fixtures] of Object.entries(fixturesByContract)) {
    if (fixtures.some((f) => f.name === name)) return slugToCriterion(slug);
  }
  return 'unknown criterion';
}

function slugToCriterion(slug: string): string {
  switch (slug) {
    case 'bootstrap-protocol':
      return 'Protocol #5 named failure modes — bootstrap contract';
    case 'observability-events':
      return 'Phase 2 C12 observability contract';
    case 'refresh-semantics':
      return 'SPEC §2.3 StreamSpec refresh triggers';
    case 'reserved-channel-authority':
      return 'SPEC §4.4 reserved-channel authority';
    case 'schema-version-handshake':
      return 'Protocol #3 version negotiation';
    case 'wired-action-dispatch':
      return 'Contract #3 defined failure modes (wiredActionRouter)';
    default:
      return slug;
  }
}

/**
 * The fixture-JSON `SetupStep` and the host's runtime `SetupStep` use
 * slightly different shapes (`type` vs `kind` field, respectively).
 * The runner accepts JSON-shape at the fixture boundary and narrows
 * here — translating `{type,...}` → `{kind,...}` — before dispatching
 * to the host.
 */
function narrowSetupStep(step: SetupStep): Parameters<ConformanceHost['dispatchSetup']>[0] {
  const raw = step as Record<string, unknown>;
  const { type, ...rest } = raw;
  return { kind: (type as string) ?? 'unknown', ...rest } as Parameters<
    ConformanceHost['dispatchSetup']
  >[0];
}

function narrowTeardownStep(
  step: TeardownStep,
): Parameters<ConformanceHost['dispatchTeardown']>[0] {
  const raw = step as Record<string, unknown>;
  const { type, ...rest } = raw;
  return { kind: (type as string) ?? 'unknown', ...rest } as Parameters<
    ConformanceHost['dispatchTeardown']
  >[0];
}

// Re-export the narrowed union types for callers building custom
// reporters.
export type { ContractErrorBehavior, StreamUpdateBehavior, VersionMismatchBehavior };
