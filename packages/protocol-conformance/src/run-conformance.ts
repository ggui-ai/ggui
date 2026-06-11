/**
 * `runConformance()` — drive every fixture in the catalog against a
 * live implementation and return a pass / fail / skip scorecard.
 *
 * Orchestration:
 *   1. Invoke `reporter.onStart(totalFixtures)`.
 *   2. For each fixture (filtered by `config.only` if provided):
 *      a. If `fixture.skipReason !== null` → skip with the reason.
 *      b. Validate every authored setup/teardown directive against
 *         the closed `SetupStep` vocabulary (`parseSetupStep`), the
 *         authored `inputEnvelope` against the closed input-
 *         envelope dispatch vocabulary (`parseInputEnvelope`), and
 *         the authored `subscribe` shaping against the closed
 *         `SubscribeFrameShaping` vocabulary
 *         (`parseSubscribeShaping`). Unknown / malformed directives
 *         are fixture-authoring errors — the runner throws, aborting
 *         the run loudly (NOT a skip, NOT a fail of the
 *         implementation under test).
 *      c. If `fixture.setup` non-empty AND `config.host` absent →
 *         skip with "no host provided".
 *      d. Dispatch every setup step via `host.dispatchSetup()`.
 *         Throw → skip with the error message (NOT a fail).
 *      e. Open a WS transport against `config.serverUrl`.
 *      f. Send the canonical `subscribe` frame (the runner knows the
 *         wire shape — fixture's `inputEnvelope` is NOT the subscribe
 *         frame; subscribe is always runner-owned), shaped by the
 *         fixture's validated `subscribe` knob (`omitAppId`,
 *         `supportedVersions` with the `'current'` sentinel resolved
 *         to the kit's compiled `PROTOCOL_SCHEMA_VERSION`).
 *      g. If the fixture's `inputEnvelope` is a dispatchable C→S
 *         frame (`action` live-channel dispatch, or
 *         `host_context_observed` — the validated typed arm), send
 *         it AFTER subscribe.
 *      h. Observe frames for `config.observationTimeoutMs` (default
 *         2000ms).
 *      i. Match observed frames against `fixture.expectedBehavior` —
 *         EXCEPT `session-state`, a stateful obligation with no wire
 *         response: the runner grades it after the observation window
 *         by reading the GguiSession field back via
 *         `host.readSessionField()` (`matchSessionState`). Absent
 *         host / absent method / a throwing read → skip-with-reason,
 *         never a weakened pass.
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
import { PROTOCOL_SCHEMA_VERSION } from '@ggui-ai/protocol';
import type {
  HostContextObservedPayload,
  HostContextProjection,
  McpUiDisplayMode,
} from '@ggui-ai/protocol';

import { allFixtures, fixturesByContract } from './fixtures/index.js';
import type {
  ConformanceHost,
  SetupStep as HostSetupStep,
  TeardownStep as HostTeardownStep,
} from './conformance-host.js';
import { isRecord } from '@ggui-ai/protocol';
import { behaviorIs, deepEqual, matchBehavior, type MatchResult } from './match-behavior.js';
import type {
  ActionSpecEntryDecl,
  AuthConfig,
  JsonSchemaDecl,
  SessionStateBehavior,
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
  // parse throws a descriptive error that aborts the whole run. The
  // input envelope goes through the same gate: a malformed
  // `host_context_observed` frame is a fixture-authoring error, never
  // a verdict on the server.
  const setupSteps = fixture.setup.map((step) => parseSetupStep(fixture.name, step));
  const teardownSteps: readonly HostTeardownStep[] = (fixture.teardown ?? []).map((step) =>
    parseTeardownStep(fixture.name, step),
  );
  const inputDispatch = parseInputEnvelope(fixture.name, fixture.inputEnvelope);
  const subscribeShaping = parseSubscribeShaping(fixture.name, fixture.subscribe);

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
    // `subscribe` (SubscribeFrameShaping, validated above) shapes the
    // runner-owned frame: `omitAppId` drops the conventional
    // `appId: 'conformance'` stamp — the probe for SPEC §12.2's
    // identity-default resolution — and `supportedVersions` declares
    // the client half of §12.2.2's version handshake (the `'current'`
    // sentinel already resolved to the kit's compiled
    // PROTOCOL_SCHEMA_VERSION).
    transport.send({
      type: 'subscribe',
      payload: {
        sessionId,
        ...(subscribeShaping.omitAppId ? {} : { appId: 'conformance' }),
        role: 'user',
        ...(subscribeShaping.supportedVersions !== undefined
          ? { supportedVersions: subscribeShaping.supportedVersions }
          : {}),
      },
      requestId: `conformance-subscribe-${fixture.name}`,
    });

    if (inputDispatch.kind !== 'none') {
      transport.send(inputDispatch.envelope);
    }

    const frames = await transport.observe({
      timeoutMs: config.observationTimeoutMs ?? 2000,
    });

    // `session-state` is a stateful obligation — the input message
    // produced no wire response, so the grade is a post-observation-
    // window read-back of the GguiSession field via the host, not a
    // frame match. Every other behavior kind grades against observed
    // frames. (`behaviorIs` narrows to the specific arm — the
    // extensibly-closed `UnknownBehavior` in the union has
    // `kind: string & {}` which defeats bare literal narrowing.)
    const expectedBehavior = fixture.expectedBehavior;
    const match: MatchResult = behaviorIs(expectedBehavior, 'session-state')
      ? await matchSessionState(expectedBehavior, sessionId, config.host)
      : matchBehavior(expectedBehavior, frames);

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

// =============================================================================
// Input-envelope dispatch vocabulary
// =============================================================================

/**
 * Fixture-authored `host_context_observed` Client→Server frame — the
 * wire shape from `@ggui-ai/protocol` (`transport/websocket`):
 * `{type: 'host_context_observed', payload: {sessionId, hostContext}}`.
 * The iframe-runtime emits it after `ui/initialize` resolves (and on
 * every `host-context-changed` notification); the server's obligation
 * is to persist `payload.hostContext` onto `GguiSession.hostContext`
 * with no synchronous response — which is why fixtures authoring this
 * envelope pair it with a `session-state` expectation, not a frame
 * expectation.
 */
