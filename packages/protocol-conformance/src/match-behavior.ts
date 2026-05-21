/**
 * Match observed WS frames against a fixture's {@link ExpectedBehavior}.
 *
 * Each matcher is pure — it consumes a read-only array of frames the
 * runner collected from the transport and returns either a pass or a
 * {@link MatchFailure} the runner lifts into a
 * {@link ConformanceFailure}. No side-effects, no hidden state — the
 * runner owns orchestration.
 *
 * ## Path-A vs Path-B partition
 *
 * The kit's behavior vocabulary spans both wire-observable claims (the
 * subscribe ack, contract-error envelopes on reserved channels, stream
 * updates) AND surface-observable claims (DOM state after a props
 * update, browser-side bootstrap failure modes). This file matches the
 * **Path-A** subset — the wire-observable behaviors a runner can
 * assert from frames alone, with no MCP-Apps-host adapter and no
 * Playwright page. The Path-B subset (browser-host harness) is
 * inherently NOT WS-reducible: bootstrap-failure modes are caused by
 * the renderer-bundle fetch + `ui/initialize` round-trip the host
 * speaks over postMessage; props-update assertions are assertions on
 * the rendered DOM the renderer paints, not on WS frames the server
 * emits. For these kinds we return `unmatchable-on-ws` with a sharp
 * reason and the runner records SKIP — they are NOT failures of the
 * server, they are claims a different driver must drive.
 *
 * The Path-B driver is a separate Playwright-based test suite — it
 * picks up the `bootstrap-failure` fixtures and asserts on the
 * iframe-host's `data-ggui-console-iframe-error` pane after
 * route-based fault injection. A future packaged browser-host adapter
 * will fold that capability into the kit so third-party adopters
 * don't have to reimplement it. Until then, the partition is honest:
 * Path A handles wire claims, Path B (out-of-process) handles
 * browser claims, and `unmatchable-on-ws` is the partition seam.
 *
 * v1 Path-A scope:
 *
 *   - `bootstrap-success` — subscribe produced an `ack` frame.
 *   - `version-mismatch` — subscribe produced an `error` frame with
 *     `code: 'UPGRADE_REQUIRED'`.
 *   - `contract-error`  — stream frame on `_ggui:contract-error`
 *     channel matches `code` + `toolName` (+ optional `actionName` +
 *     `sourceAction`).
 *   - `stream-update`   — stream frame on named channel matches
 *     declared value.
 *   - `no-op`           — no frames observed after input dispatch.
 *   - `observability-event` — see below.
 *
 * v1 Path-B-only kinds (return `unmatchable-on-ws`):
 *
 *   - `bootstrap-failure` — the fault surface lives in the host's
 *     bootstrap-fetch + `ui/initialize` round-trip; the fixture's
 *     `renderer-url-override` / `ui-initialize-response-override`
 *     setup directives are MCP-Apps-host concerns, not WS server
 *     concerns. The reference server's host adapter correctly throws
 *     "out of scope" on these directives — that's not a bug, it's
 *     the partition being respected.
 *   - `props-update` — the assertion is on rendered DOM after the
 *     server emits a `_ggui:props` frame; matchable on WS only as
 *     "frame was emitted", not as "DOM reflects it" — and the fixture
 *     vocabulary asserts the latter.
 *
 * ## `observability-event` — WS-evidence matcher
 *
 * The ggui protocol bar mandates that observability events follow
 * from WS-observable evidence. The bar's claim is "any conformant host
 * MUST emit `wired-tool-invoked` when the WS observes a wired-action's
 * tool dispatch + result frame; any conformant host MUST emit
 * `contract-error-emitted` when the WS observes a `_ggui:contract-
 * error` envelope." So a Path-A pass on an `observability-event`
 * fixture is the kit certifying "WS evidence the bar mandates a host
 * mirror-emission for is present" — a true vendor-neutral conformance
 * claim, not a renderer-internal probe.
 *
 * Two recognized event arms (extensibly closed via `(string & {})`):
 *
 *   - `wired-tool-invoked` — assert a `stream` frame on the
 *     `_ggui:wired-tool-invoked` channel carrying
 *     `value: {toolName, actionName?}` matching `event.toolName`
 *     (+ optional `event.actionName`). The reference server emits
 *     this signal from `action-router.ts::dispatchAction()` after a
 *     successful handler resolution — every conformant host MUST
 *     produce equivalent WS evidence (or a richer mirror-emission a
 *     Path-B browser host can observe).
 *
 *   - `contract-error-emitted` — assert a `stream` frame on the
 *     `_ggui:contract-error` channel whose canonical SPEC §4.4
 *     `ContractErrorPayload` carries `error.code === event.code` and
 *     `toolName === event.toolName` (+ optional `event.actionName`).
 *     This is the SAME frame {@link matchContractError} matches; the
 *     observability arm asserts the bar's "every live-channel envelope
 *     becomes an observability event" mirror without requiring a
 *     postMessage-capture harness.
 *
 * Other arms (`schema-version-mismatch`, `subscribe-failed`,
 * future `(string & {})` tails) the matcher cannot ground in current
 * WS evidence — return `unmatchable-on-ws` with a sharp reason so the
 * runner records SKIP, not FAIL. These are Path-B candidates for the
 * future browser-host adapter.
 */
