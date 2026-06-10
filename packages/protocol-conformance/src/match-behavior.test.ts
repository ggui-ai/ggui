/**
 * Matcher unit tests — synthetic frame arrays exercising the
 * Path-A behavior arms.
 *
 * Pure unit-level: no transport, no server. The arms under test are
 * `action-ack` (asserts the action's ack frame carries the consume-
 * buffer append sequence), `error-frame` (asserts an `error` frame
 * with the expected `payload.code`, the generalized read the
 * `version-mismatch` arm narrows to `UPGRADE_REQUIRED`), and
 * `stream-update` (asserts the canonical channel-3 delivery frame
 * `{type:'data', payload: StreamEnvelope}`). Path-B kinds and unknown
 * vocabulary remain `unmatchable-on-ws`; this file pins that contract
 * too.
 */
import { describe, expect, it } from 'vitest';

import { matchBehavior } from './match-behavior.js';
import type {
  ActionAckBehavior,
  ErrorFrameBehavior,
  StreamUpdateBehavior,
} from './types.js';
import type { ObservedFrame } from './ws-transport.js';

function frame(parsed: Record<string, unknown>): ObservedFrame {
  return { kind: 'frame', raw: JSON.stringify(parsed), parsed };
}

/** The subscribe ack the runner's own subscribe frame produces. */
const SUBSCRIBE_ACK: ObservedFrame = frame({
  type: 'ack',
  payload: { serverVersion: '1.1' },
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
        clientAccepts: ['1.1'],
      },
      frames,
    );
    expect(result.kind).toBe('pass');
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

  it("does not match the text-chunk streaming frame {type:'stream', payload:{sessionId, chunk, done}}", () => {
    const frames: readonly ObservedFrame[] = [
      frame({
        type: 'stream',
        payload: { sessionId: 'rnd-stream-1', chunk: 'Hi', done: false },
      }),
    ];
    expect(matchBehavior(behavior, frames).kind).toBe('fail');
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
