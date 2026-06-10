/**
 * `runConformance()` — drive every fixture in the catalog against a
 * live implementation and return a pass / fail / skip scorecard.
 *
 * Orchestration:
 *   1. Invoke `reporter.onStart(totalFixtures)`.
 *   2. For each fixture (filtered by `config.only` if provided):
 *      a. If `fixture.skipReason !== null` → skip with the reason.
 *      b. Validate every authored setup/teardown directive against
 *         the closed `SetupStep` vocabulary (`parseSetupStep`).
 *         Unknown / malformed directives are fixture-authoring
 *         errors — the runner throws, aborting the run loudly (NOT a
 *         skip, NOT a fail of the implementation under test).
 *      c. If `fixture.setup` non-empty AND `config.host` absent →
 *         skip with "no host provided".
 *      d. Dispatch every setup step via `host.dispatchSetup()`.
 *         Throw → skip with the error message (NOT a fail).
 *      e. Open a WS transport against `config.serverUrl`.
 *      f. Send the canonical `subscribe` frame (the runner knows the
 *         wire shape — fixture's `inputEnvelope` is NOT the subscribe
 *         frame; subscribe is always runner-owned).
 *      g. If the fixture's `inputEnvelope.type === 'action'`, send
 *         it as a live-channel action frame AFTER subscribe.
 *      h. Observe frames for `config.observationTimeoutMs` (default
 *         2000ms).
 *      i. Match observed frames against `fixture.expectedBehavior`.
 *      j. Close the WS.
 *      k. Dispatch every teardown step via `host.dispatchTeardown()`.
 *         Throw → reporter warning; does NOT flip pass → fail.
 *         (No teardown vocabulary exists in this kit version, so the
 *         loop is empty today.)
 *      l. Record the outcome via reporter + accumulate in result.
 *   3. Invoke `reporter.onComplete(result)` + return.
 *
 * Scope v1: pure WS transport. Browser-level fixtures (bootstrap-
 * failure, props-update) automatically skip via the matcher's
 * `unmatchable-on-ws` arm.
 */
import { allFixtures, fixturesByContract } from './fixtures/index.js';
import type {
  ConformanceHost,
  SetupStep as HostSetupStep,
  TeardownStep as HostTeardownStep,
} from './conformance-host.js';
import { matchBehavior } from './match-behavior.js';
import type {
  ActionSpecEntryDecl,
  AuthConfig,
  StreamUpdateBehavior,
  TestCase,
  VersionMismatchBehavior,
} from './types.js';
import { openWsTransport, type WsTransport } from './ws-transport.js';

// =============================================================================
// Public API
// =============================================================================