import type {
  BootstrapSuccessBehavior,
  ContractErrorBehavior,
  ExpectedBehavior,
  ExpectedObservabilityEvent,
  NoOpBehavior,
  ObservabilityBehavior,
  StreamUpdateBehavior,
  VersionMismatchBehavior,
} from './types.js';
import type { ObservedFrame } from './ws-transport.js';

/**
 * Matcher outcome. `pass` → the fixture's assertion is satisfied.
 * `fail` → wire-level mismatch; the runner records a
 * {@link ConformanceFailure}. `unmatchable-on-ws` → this behavior is
 * not drivable over pure WS; the runner records a skip.
 */
export type MatchResult =
  | { readonly kind: 'pass' }
  | {
      readonly kind: 'fail';
      readonly expected: unknown;
      readonly received: unknown;
      readonly message: string;
    }
  | { readonly kind: 'unmatchable-on-ws'; readonly reason: string };

export function matchBehavior(
  behavior: ExpectedBehavior,
  frames: readonly ObservedFrame[],
): MatchResult {
  // Dispatch on the `kind` discriminator with explicit casts because
  // the extensibly-closed `UnknownBehavior` (`kind: string & {}`) in
  // the union widens the discriminant, preventing TS from narrowing
  // on literals. We checked the literal above — the cast is sound.
  if (behavior.kind === 'bootstrap-success') {
    return matchBootstrapSuccess(behavior as BootstrapSuccessBehavior, frames);
  }
  if (behavior.kind === 'version-mismatch') {
    return matchVersionMismatch(behavior as VersionMismatchBehavior, frames);
  }
  if (behavior.kind === 'contract-error') {
    return matchContractError(behavior as ContractErrorBehavior, frames);
  }
  if (behavior.kind === 'stream-update') {
    return matchStreamUpdate(behavior as StreamUpdateBehavior, frames);
  }
  if (behavior.kind === 'no-op') {
    return matchNoOp(behavior as NoOpBehavior, frames);
  }
  if (behavior.kind === 'bootstrap-failure') {
    return {
      kind: 'unmatchable-on-ws',
      reason:
        'bootstrap-failure is a Path-B (browser-host) claim — the fault surface is the host\'s bootstrap-fetch + `ui/initialize` postMessage round-trip, not a WS frame the server emits. The `renderer-url-override` / `ui-initialize-response-override` setup directives are MCP-Apps-host concerns; the reference server\'s host adapter throws "out of scope" on them by design. Drive these fixtures via a Path-B browser-host harness (today: Slice M Playwright dispatch in `e2e/ggui-oss/tests/mcp-app-iframe.spec.ts`; future: packaged Phase-3.2 adapter inside the kit).',
    };
  }
  if (behavior.kind === 'observability-event') {
    return matchObservabilityEvent(behavior as ObservabilityBehavior, frames);
  }
  if (behavior.kind === 'props-update') {
    return {
      kind: 'unmatchable-on-ws',
      reason:
        'props-update is a Path-B (browser-host) claim — the assertion is on rendered DOM (selector + attribute/text), not on the `_ggui:props` WS frame in isolation. Matchable on WS only as "frame was emitted"; the fixture vocabulary asserts "DOM reflects the update". Drive via a Path-B browser-host harness (today: Slice M Playwright dispatch in `e2e/ggui-oss/tests/mcp-app-iframe.spec.ts`; future: packaged Phase-3.2 adapter inside the kit).',
    };
  }
  // Extensibly-closed union catch — unknown `kind` = new fixture
  // vocabulary the runner doesn't recognize; skip cleanly.
  return {
    kind: 'unmatchable-on-ws',
    reason: `Unknown expectedBehavior.kind='${(behavior as { readonly kind: string }).kind}' — kit runner does not recognize this behavior. Check kit version.`,
  };
}

