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
 * subscribe ack, the action ack's persistence sequence, error frames,
 * stream updates) AND surface-observable claims (DOM state after a
 * props update, browser-side bootstrap failure modes). This file
 * matches the **Path-A** subset — the wire-observable behaviors a
 * runner can assert from frames alone, with no MCP-Apps-host adapter
 * and no browser page. The Path-B subset (browser-host harness) is
 * inherently NOT WS-reducible: bootstrap-failure modes are caused by
 * the renderer-bundle fetch + `ui/initialize` round-trip the host
 * speaks over postMessage; props-update assertions are assertions on
 * the rendered DOM the renderer paints, not on WS frames the server
 * emits. For these kinds we return `unmatchable-on-ws` with a sharp
 * reason and the runner records SKIP — they are NOT failures of the
 * server, they are claims a different driver must drive.
 *
 * The Path-B driver is not yet packaged — no browser-host harness
 * ships with the kit today, so Path-B fixtures are skipped wherever
 * the kit runs. A future packaged browser-host adapter folds that
 * capability into the kit so third-party adopters don't have to
 * reimplement it. Until then, the partition is honest: Path A handles
 * wire claims, Path B is a declared grading gap, and
 * `unmatchable-on-ws` is the partition seam.
 *
 * v1 Path-A scope:
 *
 *   - `bootstrap-success` — subscribe produced an `ack` frame.
 *   - `version-mismatch` — subscribe produced an `error` frame with
 *     `code: 'UPGRADE_REQUIRED'` (the generic error-frame read
 *     narrowed to one code).
 *   - `action-ack`     — the action's `ack` frame (matched by echoed
 *     `requestId`) carries a numeric `payload.sequence` — proof the
 *     event persisted to the GguiSession's consume buffer.
 *   - `error-frame`    — an `error` frame with the expected
 *     `payload.code` (+ optional echoed `requestId`).
 *   - `stream-update`  — stream frame on named channel matches
 *     declared value.
 *   - `no-op`          — no frames observed after input dispatch.
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
 * ## Declared grading gap — the `ggui_consume` retrieval half
 *
 * `action-ack` proves the append half of the consume-buffer contract.
 * The retrieval half — the agent draining the buffer via
 * `ggui_consume({sessionId})` — is an MCP tool call a WS-only runner
 * cannot drive. Grading it needs an MCP-binding driver; that gap is
 * declared here rather than papered over with a weaker assertion.
 */
import type {
  ActionAckBehavior,
  BootstrapSuccessBehavior,
  ErrorFrameBehavior,
  ExpectedBehavior,
  NoOpBehavior,
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
  if (behavior.kind === 'action-ack') {
    return matchActionAck(behavior as ActionAckBehavior, frames);
  }
  if (behavior.kind === 'error-frame') {
    return matchErrorFrame(behavior as ErrorFrameBehavior, frames);
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
        'bootstrap-failure is a Path-B (browser-host) claim — the fault surface is the host\'s bootstrap-fetch + `ui/initialize` postMessage round-trip, not a WS frame the server emits. The `renderer-url-override` / `ui-initialize-response-override` setup directives are MCP-Apps-host concerns; the reference server\'s host adapter throws "out of scope" on them by design. The Path-B driver is not yet packaged — these fixtures skip until a browser-host adapter ships with the kit.',
    };
  }
  if (behavior.kind === 'props-update') {
    return {
      kind: 'unmatchable-on-ws',
      reason:
        'props-update is a Path-B (browser-host) claim — the assertion is on rendered DOM (selector + attribute/text), not on the `_ggui:props` WS frame in isolation. Matchable on WS only as "frame was emitted"; the fixture vocabulary asserts "DOM reflects the update". The Path-B driver is not yet packaged — this fixture skips until a browser-host adapter ships with the kit.',
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
  // The generalized error-frame read narrowed to the version
  // handshake's canonical rejection code.
  const error = findErrorFrame(frames, 'UPGRADE_REQUIRED');
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

/**
 * `action-ack` — the ack frame echoing the action's `requestId` MUST
 * carry a numeric `payload.sequence`: the monotonic event sequence the
 * server assigned when it appended the action to the GguiSession's
 * consume buffer. Matching on the echoed `requestId` distinguishes the
 * action's ack from the subscribe ack the runner's own subscribe frame
 * produces.
 */
function matchActionAck(
  behavior: ActionAckBehavior,
  frames: readonly ObservedFrame[],
): MatchResult {
  const acks = frames.filter(
    (f) =>
      f.kind === 'frame' &&
      f.parsed['type'] === 'ack' &&
      f.parsed['requestId'] === behavior.requestId,
  );
  if (acks.length === 0) {
    return {
      kind: 'fail',
      expected: { type: 'ack', requestId: behavior.requestId },
      received: frames.map((f) => (f.kind === 'frame' ? f.parsed : f)),
      message: `expected an \`ack\` frame echoing requestId '${behavior.requestId}' after action dispatch; received none.`,
    };
  }
  const match = acks.find((f) => {
    if (f.kind !== 'frame') return false;
    const payload = f.parsed['payload'];
    return isRecord(payload) && typeof payload['sequence'] === 'number';
  });
  if (match === undefined) {
    return {
      kind: 'fail',
      expected: {
        type: 'ack',
        requestId: behavior.requestId,
        payload: { sequence: '<number>' },
      },
      received: acks.map((f) => (f.kind === 'frame' ? f.parsed : f)),
      message:
        'action `ack` frame observed but `payload.sequence` is missing or non-numeric — the ack does not prove the event persisted to the consume buffer.',
    };
  }
  return { kind: 'pass' };
}

/**
 * `error-frame` — an `error` frame with the expected `payload.code`
 * (+ the echoed `requestId` when the fixture declares one).
 */
function matchErrorFrame(
  behavior: ErrorFrameBehavior,
  frames: readonly ObservedFrame[],
): MatchResult {
  const match = findErrorFrame(frames, behavior.code, behavior.requestId);
  if (match === undefined) {
    return {
      kind: 'fail',
      expected: {
        type: 'error',
        payload: { code: behavior.code },
        ...(behavior.requestId !== undefined ? { requestId: behavior.requestId } : {}),
      },
      received: frames.map((f) => (f.kind === 'frame' ? f.parsed : f)),
      message: `expected an \`error\` frame with \`payload.code === ${behavior.code}\`${behavior.requestId !== undefined ? ` echoing requestId '${behavior.requestId}'` : ''}; received none.`,
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

// =============================================================================
// Helpers
// =============================================================================

/**
 * Find an `error` frame carrying `payload.code === code` and, when
 * `requestId` is given, echoing it. Shared by the generic
 * `error-frame` matcher and the `version-mismatch` arm.
 */
function findErrorFrame(
  frames: readonly ObservedFrame[],
  code: string,
  requestId?: string,
): ObservedFrame | undefined {
  return frames.find(
    (f) =>
      f.kind === 'frame' &&
      f.parsed['type'] === 'error' &&
      isRecord(f.parsed['payload']) &&
      f.parsed['payload']['code'] === code &&
      (requestId === undefined || f.parsed['requestId'] === requestId),
  );
}

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