export interface HostContextObservedInputEnvelope {
  readonly type: 'host_context_observed';
  readonly requestId?: string;
  readonly payload: HostContextObservedPayload;
}

/**
 * Classification of a fixture's `inputEnvelope` into the CLOSED
 * dispatch vocabulary — exactly the C→S frame types the shipped
 * fixture catalog authors for explicit post-subscribe dispatch.
 *
 *   - `action` — the live-channel action dispatch shape, sent
 *     VERBATIM. Deliberately untyped beyond the discriminator: action
 *     fixtures may author adversarial payloads (undeclared action
 *     names, malformed bodies) precisely because the server's
 *     rejection path is what's under test — the kit MUST NOT
 *     pre-validate away the inputs the contract is graded on.
 *   - `host_context_observed` — the validated typed arm
 *     ({@link HostContextObservedInputEnvelope}). The kit authors this
 *     frame as a well-formed client, so a malformed one is a
 *     fixture-authoring error, not a server probe.
 *   - `none` — every other authored envelope (`render`, `handshake`,
 *     `props-update`) is driven by the subscribe itself or by a
 *     Path-B host harness; the explicit send is skipped.
 */
export type InputEnvelopeDispatch =
  | { readonly kind: 'action'; readonly envelope: unknown }
  | {
      readonly kind: 'host_context_observed';
      readonly envelope: HostContextObservedInputEnvelope;
    }
  | { readonly kind: 'none' };

/**
 * Validating classifier for the fixture's `inputEnvelope`. The fixture
 * JSON enters the type system through a compile-time cast, so —
 * exactly like {@link parseSetupStep} — the dispatchable arms are
 * re-validated structurally here, and a malformed
 * `host_context_observed` frame throws a descriptive fixture-authoring
 * error (never a skip, never a fail of the implementation under test).
 *
 * Exported for unit tests; not part of the package's public API.
 */