// =============================================================================
// Per-behavior matchers
// =============================================================================

function matchBootstrapSuccess(
  _behavior: BootstrapSuccessBehavior,
  frames: readonly ObservedFrame[],
): MatchResult {
  const ack = frames.find(
    (f) => f.kind === 'frame' && f.parsed['type'] === 'ack',
  );
  if (ack === undefined) {
    return {
      kind: 'fail',
      expected: { type: 'ack' },
      received: frames.map((f) => (f.kind === 'frame' ? f.parsed['type'] : 'unparseable')),
      message:
        'expected an `ack` frame after subscribe; received none within the observation window.',
    };
  }
  // If an error frame arrived BEFORE the ack, that's a bootstrap
  // failure we misclassified — surface it explicitly.
  const error = frames.find(
    (f) => f.kind === 'frame' && f.parsed['type'] === 'error',
  );
  if (error !== undefined) {
    return {
      kind: 'fail',
      expected: { type: 'ack', precededByError: false },
      received: { errorFrame: error.kind === 'frame' ? error.parsed : error },
      message:
        'expected bootstrap-success but received an error frame — the subscribe was rejected.',
    };
  }
  return { kind: 'pass' };
}

function matchVersionMismatch(
  behavior: VersionMismatchBehavior,
  frames: readonly ObservedFrame[],
): MatchResult {
  const error = frames.find(
    (f) =>
      f.kind === 'frame' &&
      f.parsed['type'] === 'error' &&
      isRecord(f.parsed['payload']) &&
      f.parsed['payload']['code'] === 'UPGRADE_REQUIRED',
  );
  if (error === undefined) {
    return {
      kind: 'fail',
      expected: {
        type: 'error',
        payload: { code: 'UPGRADE_REQUIRED' },
        serverVersion: behavior.serverVersion,
      },
      received: frames.map((f) => (f.kind === 'frame' ? f.parsed : f)),
      message:
        'expected an `error` frame with `payload.code === UPGRADE_REQUIRED` after subscribe; received none.',
    };
  }
  return { kind: 'pass' };
}

function matchContractError(
  behavior: ContractErrorBehavior,
  frames: readonly ObservedFrame[],
): MatchResult {
  const candidates = frames.filter(
    (f) =>
      f.kind === 'frame' &&
      f.parsed['type'] === 'stream' &&
      isRecord(f.parsed['payload']) &&
      f.parsed['payload']['channel'] === '_ggui:contract-error',
  );
  if (candidates.length === 0) {
    return {
      kind: 'fail',
      expected: {
        channel: '_ggui:contract-error',
        code: behavior.code,
        toolName: behavior.toolName,
      },
      received: frames.map((f) => (f.kind === 'frame' ? f.parsed : f)),
      message:
        'expected a `stream` frame on the `_ggui:contract-error` reserved channel; none observed.',
    };
  }
  // Check at least one candidate carries the expected code + tool.
  //
  // Canonical shape per SPEC §4.4 `ContractErrorPayload`: `code` is
  // NESTED under `value.error.code`, alongside `value.error.message`
  // and `value.error.causedBy`. `toolName` / `actionName` /
  // `sourceAction` / `timestamp` live at the top of `value`. The
  // matcher reads the canonical shape exclusively — the reference
  // server (and `@ggui-ai/mcp-server`'s router) emits via
  // `makeContractErrorPayload`, which is the authoritative builder.
  // Any producer emitting a flat `code` field is a spec violation and
  // will correctly fail this match — that's the point of Protocol #5
  // (named failure modes) being assertable.
  const match = candidates.find((f) => {
    if (f.kind !== 'frame') return false;
    const payload = f.parsed['payload'];
    if (!isRecord(payload)) return false;
    const value = payload['value'];
    if (!isRecord(value)) return false;
    const error = value['error'];
    if (!isRecord(error)) return false;
    if (error['code'] !== behavior.code) return false;
    if (value['toolName'] !== behavior.toolName) return false;
    if (
      behavior.actionName !== undefined &&
      value['actionName'] !== behavior.actionName
    ) {
      return false;
    }
    if (behavior.sourceAction !== undefined) {
      const source = value['sourceAction'];
      const sourceType = isRecord(source) ? source['type'] : source;
      if (sourceType !== behavior.sourceAction) return false;
    }
    return true;
  });
  if (match === undefined) {
    return {
      kind: 'fail',
      expected: {
        code: behavior.code,
        toolName: behavior.toolName,
        actionName: behavior.actionName,
        sourceAction: behavior.sourceAction,
      },
      received: candidates.map((f) => (f.kind === 'frame' ? f.parsed : f)),
      message:
        '`_ggui:contract-error` frame observed but payload did not match the expected code/tool/action triple.',
    };
  }
  return { kind: 'pass' };
}

