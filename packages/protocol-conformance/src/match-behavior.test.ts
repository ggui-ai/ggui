/**
 * Matcher unit tests — synthetic frame arrays exercising the
 * Path-A behavior arms.
 *
 * Pure unit-level: no transport, no server. The arms under test are
 * `action-ack` (asserts the action's ack frame carries the consume-
 * buffer append sequence), `error-frame` (asserts an `error` frame
 * with the expected `payload.code`, the generalized read the
 * `version-mismatch` arm narrows to `UPGRADE_REQUIRED`),
 * `bootstrap-success` (subscribe → ack, with the optional
 * `serverVersion: 'current'` ack-advertisement assertion resolved
 * against the kit's compiled `PROTOCOL_SCHEMA_VERSION`), and
 * `stream-update` (asserts the canonical channel-3 delivery frame
 * `{type:'data', payload: StreamEnvelope}`, with exact-vs-subset
 * value matching via `valueMatch`). Path-B kinds, the stateful
 * `session-state` kind (graded by the RUNNER via
 * `ConformanceHost.readSessionField`, never from frames), and unknown
 * vocabulary remain `unmatchable-on-ws`; this file pins that contract
 * too.
 */
import { PROTOCOL_SCHEMA_VERSION } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';

import { matchBehavior } from './match-behavior.js';
import type {
  ActionAckBehavior,
  BootstrapSuccessBehavior,
  ErrorFrameBehavior,
  StreamUpdateBehavior,
} from './types.js';
import type { ObservedFrame } from './ws-transport.js';

function frame(parsed: Record<string, unknown>): ObservedFrame {
  return { kind: 'frame', raw: JSON.stringify(parsed), parsed };
}

/** The subscribe ack the runner's own subscribe frame produces —
 *  advertising the canonical schema version, as first-party servers
 *  do on every successful ack (SPEC §12.2.2). */
const SUBSCRIBE_ACK: ObservedFrame = frame({
  type: 'ack',
  payload: { serverVersion: PROTOCOL_SCHEMA_VERSION },
  requestId: 'conformance-subscribe-fixture',
});

describe('matchBehavior — action-ack', () => {
  const behavior: ActionAckBehavior = {
    kind: 'action-ack',
    requestId: 'action-req-1',
  };

  it('passes when the ack echoes the requestId and carries a numeric payload.sequence', () => {
    const frames: readonly ObservedFrame[] = [
      SUBSCRIBE_ACK,
      frame({
        type: 'ack',
        payload: { sequence: 1, timestamp: 1760000000000 },
        requestId: 'action-req-1',
      }),
    ];
    expect(matchBehavior(behavior, frames).kind).toBe('pass');
  });

  it('fails when no ack echoes the action requestId (subscribe ack alone is not enough)', () => {
    const result = matchBehavior(behavior, [SUBSCRIBE_ACK]);
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.message).toContain("requestId 'action-req-1'");
  });

  it('fails when the ack echoes the requestId but payload.sequence is missing', () => {
    const frames: readonly ObservedFrame[] = [
      SUBSCRIBE_ACK,
      frame({
        type: 'ack',
        payload: { timestamp: 1760000000000 },
        requestId: 'action-req-1',
      }),
    ];
    const result = matchBehavior(behavior, frames);
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.message).toContain('payload.sequence');
  });

  it('fails when payload.sequence is non-numeric', () => {
    const frames: readonly ObservedFrame[] = [
      frame({
        type: 'ack',
        payload: { sequence: '1' },
        requestId: 'action-req-1',
      }),
    ];
    expect(matchBehavior(behavior, frames).kind).toBe('fail');
  });
});