export function parseInputEnvelope(
  fixtureName: string,
  envelope: unknown,
): InputEnvelopeDispatch {
  if (!isRecord(envelope) || typeof envelope['type'] !== 'string') {
    return { kind: 'none' };
  }
  if (envelope['type'] === 'action') {
    return { kind: 'action', envelope };
  }
  if (envelope['type'] === 'host_context_observed') {
    return {
      kind: 'host_context_observed',
      envelope: parseHostContextObservedEnvelope(fixtureName, envelope),
    };
  }
  return { kind: 'none' };
}

function parseHostContextObservedEnvelope(
  fixtureName: string,
  envelope: Record<string, unknown>,
): HostContextObservedInputEnvelope {
  const requestId = envelope['requestId'];
  if (requestId !== undefined && typeof requestId !== 'string') {
    throw malformedInputEnvelope(
      fixtureName,
      "'requestId' must be a string when present",
      envelope,
    );
  }
  const payload = envelope['payload'];
  if (!isRecord(payload)) {
    throw malformedInputEnvelope(
      fixtureName,
      "'payload' must be an object carrying {sessionId, hostContext}",
      envelope,
    );
  }
  const sessionId = payload['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw malformedInputEnvelope(
      fixtureName,
      "'payload.sessionId' must be a non-empty string",
      envelope,
    );
  }
  const hostContext = parseHostContextProjection(fixtureName, payload['hostContext'], envelope);
  return {
    type: 'host_context_observed',
    ...(requestId !== undefined ? { requestId } : {}),
    payload: { sessionId, hostContext },
  };
}

/**
 * Validating narrower for the authored `hostContext` body against the
 * live `HostContextProjection` (`@ggui-ai/protocol`,
 * `types/host-context`). Every field is optional, so presence is never
 * required — but a present field MUST carry the projection's shape,
 * and unknown keys are REJECTED: a key outside the projection (e.g. a
 * stale `theme` — theme flows through ggui's theming pipeline, not
 * host context) is state no conformant server is obligated to read
 * back, which would make the paired `session-state` grade dishonest.
 */