export interface RunConformanceConfig {
  /**
   * URL of the implementation under test. `http://` / `https://`
   * schemes derive `ws://` / `wss://`. A bare origin (no path, e.g.
   * `http://localhost:3000`) gets the default live-channel path `/ws`
   * appended; a URL that already carries a path (e.g.
   * `ws://localhost:3000/ws`, or a non-default mount point) is used
   * exactly as given — the runner never appends to an explicit path.
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

  // Validate the authored directives BEFORE any host or transport
  // work. An unknown / malformed directive is a fixture-authoring
  // error, not a behavior of the implementation under test — the
  // parse throws a descriptive error that aborts the whole run.
  const setupSteps = fixture.setup.map((step) => parseSetupStep(fixture.name, step));
  const teardownSteps: readonly HostTeardownStep[] = (fixture.teardown ?? []).map((step) =>
    parseTeardownStep(fixture.name, step),
  );

  if (setupSteps.length > 0 && config.host === undefined) {
    return {
      kind: 'skip',
      reason: `fixture has ${setupSteps.length} setup step(s) and no \`host\` was provided — supply a ConformanceHost to drive setup directives.`,
    };
  }

  // Dispatch setup via host. A throw means "host doesn't implement
  // this directive" — record as skip, NOT fail.
  if (config.host !== undefined) {
    for (const step of setupSteps) {
      try {
        await config.host.dispatchSetup(step);
      } catch (err) {
        return {
          kind: 'skip',
          reason: `host refused setup step kind='${step.kind}': ${String((err as Error).message ?? err)}`,
        };
      }
    }
  }

  // Open WS + subscribe + dispatch + observe.
  let transport: WsTransport | null = null;
  try {
    const wsUrl = deriveWsUrl(config.serverUrl);
    transport = await openWsTransport({ kind: 'ws', url: wsUrl, auth: config.auth });

    const sessionId = extractSessionId(fixture, setupSteps);
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
    // (The teardown vocabulary is empty in this kit version, so
    // `teardownSteps` is always empty today — the loop is the slot
    // future cleanup directives flow through.)
    if (config.host !== undefined) {
      for (const step of teardownSteps) {
        try {
          await config.host.dispatchTeardown(step);
        } catch (err) {
          _reporter.onTeardownWarning?.(
            fixture.name,
            `teardown step threw: ${String((err as Error).message ?? err)}`,
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

/**
 * Resolve the WS endpoint from `config.serverUrl`:
 *   - `http://` / `https://` schemes become `ws://` / `wss://`; a
 *     scheme-less value is assumed `ws://`.
 *   - A bare origin (no path) gets the default live-channel path
 *     `/ws` appended.
 *   - A URL that already carries a path is used exactly as given —
 *     the runner never appends to an explicit path, so
 *     `ws://host:3000/ws` (or a non-default mount point) works
 *     without double-appending.
 *
 * Exported for unit tests; not part of the package's public API.
 */
export function deriveWsUrl(serverUrl: string): string {
  const withScheme = /^(?:https?|wss?):\/\//.test(serverUrl)
    ? serverUrl
    : `ws://${serverUrl}`;
  const url = new URL(withScheme);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/ws';
  }
  return url.toString();
}

function extractSessionId(fixture: TestCase, setupSteps: readonly HostSetupStep[]): string {
  // Prefer a sessionId from the first `create-session` setup step —
  // this is the fixture's declared render identity. Fall back to
  // inputEnvelope.sessionId, then to the fixture name.
  for (const step of setupSteps) {
    if (step.kind === 'create-session') return step.sessionId;
  }
  const envelope = fixture.inputEnvelope;
  if (isRecord(envelope) && typeof envelope['sessionId'] === 'string') {
    return envelope['sessionId'];
  }
  return fixture.name;
}

/**
 * Fixtures with `inputEnvelope.type === 'action'` (the live-channel
 * dispatch shape) get sent verbatim after subscribe. The other
 * authored envelope types (`render`, `handshake`, `props-update`) are
 * driven by the subscribe itself or by a Path-B host harness, so the
 * explicit send is skipped.
 */
function shouldDispatchInputEnvelope(fixture: TestCase): boolean {
  const envelope = fixture.inputEnvelope;
  return isRecord(envelope) && envelope['type'] === 'action';
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
    case 'consume-buffer':
      return 'Single action-routing model — consume-buffer persistence + declared-action contract';
    case 'reserved-channel-authority':
      return 'SPEC §4.4 reserved-channel authority';
    case 'schema-version-handshake':
      return 'Protocol #3 version negotiation';
    default:
      return slug;
  }
}

/**
 * Validating narrower from the fixture-JSON `SetupStep` (discriminated
 * on `type`) to the host's runtime `SetupStep` (discriminated on
 * `kind`). The fixture JSON enters the type system through a
 * compile-time cast (tsc widens JSON-module string literals), so the
 * static union cannot be trusted at runtime — every directive is
 * re-validated structurally here.
 *
 * The setup vocabulary is CLOSED: an unknown or malformed directive is
 * a fixture-authoring error, thrown with a descriptive message. It is
 * never mapped to a skip or a fail — those verdicts describe the
 * implementation under test, not the fixture catalog.
 *
 * The input is `unknown` by design — this function IS the trust
 * boundary, so it never leans on the static union it produces
 * evidence for.
 *
 * Exported for unit tests; not part of the package's public API.
 */
