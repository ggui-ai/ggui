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
 *   - `bootstrap-success` — subscribe produced an `ack` frame. When
 *     the behavior authors `serverVersion: 'current'`, the ack MUST
 *     additionally advertise `payload.serverVersion` equal to the
 *     kit's compiled `PROTOCOL_SCHEMA_VERSION` — the server half of
 *     SPEC §12.2.2's version handshake (the `version-match` fixture's
 *     happy-path claim).
 *   - `version-mismatch` — subscribe produced an `error` frame with
 *     `code: 'UPGRADE_REQUIRED'` (the generic error-frame read
 *     narrowed to one code). The provoking client declaration travels
 *     on the fixture's `subscribe.supportedVersions` knob, not on
 *     this behavior.
 *   - `action-ack`     — the action's `ack` frame (matched by echoed
 *     `requestId`) carries a numeric `payload.sequence` — proof the
 *     event persisted to the GguiSession's consume buffer.
 *   - `error-frame`    — an `error` frame with the expected
 *     `payload.code` (+ optional echoed `requestId`).
 *   - `stream-update`  — canonical channel-3 delivery frame
 *     (`{type: 'data', payload: StreamEnvelope}`, SPEC §12.2) whose
 *     envelope names the declared channel and carries the declared
 *     value as its `payload` body.
 *   - `no-op`          — no frames observed after input dispatch.
 *
 * One kind is neither Path A nor Path B: `session-state` is a
 * *stateful* obligation — the input message produces no wire response,
 * so frames cannot prove it. This module returns `unmatchable-on-ws`
 * for it; the RUNNER (`run-conformance.ts`) grades it after the
 * observation window via `ConformanceHost.readSessionField`, reusing
 * this module's exported {@link deepEqual}. A caller that routes a
 * `session-state` behavior through the frame matcher gets the honest
 * skip, never a frame-derived verdict.
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
import { PROTOCOL_SCHEMA_VERSION } from '@ggui-ai/protocol';
import type { StreamEnvelope } from '@ggui-ai/protocol';

import { isRecord } from './is-record.js';
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

/**
 * Discriminant narrowing for the extensibly-closed
 * {@link ExpectedBehavior} union. The `UnknownBehavior` arm's
 * `kind: string & {}` deliberately widens the discriminant (future
 * fixture vocabulary must flow through as opaque records), which also
 * stops TS narrowing on direct literal checks — so the kit dispatches
 * through this predicate instead of per-site casts. The runtime check
 * is exactly the literal comparison the predicate claims.
 */
export function behaviorIs<K extends ExpectedBehavior['kind']>(
  behavior: ExpectedBehavior,
  kind: K,
): behavior is Extract<ExpectedBehavior, { readonly kind: K }> {
  return behavior.kind === kind;
}