describe('matchBehavior — error-frame', () => {
  const behavior: ErrorFrameBehavior = {
    kind: 'error-frame',
    code: 'CONTRACT_VIOLATION',
    requestId: 'action-req-2',
  };

  it('passes when an error frame matches code + echoed requestId', () => {
    const frames: readonly ObservedFrame[] = [
      SUBSCRIBE_ACK,
      frame({
        type: 'error',
        payload: { code: 'CONTRACT_VIOLATION', message: "Unknown action 'doesNotExist'" },
        requestId: 'action-req-2',
      }),
    ];
    expect(matchBehavior(behavior, frames).kind).toBe('pass');
  });

  it('passes without requestId pinning when the behavior omits it', () => {
    const codeOnly: ErrorFrameBehavior = { kind: 'error-frame', code: 'SESSION_NOT_FOUND' };
    const frames: readonly ObservedFrame[] = [
      frame({
        type: 'error',
        payload: { code: 'SESSION_NOT_FOUND', message: 'gone' },
      }),
    ];
    expect(matchBehavior(codeOnly, frames).kind).toBe('pass');
  });

  it('fails when no error frame is observed', () => {
    const result = matchBehavior(behavior, [SUBSCRIBE_ACK]);
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.message).toContain('CONTRACT_VIOLATION');
  });

  it('fails when the error code mismatches', () => {
    const frames: readonly ObservedFrame[] = [
      frame({
        type: 'error',
        payload: { code: 'SESSION_MISMATCH', message: 'wrong render' },
        requestId: 'action-req-2',
      }),
    ];
    expect(matchBehavior(behavior, frames).kind).toBe('fail');
  });

  it('fails when the code matches but the echoed requestId does not', () => {
    const frames: readonly ObservedFrame[] = [
      frame({
        type: 'error',
        payload: { code: 'CONTRACT_VIOLATION', message: 'rejected' },
        requestId: 'some-other-request',
      }),
    ];
    expect(matchBehavior(behavior, frames).kind).toBe('fail');
  });
});

describe('matchBehavior — version-mismatch rides the error-frame read', () => {
  it('passes on an UPGRADE_REQUIRED error frame', () => {
    const frames: readonly ObservedFrame[] = [
      frame({
        type: 'error',
        payload: {
          code: 'UPGRADE_REQUIRED',
          message: "server advertises '99.99-unsupported'",
          serverVersion: '99.99-unsupported',
        },
      }),
    ];
    const result = matchBehavior(
      {
        kind: 'version-mismatch',
        serverVersion: '99.99-unsupported',
      },
      frames,
    );
    expect(result.kind).toBe('pass');
  });
});

describe('matchBehavior — bootstrap-success', () => {
  it('passes on an ack with no error frame (versionless claim)', () => {
    const behavior: BootstrapSuccessBehavior = { kind: 'bootstrap-success' };
    expect(matchBehavior(behavior, [SUBSCRIBE_ACK]).kind).toBe('pass');
  });

  it('fails when no ack is observed', () => {
    const behavior: BootstrapSuccessBehavior = { kind: 'bootstrap-success' };
    expect(matchBehavior(behavior, []).kind).toBe('fail');
  });

  it('fails when an error frame accompanies the observation window', () => {
    const behavior: BootstrapSuccessBehavior = { kind: 'bootstrap-success' };
    const frames: readonly ObservedFrame[] = [
      frame({ type: 'error', payload: { code: 'SESSION_NOT_FOUND', message: 'gone' } }),
    ];
    expect(matchBehavior(behavior, frames).kind).toBe('fail');
  });

  describe("serverVersion: 'current' — the SPEC §12.2.2 ack-advertisement assertion", () => {
    const behavior: BootstrapSuccessBehavior = {
      kind: 'bootstrap-success',
      serverVersion: 'current',
    };

    it('passes when the ack advertises the compiled canonical PROTOCOL_SCHEMA_VERSION', () => {
      expect(matchBehavior(behavior, [SUBSCRIBE_ACK]).kind).toBe('pass');
    });

    it('fails when the ack omits payload.serverVersion — a versionless ack proves only the pre-handshake path', () => {
      const frames: readonly ObservedFrame[] = [
        frame({
          type: 'ack',
          payload: { sequence: 0, timestamp: 1760000000000 },
          requestId: 'conformance-subscribe-version-match',
        }),
      ];
      const result = matchBehavior(behavior, frames);
      expect(result.kind).toBe('fail');
      if (result.kind !== 'fail') return;
      expect(result.message).toContain('does not advertise');
      expect(result.message).toContain(PROTOCOL_SCHEMA_VERSION);
    });

    it('fails when the ack advertises a stale / different version', () => {
      const frames: readonly ObservedFrame[] = [
        frame({
          type: 'ack',
          payload: { serverVersion: '1.0-stale' },
        }),
      ];
      const result = matchBehavior(behavior, frames);
      expect(result.kind).toBe('fail');
      if (result.kind !== 'fail') return;
      expect(result.message).toContain('1.0-stale');
      expect(result.message).toContain(PROTOCOL_SCHEMA_VERSION);
    });
  });
});