export function parseSetupStep(fixtureName: string, step: unknown): HostSetupStep {
  if (!isRecord(step) || typeof step['type'] !== 'string') {
    throw new Error(
      `protocol-conformance: fixture '${fixtureName}' authors a malformed setup directive — expected an object with a string 'type'. Received: ${JSON.stringify(step)}`,
    );
  }
  const type = step['type'];
  if (type === 'create-session') {
    const sessionId = requireStringField(fixtureName, type, step, 'sessionId');
    const appId = step['appId'];
    if (appId !== undefined && typeof appId !== 'string') {
      throw malformedDirective(fixtureName, type, step, "'appId' must be a string when present");
    }
    const actionSpec = step['actionSpec'];
    if (actionSpec !== undefined && !isActionSpecDecl(actionSpec)) {
      throw malformedDirective(
        fixtureName,
        type,
        step,
        "'actionSpec' must be an object mapping action names to entry objects when present",
      );
    }
    return {
      kind: 'create-session',
      sessionId,
      ...(appId !== undefined ? { appId } : {}),
      ...(actionSpec !== undefined ? { actionSpec } : {}),
    };
  }
  if (type === 'renderer-url-override') {
    return {
      kind: 'renderer-url-override',
      sessionId: requireStringField(fixtureName, type, step, 'sessionId'),
      url: requireStringField(fixtureName, type, step, 'url'),
    };
  }
  if (type === 'server-version-override') {
    return {
      kind: 'server-version-override',
      sessionId: requireStringField(fixtureName, type, step, 'sessionId'),
      advertiseVersion: requireStringField(fixtureName, type, step, 'advertiseVersion'),
    };
  }
  if (type === 'ui-initialize-response-override') {
    const sessionId = requireStringField(fixtureName, type, step, 'sessionId');
    if (!('override' in step)) {
      throw malformedDirective(fixtureName, type, step, "missing the 'override' response body");
    }
    return { kind: 'ui-initialize-response-override', sessionId, override: step['override'] };
  }
  if (type === 'emit-envelope') {
    const channel = requireStringField(fixtureName, type, step, 'channel');
    if (!('payload' in step)) {
      throw malformedDirective(fixtureName, type, step, "missing the 'payload' envelope body");
    }
    return { kind: 'emit-envelope', channel, payload: step['payload'] };
  }
  throw new Error(
    `protocol-conformance: fixture '${fixtureName}' authors unknown setup directive type='${type}'. The setup vocabulary is closed; known directives: create-session, renderer-url-override, server-version-override, ui-initialize-response-override, emit-envelope.`,
  );
}

/**
 * Teardown counterpart of {@link parseSetupStep}. The teardown
 * vocabulary is empty in this kit version (renders decay via TTL), so
 * ANY authored teardown directive is a fixture-authoring error.
 */
function parseTeardownStep(fixtureName: string, step: unknown): HostTeardownStep {
  throw new Error(
    `protocol-conformance: fixture '${fixtureName}' authors a teardown directive, but this kit version defines no teardown vocabulary (renders decay via TTL). Received: ${JSON.stringify(step)}`,
  );
}

function requireStringField(
  fixtureName: string,
  directiveType: string,
  step: Record<string, unknown>,
  field: string,
): string {
  const value = step[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw malformedDirective(
      fixtureName,
      directiveType,
      step,
      `'${field}' must be a non-empty string`,
    );
  }
  return value;
}

function malformedDirective(
  fixtureName: string,
  directiveType: string,
  step: Record<string, unknown>,
  problem: string,
): Error {
  return new Error(
    `protocol-conformance: fixture '${fixtureName}' authors a malformed '${directiveType}' setup directive — ${problem}. Received: ${JSON.stringify(step)}`,
  );
}

/** Validating narrower for `CreateGguiSessionStep.actionSpec`. */
function isActionSpecDecl(
  value: unknown,
): value is Readonly<Record<string, ActionSpecEntryDecl>> {
  return isRecord(value) && Object.values(value).every((entry) => isRecord(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Re-export the narrowed union types for callers building custom
// reporters.
export type { StreamUpdateBehavior, VersionMismatchBehavior };