function parseHostContextProjection(
  fixtureName: string,
  value: unknown,
  envelope: Record<string, unknown>,
): HostContextProjection {
  if (!isRecord(value)) {
    throw malformedInputEnvelope(
      fixtureName,
      "'payload.hostContext' must be an object (the HostContextProjection wire shape)",
      envelope,
    );
  }
  const out: { -readonly [K in keyof HostContextProjection]: HostContextProjection[K] } = {};
  for (const [key, field] of Object.entries(value)) {
    switch (key) {
      case 'availableDisplayModes': {
        if (!Array.isArray(field)) {
          throw malformedInputEnvelope(
            fixtureName,
            "'hostContext.availableDisplayModes' must be an array of display modes ('inline' | 'fullscreen' | 'pip')",
            envelope,
          );
        }
        const modes: McpUiDisplayMode[] = [];
        for (const item of field) {
          if (!isDisplayMode(item)) {
            throw malformedInputEnvelope(
              fixtureName,
              `'hostContext.availableDisplayModes' carries ${JSON.stringify(item)} — display modes are 'inline' | 'fullscreen' | 'pip'`,
              envelope,
            );
          }
          modes.push(item);
        }
        out.availableDisplayModes = modes;
        break;
      }
      case 'currentDisplayMode': {
        if (!isDisplayMode(field)) {
          throw malformedInputEnvelope(
            fixtureName,
            "'hostContext.currentDisplayMode' must be 'inline' | 'fullscreen' | 'pip'",
            envelope,
          );
        }
        out.currentDisplayMode = field;
        break;
      }
      case 'containerDimensions': {
        if (!isRecord(field)) {
          throw malformedInputEnvelope(
            fixtureName,
            "'hostContext.containerDimensions' must be an object of numeric width/maxWidth/height/maxHeight",
            envelope,
          );
        }
        const dims: {
          width?: number;
          maxWidth?: number;
          height?: number;
          maxHeight?: number;
        } = {};
        for (const [dimKey, dimValue] of Object.entries(field)) {
          if (
            dimKey !== 'width' &&
            dimKey !== 'maxWidth' &&
            dimKey !== 'height' &&
            dimKey !== 'maxHeight'
          ) {
            throw malformedInputEnvelope(
              fixtureName,
              `'hostContext.containerDimensions' carries unknown key '${dimKey}' — the projection knows width, maxWidth, height, maxHeight`,
              envelope,
            );
          }
          if (typeof dimValue !== 'number') {
            throw malformedInputEnvelope(
              fixtureName,
              `'hostContext.containerDimensions.${dimKey}' must be a number`,
              envelope,
            );
          }
          dims[dimKey] = dimValue;
        }
        out.containerDimensions = dims;
        break;
      }
      case 'platform': {
        if (field !== 'web' && field !== 'desktop' && field !== 'mobile') {
          throw malformedInputEnvelope(
            fixtureName,
            "'hostContext.platform' must be 'web' | 'desktop' | 'mobile'",
            envelope,
          );
        }
        out.platform = field;
        break;
      }
      case 'deviceCapabilities': {
        if (!isRecord(field)) {
          throw malformedInputEnvelope(
            fixtureName,
            "'hostContext.deviceCapabilities' must be an object of boolean touch/hover",
            envelope,
          );
        }
        const caps: { touch?: boolean; hover?: boolean } = {};
        for (const [capKey, capValue] of Object.entries(field)) {
          if (capKey !== 'touch' && capKey !== 'hover') {
            throw malformedInputEnvelope(
              fixtureName,
              `'hostContext.deviceCapabilities' carries unknown key '${capKey}' — the projection knows touch, hover`,
              envelope,
            );
          }
          if (typeof capValue !== 'boolean') {
            throw malformedInputEnvelope(
              fixtureName,
              `'hostContext.deviceCapabilities.${capKey}' must be a boolean`,
              envelope,
            );
          }
          caps[capKey] = capValue;
        }
        out.deviceCapabilities = caps;
        break;
      }
      case 'locale': {
        if (typeof field !== 'string' || field.length === 0) {
          throw malformedInputEnvelope(
            fixtureName,
            "'hostContext.locale' must be a non-empty string",
            envelope,
          );
        }
        out.locale = field;
        break;
      }
      case 'timeZone': {
        if (typeof field !== 'string' || field.length === 0) {
          throw malformedInputEnvelope(
            fixtureName,
            "'hostContext.timeZone' must be a non-empty string",
            envelope,
          );
        }
        out.timeZone = field;
        break;
      }
      default:
        throw malformedInputEnvelope(
          fixtureName,
          `'hostContext' carries unknown key '${key}' — the HostContextProjection vocabulary is availableDisplayModes, currentDisplayMode, containerDimensions, platform, deviceCapabilities, locale, timeZone`,
          envelope,
        );
    }
  }
  return out;
}

function isDisplayMode(value: unknown): value is McpUiDisplayMode {
  return value === 'inline' || value === 'fullscreen' || value === 'pip';
}

function malformedInputEnvelope(
  fixtureName: string,
  problem: string,
  envelope: Record<string, unknown>,
): Error {
  return new Error(
    `protocol-conformance: fixture '${fixtureName}' authors a malformed 'host_context_observed' input envelope — ${problem}. Received: ${JSON.stringify(envelope)}`,
  );
}

// =============================================================================
// Session-state grading (the kit's third grading mechanism)
// =============================================================================

/**
 * Grade a `session-state` expectation — the input message left no wire
 * trace, so the honest verdict is a post-observation-window read-back
 * of the mutated GguiSession field via
 * {@link ConformanceHost.readSessionField}, compared with the SAME
 * exact {@link deepEqual} the frame matchers use.
 *
 * A missing host, a host without `readSessionField`, or a read that
 * throws all yield `unmatchable-on-ws` — the runner records a SKIP
 * with the reason. The kit refuses to grade a stateful obligation it
 * has no introspection seam for (a host that cannot read state cannot
 * grade it); it never converts that gap into a pass or a fail.
 *
 * Exported for unit tests; not part of the package's public API.
 */