export function matchBehavior(
  behavior: ExpectedBehavior,
  frames: readonly ObservedFrame[],
): MatchResult {
  // Dispatch on the `kind` discriminator through `behaviorIs` — the
  // extensibly-closed `UnknownBehavior` (`kind: string & {}`) in the
  // union widens the discriminant, preventing TS from narrowing on
  // bare literal checks.
  if (behaviorIs(behavior, 'bootstrap-success')) {
    return matchBootstrapSuccess(behavior, frames);
  }
  if (behaviorIs(behavior, 'version-mismatch')) {
    return matchVersionMismatch(behavior, frames);
  }
  if (behaviorIs(behavior, 'action-ack')) {
    return matchActionAck(behavior, frames);
  }
  if (behaviorIs(behavior, 'error-frame')) {
    return matchErrorFrame(behavior, frames);
  }
  if (behaviorIs(behavior, 'stream-update')) {
    return matchStreamUpdate(behavior, frames);
  }
  if (behaviorIs(behavior, 'no-op')) {
    return matchNoOp(behavior, frames);
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
  if (behavior.kind === 'session-state') {
    return {
      kind: 'unmatchable-on-ws',
      reason:
        'session-state is a stateful obligation — its grade is a post-dispatch read-back of the GguiSession field via `ConformanceHost.readSessionField`, not a WS frame; frames cannot prove state. The runner (`run-conformance.ts`) grades this kind after the observation window; it never reaches the frame matcher there. Reaching here means a caller invoked `matchBehavior` directly on a session-state behavior.',
    };
  }
  // Extensibly-closed union catch — unknown `kind` = new fixture
  // vocabulary the runner doesn't recognize; skip cleanly.
  return {
    kind: 'unmatchable-on-ws',
    reason: `Unknown expectedBehavior.kind='${behavior.kind}' — kit runner does not recognize this behavior. Check kit version.`,
  };
}

// =============================================================================
// Per-behavior matchers
// =============================================================================

function matchBootstrapSuccess(
  behavior: BootstrapSuccessBehavior,
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
  // Optional ack-field assertion (`serverVersion: 'current'`) — the
  // server half of SPEC §12.2.2: a successful ack MUST advertise
  // `payload.serverVersion` equal to the kit's compiled canonical.
  // An ack that omits the field is legacy-pass-through on the wire,
  // but a fixture authoring this assertion is grading the handshake
  // — silence does not satisfy it.
  if (behavior.serverVersion === 'current') {
    const payload = ack.kind === 'frame' ? ack.parsed['payload'] : undefined;
    const advertised = isRecord(payload) ? payload['serverVersion'] : undefined;
    if (advertised !== PROTOCOL_SCHEMA_VERSION) {
      return {
        kind: 'fail',
        expected: { type: 'ack', payload: { serverVersion: PROTOCOL_SCHEMA_VERSION } },
        received: { ackFrame: ack.kind === 'frame' ? ack.parsed : ack },
        message:
          advertised === undefined
            ? `ack does not advertise \`payload.serverVersion\` — the fixture asserts the SPEC §12.2.2 server half (advertise '${PROTOCOL_SCHEMA_VERSION}' on every successful ack); a versionless ack proves only the pre-handshake subscribe path.`
            : `ack advertises \`payload.serverVersion\` ${JSON.stringify(advertised)} but the kit's compiled canonical is '${PROTOCOL_SCHEMA_VERSION}'.`,
      };
    }
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

/**
 * `stream-update` — matches the canonical channel-3 delivery frame
 * (SPEC §12.2): `{type: 'data', payload: StreamEnvelope}`. The
 * {@link StreamEnvelope} (from `@ggui-ai/protocol`) carries the
 * channel identity on `channel` and the delivery body on `payload`;
 * the matcher requires a `data` frame whose envelope names the
 * declared channel and whose body matches the declared value —
 * exact deep-equal by default, or declared-keys-subset when the
 * fixture authors `valueMatch: 'subset'` (see
 * {@link deepMatchSubset}).
 *
 * Two near-miss frames deliberately do NOT match:
 *   - `{type: 'stream', payload: {sessionId, chunk, done}}` — the
 *     agent text-chunk streaming frame, a different wire type.
 *   - Any `data` frame whose body fails the {@link StreamEnvelope}
 *     shape (missing `sessionId` / `channel` / `mode`) — a
 *     non-conformant envelope must not satisfy the assertion.
 */
function matchStreamUpdate(
  behavior: StreamUpdateBehavior,
  frames: readonly ObservedFrame[],
): MatchResult {
  const envelopes: readonly StreamEnvelope[] = frames.flatMap((f) => {
    if (f.kind !== 'frame' || f.parsed['type'] !== 'data') return [];
    const body = f.parsed['payload'];
    return isStreamEnvelope(body) ? [body] : [];
  });
  // `valueMatch: 'subset'` relaxes the value comparison to "every
  // declared key is present + matching; extra observed keys ignored".
  // Default ('exact' / absent) is the exact deep-equal.
  const subset = behavior.valueMatch === 'subset';
  const valueMatches = (observed: unknown): boolean =>
    subset ? deepMatchSubset(behavior.value, observed) : deepEqual(observed, behavior.value);
  const match = envelopes.find(
    (envelope) => envelope.channel === behavior.channel && valueMatches(envelope.payload),
  );
  if (match === undefined) {
    return {
      kind: 'fail',
      expected: {
        type: 'data',
        payload: { channel: behavior.channel, payload: behavior.value },
        valueMatch: subset ? 'subset' : 'exact',
      },
      received: frames
        .filter((f) => f.kind === 'frame' && f.parsed['type'] === 'data')
        .map((f) => (f.kind === 'frame' ? f.parsed : f)),
      message: `expected a \`data\` frame whose StreamEnvelope names channel '${behavior.channel}' and carries the declared value as its payload (${subset ? 'subset match — every declared key present + matching' : 'exact match'}); none matched.`,
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

/**
 * Validating narrower for {@link StreamEnvelope} — the body of a
 * channel-3 `data` frame. Field names come from `@ggui-ai/protocol`
 * (`types/live-channel`): `sessionId` + `channel` are required
 * strings, `mode` is the declared state-folding mode
 * (`'append' | 'replace'`), and the delivery body lives under
 * `payload`.
 */
function isStreamEnvelope(value: unknown): value is StreamEnvelope {
  if (!isRecord(value)) return false;
  if (typeof value['sessionId'] !== 'string') return false;
  if (typeof value['channel'] !== 'string') return false;
  if (value['mode'] !== 'append' && value['mode'] !== 'replace') return false;
  return 'payload' in value;
}

/**
 * Exact deep-equal — objects must have identical key sets, arrays
 * identical length + ordered contents. Exported so the runner grades
 * `session-state` read-backs with the SAME comparison the frame
 * matchers use — one equality, no matcher/runner drift.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  if (!aKeys.every((k, i) => k === bKeys[i])) return false;
  return aKeys.every((k) => deepEqual(a[k], b[k]));
}

/**
 * Subset deep-match: every key in `expected` MUST be present and
 * recursively matching in `actual`; extra keys on `actual` are
 * ignored. Subset semantics relax ONLY object key sets — primitives
 * and arrays fall back to exact {@link deepEqual} (an array with a
 * missing element is a different array, not a subset).
 *
 * Backs `StreamUpdateBehavior.valueMatch === 'subset'`: a fixture
 * pins only the deterministic keys of a payload that also carries
 * non-deterministic fields (generated ids, timestamps) without
 * wrongly rejecting a correct server over a random id.
 */
function deepMatchSubset(expected: unknown, actual: unknown): boolean {
  if (!isRecord(expected)) {
    // Primitives + arrays: exact match.
    return deepEqual(expected, actual);
  }
  if (!isRecord(actual)) return false;
  return Object.keys(expected).every(
    (k) => k in actual && deepMatchSubset(expected[k], actual[k]),
  );
}