describe('matchBehavior — stream-update matches the canonical channel-3 data frame', () => {
  const behavior: StreamUpdateBehavior = {
    kind: 'stream-update',
    channel: 'message',
    value: { text: 'Hi' },
  };

  it('passes on a `data` frame whose StreamEnvelope names the channel and carries the value', () => {
    const frames: readonly ObservedFrame[] = [
      SUBSCRIBE_ACK,
      frame({
        type: 'data',
        payload: {
          sessionId: 'rnd-stream-1',
          channel: 'message',
          mode: 'append',
          payload: { text: 'Hi' },
          seq: 13,
        },
      }),
    ];
    expect(matchBehavior(behavior, frames).kind).toBe('pass');
  });

  it('passes with replace mode and without optional seq / complete / schemaVersion', () => {
    const frames: readonly ObservedFrame[] = [
      frame({
        type: 'data',
        payload: {
          sessionId: 'rnd-stream-1',
          channel: 'message',
          mode: 'replace',
          payload: { text: 'Hi' },
        },
      }),
    ];
    expect(matchBehavior(behavior, frames).kind).toBe('pass');
  });

  it('fails when no data frame names the declared channel', () => {
    const frames: readonly ObservedFrame[] = [
      frame({
        type: 'data',
        payload: {
          sessionId: 'rnd-stream-1',
          channel: 'other-channel',
          mode: 'append',
          payload: { text: 'Hi' },
        },
      }),
    ];
    const result = matchBehavior(behavior, frames);
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.message).toContain("channel 'message'");
  });

  it('fails when the envelope payload does not deep-equal the declared value', () => {
    const frames: readonly ObservedFrame[] = [
      frame({
        type: 'data',
        payload: {
          sessionId: 'rnd-stream-1',
          channel: 'message',
          mode: 'append',
          payload: { text: 'something else' },
        },
      }),
    ];
    expect(matchBehavior(behavior, frames).kind).toBe('fail');
  });

  it('fails when the data frame body is not a conformant StreamEnvelope (missing mode)', () => {
    const frames: readonly ObservedFrame[] = [
      frame({
        type: 'data',
        payload: {
          sessionId: 'rnd-stream-1',
          channel: 'message',
          payload: { text: 'Hi' },
        },
      }),
    ];
    expect(matchBehavior(behavior, frames).kind).toBe('fail');
  });

  it("REGRESSION: the retired kit idiolect {type:'stream', payload:{channel, value}} does NOT match", () => {
    // Pre-canonical kit versions graded a frame shape no conformant
    // server speaks. The canonical channel-3 delivery frame is
    // `{type:'data', payload: StreamEnvelope}` (SPEC §12.2); the
    // idiolect must stay rejected so the matcher never regresses to
    // accepting it.
    const frames: readonly ObservedFrame[] = [
      frame({
        type: 'stream',
        payload: { channel: 'message', value: { text: 'Hi' } },
      }),
    ];
    expect(matchBehavior(behavior, frames).kind).toBe('fail');
  });

  it("does not match the retired text-chunk frame {type:'stream', payload:{sessionId, chunk, done}}", () => {
    // The text-chunk streaming frame left the protocol union
    // draft-2026-06-11 (zero emitters). An implementation still
    // speaking it must NOT satisfy a stream-update expectation —
    // only the canonical `{type:'data'}` delivery frame counts.
    const frames: readonly ObservedFrame[] = [
      frame({
        type: 'stream',
        payload: { sessionId: 'rnd-stream-1', chunk: 'Hi', done: false },
      }),
    ];
    expect(matchBehavior(behavior, frames).kind).toBe('fail');
  });
});