function matchStreamUpdate(
  behavior: StreamUpdateBehavior,
  frames: readonly ObservedFrame[],
): MatchResult {
  const match = frames.find(
    (f) =>
      f.kind === 'frame' &&
      f.parsed['type'] === 'stream' &&
      isRecord(f.parsed['payload']) &&
      f.parsed['payload']['channel'] === behavior.channel &&
      deepEqual(f.parsed['payload']['value'], behavior.value),
  );
  if (match === undefined) {
    return {
      kind: 'fail',
      expected: { channel: behavior.channel, value: behavior.value },
      received: frames
        .filter((f) => f.kind === 'frame' && f.parsed['type'] === 'stream')
        .map((f) => (f.kind === 'frame' ? f.parsed['payload'] : f)),
      message: `expected a \`stream\` frame on channel '${behavior.channel}' with the declared value shape; none matched.`,
    };
  }
  return { kind: 'pass' };
}

function matchNoOp(
  behavior: NoOpBehavior,
  frames: readonly ObservedFrame[],
): MatchResult {
  // Exclude the initial `ack` (subscribe always produces one) — the
  // no-op claim is about frames observed AFTER input dispatch, which
  // the runner collects starting post-subscribe. If the runner is
  // correctly collecting post-input frames, `ack` never appears here
  // anyway, but double-filtering guards against caller bugs.
  const interesting = frames.filter(
    (f) => f.kind !== 'frame' || f.parsed['type'] !== 'ack',
  );
  if (interesting.length > 0) {
    return {
      kind: 'fail',
      expected: { frames: [] },
      received: interesting.map((f) => (f.kind === 'frame' ? f.parsed : f)),
      message: `no-op behavior expected silence after input dispatch; observed ${interesting.length} frame(s). Reason given: ${behavior.reason}`,
    };
  }
  return { kind: 'pass' };
}

/**
 * Match an observability-event behavior against WS evidence the
 * protocol-and-contract bar mandates a conformant host mirror-emit on.
 *
 * Two arms are matchable on pure WS today; everything else returns
 * `unmatchable-on-ws` with a sharp reason — see the file-level
 * docstring for the rationale.
 */
function matchObservabilityEvent(
  behavior: ObservabilityBehavior,
  frames: readonly ObservedFrame[],
): MatchResult {
  const { event } = behavior;
  if (event.kind === 'wired-tool-invoked') {
    return matchWiredToolInvoked(event, frames);
  }
  if (event.kind === 'contract-error-emitted') {
    return matchContractErrorEmitted(event, frames);
  }
  return {
    kind: 'unmatchable-on-ws',
    reason: `observability-event of kind '${event.kind}' is a Path-B (browser-host) claim — not grounded in WS-observable evidence by the kit's matcher. Drive via a Path-B browser-host harness (today: \`page.exposeBinding\` in spec-side dispatch; future: packaged Phase-3.2 adapter inside the kit).`,
  };
}

/**
 * `wired-tool-invoked` — the WS evidence is a `stream` frame on the
 * canonical `_ggui:wired-tool-invoked` channel carrying
 * `value: {toolName, actionName?}`. The reference server's
 * `action-router.ts::dispatchAction()` emits this after a successful
 * handler resolution; the bar mandates equivalent WS evidence from any
 * conformant host on the wired-tool-invoked path.
 */