export async function matchSessionState(
  behavior: SessionStateBehavior,
  sessionId: string,
  host: ConformanceHost | undefined,
): Promise<MatchResult> {
  if (host === undefined || host.readSessionField === undefined) {
    return {
      kind: 'unmatchable-on-ws',
      reason:
        host === undefined
          ? 'session-state expectation needs a ConformanceHost with readSessionField() — no host was provided.'
          : 'session-state expectation needs ConformanceHost.readSessionField() — the provided host does not implement it, so the kit cannot observe the GguiSession-field mutation. SKIP, not a pass.',
    };
  }
  let actual: unknown;
  try {
    actual = await host.readSessionField(sessionId, behavior.field);
  } catch (err) {
    return {
      kind: 'unmatchable-on-ws',
      reason: `host.readSessionField('${sessionId}', '${behavior.field}') threw — a host that cannot read state cannot grade it: ${String(
        (err as Error).message ?? err,
      )}`,
    };
  }
  if (deepEqual(actual, behavior.expected)) {
    return { kind: 'pass' };
  }
  return {
    kind: 'fail',
    expected: { field: behavior.field, value: behavior.expected },
    received: { field: behavior.field, value: actual },
    message: `session field '${behavior.field}' did not hold the expected value after the input envelope was dispatched — the implementation under test may have dropped the message instead of persisting it.`,
  };
}

/**
 * Resolved, runner-ready form of `SubscribeFrameShaping`: the
 * `'current'` sentinel is already replaced by the kit's compiled
 * `PROTOCOL_SCHEMA_VERSION`, so the subscribe-send site only ever
 * sees a concrete declaration (or none).
 */
export interface ResolvedSubscribeShaping {
  readonly omitAppId: boolean;
  readonly supportedVersions?: readonly string[];
}

/**
 * Validating narrower for the fixture-authored `subscribe` knob
 * (`SubscribeFrameShaping`, types.ts). Same trust-boundary posture as
 * {@link parseSetupStep}: the fixture JSON enters the type system
 * through a compile-time cast, so the shape is re-validated
 * structurally here and any malformed or unknown shaping is a
 * fixture-authoring error the runner throws on — never a skip, never
 * a fail of the implementation under test.
 *
 * The vocabulary is CLOSED — exactly the shaping fields the shipped
 * catalog authors (`omitAppId`, `supportedVersions`); an unknown key
 * is rejected so a typo'd knob can never silently no-op into a
 * vacuous grade. `supportedVersions: 'current'` resolves to
 * `[PROTOCOL_SCHEMA_VERSION]` (the kit's compiled canonical), keeping
 * fixtures evergreen across protocol version bumps.
 *
 * Exported for unit tests; not part of the package's public API.
 */
export function parseSubscribeShaping(
  fixtureName: string,
  shaping: unknown,
): ResolvedSubscribeShaping {
  if (shaping === undefined) return { omitAppId: false };
  if (!isRecord(shaping)) {
    throw malformedSubscribeShaping(
      fixtureName,
      'expected an object carrying the SubscribeFrameShaping fields',
      shaping,
    );
  }
  for (const key of Object.keys(shaping)) {
    if (key !== 'omitAppId' && key !== 'supportedVersions') {
      throw malformedSubscribeShaping(
        fixtureName,
        `unknown key '${key}' — the subscribe-shaping vocabulary is closed: omitAppId, supportedVersions`,
        shaping,
      );
    }
  }
  const omitAppId = shaping['omitAppId'];
  if (omitAppId !== undefined && typeof omitAppId !== 'boolean') {
    throw malformedSubscribeShaping(
      fixtureName,
      "'omitAppId' must be a boolean when present",
      shaping,
    );
  }
  const supportedVersions = parseSupportedVersionsDecl(
    fixtureName,
    shaping,
    shaping['supportedVersions'],
  );
  return {
    omitAppId: omitAppId === true,
    ...(supportedVersions !== undefined ? { supportedVersions } : {}),
  };
}