describe('matchBehavior — stream-update valueMatch (exact vs subset)', () => {
  /** Canonical channel-3 delivery frame whose envelope body carries
   *  the declared keys PLUS a non-deterministic extra. */
  function dataFrame(payload: Record<string, unknown>): ObservedFrame {
    return frame({
      type: 'data',
      payload: {
        sessionId: 'rnd-stream-2',
        channel: 'progress',
        mode: 'replace',
        payload,
      },
    });
  }

  it('exact (default) rejects an observed body carrying extra keys', () => {
    const behavior: StreamUpdateBehavior = {
      kind: 'stream-update',
      channel: 'progress',
      value: { kind: 'started' },
    };
    const result = matchBehavior(behavior, [
      dataFrame({ kind: 'started', handshakeId: 'hs-8f31' }),
    ]);
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.message).toContain('exact match');
  });

  it('subset accepts an observed body carrying extra keys when every declared key matches', () => {
    const behavior: StreamUpdateBehavior = {
      kind: 'stream-update',
      channel: 'progress',
      value: { kind: 'started' },
      valueMatch: 'subset',
    };
    const result = matchBehavior(behavior, [
      dataFrame({ kind: 'started', handshakeId: 'hs-8f31', startedAt: 1760000000000 }),
    ]);
    expect(result.kind).toBe('pass');
  });

  it('subset recurses into nested objects (declared nested keys match; nested extras ignored)', () => {
    const behavior: StreamUpdateBehavior = {
      kind: 'stream-update',
      channel: 'progress',
      value: { kind: 'started', detail: { step: 2 } },
      valueMatch: 'subset',
    };
    const result = matchBehavior(behavior, [
      dataFrame({ kind: 'started', detail: { step: 2, traceId: 't-1' }, extra: true }),
    ]);
    expect(result.kind).toBe('pass');
  });

  it('subset still fails when a declared key mismatches', () => {
    const behavior: StreamUpdateBehavior = {
      kind: 'stream-update',
      channel: 'progress',
      value: { kind: 'started' },
      valueMatch: 'subset',
    };
    const result = matchBehavior(behavior, [
      dataFrame({ kind: 'finished', handshakeId: 'hs-8f31' }),
    ]);
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.message).toContain('subset match');
  });

  it('subset still fails when a declared key is absent from the observed body', () => {
    const behavior: StreamUpdateBehavior = {
      kind: 'stream-update',
      channel: 'progress',
      value: { kind: 'started', step: 1 },
      valueMatch: 'subset',
    };
    const result = matchBehavior(behavior, [
      dataFrame({ kind: 'started', handshakeId: 'hs-8f31' }),
    ]);
    expect(result.kind).toBe('fail');
  });

  it('subset compares arrays exact — a shorter observed array is not a subset', () => {
    const behavior: StreamUpdateBehavior = {
      kind: 'stream-update',
      channel: 'progress',
      value: { steps: ['fetch', 'build', 'publish'] },
      valueMatch: 'subset',
    };
    const result = matchBehavior(behavior, [
      dataFrame({ steps: ['fetch', 'build'], handshakeId: 'hs-8f31' }),
    ]);
    expect(result.kind).toBe('fail');
  });
});

describe('matchBehavior — session-state is unmatchable from frames', () => {
  it('returns unmatchable-on-ws naming the runner read-back seam (frames cannot prove state)', () => {
    const result = matchBehavior(
      {
        kind: 'session-state',
        field: 'hostContext',
        expected: { currentDisplayMode: 'inline' },
      },
      [SUBSCRIBE_ACK],
    );
    expect(result.kind).toBe('unmatchable-on-ws');
    if (result.kind !== 'unmatchable-on-ws') return;
    expect(result.reason).toContain('readSessionField');
    expect(result.reason).toContain('frames cannot prove state');
  });
});

describe('matchBehavior — Path-B and unknown kinds skip', () => {
  it('returns unmatchable-on-ws for props-update (DOM-level claim)', () => {
    const result = matchBehavior(
      {
        kind: 'props-update',
        channel: '_ggui:props',
        props: { greeting: 'hi' },
        evidence: { selector: '[data-x]', expected: 'hi' },
      },
      [],
    );
    expect(result.kind).toBe('unmatchable-on-ws');
    if (result.kind !== 'unmatchable-on-ws') return;
    expect(result.reason).toContain('Path-B');
  });

  it('returns unmatchable-on-ws for an unknown extensibly-closed behavior kind', () => {
    const result = matchBehavior({ kind: 'made-up-future-behavior' }, []);
    expect(result.kind).toBe('unmatchable-on-ws');
    if (result.kind !== 'unmatchable-on-ws') return;
    expect(result.reason).toContain('made-up-future-behavior');
  });
});