function matchWiredToolInvoked(
  event: ExpectedObservabilityEvent,
  frames: readonly ObservedFrame[],
): MatchResult {
  if (event.toolName === undefined) {
    return {
      kind: 'fail',
      expected: { kind: 'wired-tool-invoked', toolName: '<required>' },
      received: { event },
      message:
        'observability-event of kind `wired-tool-invoked` MUST declare `toolName` for the matcher to assert against; fixture is under-specified.',
    };
  }
  const candidates = frames.filter(
    (f) =>
      f.kind === 'frame' &&
      f.parsed['type'] === 'stream' &&
      isRecord(f.parsed['payload']) &&
      f.parsed['payload']['channel'] === '_ggui:wired-tool-invoked',
  );
  if (candidates.length === 0) {
    return {
      kind: 'fail',
      expected: {
        channel: '_ggui:wired-tool-invoked',
        value: { toolName: event.toolName, actionName: event.actionName },
      },
      received: frames.map((f) => (f.kind === 'frame' ? f.parsed : f)),
      message:
        'expected a `stream` frame on `_ggui:wired-tool-invoked` (the WS-observable evidence the protocol bar mandates a conformant host mirror-emit `wired-tool-invoked` on); none observed.',
    };
  }
  const match = candidates.find((f) => {
    if (f.kind !== 'frame') return false;
    const payload = f.parsed['payload'];
    if (!isRecord(payload)) return false;
    const value = payload['value'];
    if (!isRecord(value)) return false;
    if (value['toolName'] !== event.toolName) return false;
    if (
      event.actionName !== undefined &&
      value['actionName'] !== event.actionName
    ) {
      return false;
    }
    return true;
  });
  if (match === undefined) {
    return {
      kind: 'fail',
      expected: {
        channel: '_ggui:wired-tool-invoked',
        value: { toolName: event.toolName, actionName: event.actionName },
      },
      received: candidates.map((f) => (f.kind === 'frame' ? f.parsed : f)),
      message:
        '`_ggui:wired-tool-invoked` frame observed but value did not match the expected toolName/actionName.',
    };
  }
  return { kind: 'pass' };
}

/**
 * `contract-error-emitted` — the WS evidence is the canonical SPEC
 * §4.4 `_ggui:contract-error` envelope itself. Per the bar, every such
 * envelope MUST be mirrored as a `contract-error-emitted` observability
 * event on the host side; asserting on the WS frame is asserting on
 * the cause the bar makes load-bearing for the mirror.
 */
function matchContractErrorEmitted(
  event: ExpectedObservabilityEvent,
  frames: readonly ObservedFrame[],
): MatchResult {
  if (event.code === undefined || event.toolName === undefined) {
    return {
      kind: 'fail',
      expected: {
        kind: 'contract-error-emitted',
        code: event.code ?? '<required>',
        toolName: event.toolName ?? '<required>',
      },
      received: { event },
      message:
        'observability-event of kind `contract-error-emitted` MUST declare both `code` and `toolName` for the matcher to assert against; fixture is under-specified.',
    };
  }
  const candidates = frames.filter(
    (f) =>
      f.kind === 'frame' &&
      f.parsed['type'] === 'stream' &&
      isRecord(f.parsed['payload']) &&
      f.parsed['payload']['channel'] === '_ggui:contract-error',
  );
  if (candidates.length === 0) {
    return {
      kind: 'fail',
      expected: {
        channel: '_ggui:contract-error',
        code: event.code,
        toolName: event.toolName,
      },
      received: frames.map((f) => (f.kind === 'frame' ? f.parsed : f)),
      message:
        'expected a `stream` frame on `_ggui:contract-error` (the WS-observable evidence the protocol bar mandates a conformant host mirror-emit `contract-error-emitted` on); none observed.',
    };
  }
  // Same canonical-shape reader as `matchContractError` — code is
  // nested under `payload.value.error.code`, toolName at the top of
  // `payload.value`.
  const match = candidates.find((f) => {
    if (f.kind !== 'frame') return false;
    const payload = f.parsed['payload'];
    if (!isRecord(payload)) return false;
    const value = payload['value'];
    if (!isRecord(value)) return false;
    const error = value['error'];
    if (!isRecord(error)) return false;
    if (error['code'] !== event.code) return false;
    if (value['toolName'] !== event.toolName) return false;
    if (
      event.actionName !== undefined &&
      value['actionName'] !== event.actionName
    ) {
      return false;
    }
    return true;
  });
  if (match === undefined) {
    return {
      kind: 'fail',
      expected: {
        channel: '_ggui:contract-error',
        code: event.code,
        toolName: event.toolName,
        actionName: event.actionName,
      },
      received: candidates.map((f) => (f.kind === 'frame' ? f.parsed : f)),
      message:
        '`_ggui:contract-error` frame observed but payload did not match the expected code/tool/action triple for the mandated mirror-emission.',
    };
  }
  return { kind: 'pass' };
}

// =============================================================================
// Helpers
// =============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  if (!aKeys.every((k, i) => k === bKeys[i])) return false;
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}