function parseSupportedVersionsDecl(
  fixtureName: string,
  shaping: Record<string, unknown>,
  decl: unknown,
): readonly string[] | undefined {
  if (decl === undefined) return undefined;
  if (decl === 'current') {
    // The evergreen sentinel — the version this kit release was
    // compiled against, never a stale fixture literal.
    return [PROTOCOL_SCHEMA_VERSION];
  }
  if (
    Array.isArray(decl) &&
    decl.length > 0 &&
    decl.every((version) => typeof version === 'string' && version.length > 0)
  ) {
    return decl;
  }
  throw malformedSubscribeShaping(
    fixtureName,
    "'supportedVersions' must be the sentinel 'current' or a non-empty array of non-empty strings",
    shaping,
  );
}

function malformedSubscribeShaping(
  fixtureName: string,
  problem: string,
  shaping: unknown,
): Error {
  return new Error(
    `protocol-conformance: fixture '${fixtureName}' authors a malformed 'subscribe' frame shaping — ${problem}. Received: ${JSON.stringify(shaping)}`,
  );
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
      return 'Single action-routing model — consume-buffer persistence + declared-action contract (name membership + payload schema)';
    case 'host-context':
      return 'Host-context persistence — host_context_observed MUST persist onto GguiSession.hostContext';
    case 'reserved-channel-authority':
      return 'SPEC §4.4 reserved-channel authority';
    case 'schema-version-handshake':
      return 'Protocol #3 version negotiation';
    case 'subscribe-tenancy':
      return 'SPEC §12.2 subscribe tenancy — appId MUST match the bound app (§12.2.3 APP_MISMATCH)';
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
        "'actionSpec' must be an object mapping action names to entry objects (each entry's optional 'schema' a shape-valid JSON-Schema node) when present",
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

/**
 * Validating narrower for `CreateGguiSessionStep.actionSpec`. Each
 * entry must be an object whose optional `schema` field — when
 * authored — is a shape-valid {@link JsonSchemaDecl} per
 * {@link isJsonSchemaDecl}.
 */
function isActionSpecDecl(
  value: unknown,
): value is Readonly<Record<string, ActionSpecEntryDecl>> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        isRecord(entry) &&
        (entry['schema'] === undefined || isJsonSchemaDecl(entry['schema'])),
    )
  );
}

/** The `type` keyword values the kit's authored JSON-Schema subset names. */
const JSON_SCHEMA_DECL_TYPES: readonly unknown[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
  'null',
];

/**
 * Validating parse for the typed core of {@link JsonSchemaDecl} —
 * recursively checks that every keyword the kit's authored vocabulary
 * names carries the shape the type declares. Keywords outside the
 * typed core pass through verbatim (the implementation under test
 * owns their interpretation), mirroring the index-signature tail on
 * the declared type. A fixture authoring a malformed schema node is a
 * fixture-authoring error the runner throws on — never a skip or a
 * fail of the implementation under test.
 */
function isJsonSchemaDecl(value: unknown): value is JsonSchemaDecl {
  if (!isRecord(value)) return false;
  if (value['type'] !== undefined && !JSON_SCHEMA_DECL_TYPES.includes(value['type'])) {
    return false;
  }
  if (value['description'] !== undefined && typeof value['description'] !== 'string') {
    return false;
  }
  if (value['enum'] !== undefined && !Array.isArray(value['enum'])) return false;
  if (value['items'] !== undefined && !isJsonSchemaDecl(value['items'])) return false;
  const properties = value['properties'];
  if (properties !== undefined) {
    if (!isRecord(properties)) return false;
    if (!Object.values(properties).every(isJsonSchemaDecl)) return false;
  }
  const required = value['required'];
  if (
    required !== undefined &&
    !(Array.isArray(required) && required.every((name) => typeof name === 'string'))
  ) {
    return false;
  }
  const additionalProperties = value['additionalProperties'];
  if (
    additionalProperties !== undefined &&
    typeof additionalProperties !== 'boolean' &&
    !isJsonSchemaDecl(additionalProperties)
  ) {
    return false;
  }
  return true;
}

// Re-export the narrowed union types for callers building custom
// reporters.
export type { StreamUpdateBehavior, VersionMismatchBehavior };
