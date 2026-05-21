/**
 * Tests for the animator state machine (Slice F, 2026-05-17).
 *
 * Pure-function reducer; tested via value-in / value-out assertions.
 * Covers every primary transition + substate handling on `content` +
 * error/offline overlays + the documented edge cases (stale completion,
 * out-of-order drains).
 */
import { describe, expect, it } from 'vitest';
import {
  INITIAL_STATE,
  transition,
  type AnimatorEvent,
  type AnimatorState,
} from '../state-machine.js';

// Convenience builders so test bodies stay readable.
const ev = {
  handshakeStarted: (handshakeId = 'h1', intent = 'show weather'): AnimatorEvent => ({
    kind: 'handshake_started',
    payload: { kind: 'handshake_started', handshakeId, intent },
  }),
  handshakeCompleted: (
    handshakeId = 'h1',
    outcome: 'accepted' | 'amended' | 'declined' | 'cached' = 'accepted',
    genExpected = false,
  ): AnimatorEvent => ({
    kind: 'handshake_completed',
    payload: { kind: 'handshake_completed', handshakeId, outcome, genExpected },
  }),
  pushStarted: (
    stackItemId = 'card_1',
    intent = 'show weather',
  ): AnimatorEvent => ({
    kind: 'push_started',
    payload: { kind: 'push_started', stackItemId, intent },
  }),
  consumePolling: (stackItemId = 'card_1'): AnimatorEvent => ({
    kind: 'consume_polling',
    payload: { kind: 'consume_polling', state: 'open', stackItemId },
  }),
  stackItemAppended: (stackItemId = 'card_1'): AnimatorEvent => ({
    kind: 'stack_item_appended',
    stackItemId,
  }),
  actionDrained: (stackItemId = 'card_1'): AnimatorEvent => ({
    kind: 'action_drained',
    stackItemId,
  }),
  stackEmptied: (): AnimatorEvent => ({ kind: 'stack_emptied' }),
  contractError: (message = 'INVALID'): AnimatorEvent => ({
    kind: 'contract_error',
    message,
  }),
  errorDismissed: (): AnimatorEvent => ({ kind: 'error_dismissed' }),
  transportOffline: (): AnimatorEvent => ({ kind: 'transport_offline' }),
  transportOnline: (): AnimatorEvent => ({ kind: 'transport_online' }),
};

describe('animator state machine — primary transitions', () => {
  it('starts in ready', () => {
    expect(INITIAL_STATE).toEqual({ kind: 'ready' });
  });

  it('ready + handshake_started → handshake', () => {
    const next = transition(INITIAL_STATE, ev.handshakeStarted('h1', 'do a thing'));
    expect(next).toEqual({
      kind: 'handshake',
      handshakeId: 'h1',
      intent: 'do a thing',
    });
  });

  it('handshake + handshake_completed (matching id) → ready', () => {
    const s1 = transition(INITIAL_STATE, ev.handshakeStarted('h1'));
    const s2 = transition(s1, ev.handshakeCompleted('h1'));
    expect(s2).toEqual({ kind: 'ready' });
  });

  it('handshake + handshake_completed (WRONG id) → unchanged (defensive)', () => {
    const s1 = transition(INITIAL_STATE, ev.handshakeStarted('h1'));
    const s2 = transition(s1, ev.handshakeCompleted('h2'));
    expect(s2).toBe(s1); // same reference — no transition
  });

  it('ready + push_started → constructing', () => {
    const next = transition(
      INITIAL_STATE,
      ev.pushStarted('card_42', 'show weather'),
    );
    expect(next).toEqual({
      kind: 'constructing',
      stackItemId: 'card_42',
      intent: 'show weather',
    });
  });

  it('constructing + stack_item_appended → content (substate idle)', () => {
    const s1 = transition(INITIAL_STATE, ev.pushStarted('card_42'));
    const s2 = transition(s1, ev.stackItemAppended('card_42'));
    expect(s2).toEqual({
      kind: 'content',
      activeItemId: 'card_42',
      substate: { kind: 'idle' },
    });
  });

  it('ready + consume_polling → listening', () => {
    const next = transition(INITIAL_STATE, ev.consumePolling('card_1'));
    expect(next).toEqual({ kind: 'listening', stackItemId: 'card_1' });
  });

  it('listening + matching action_drained → ready', () => {
    const s1 = transition(INITIAL_STATE, ev.consumePolling('card_1'));
    const s2 = transition(s1, ev.actionDrained('card_1'));
    expect(s2).toEqual({ kind: 'ready' });
  });

  it('listening + non-matching action_drained → unchanged', () => {
    const s1 = transition(INITIAL_STATE, ev.consumePolling('card_1'));
    const s2 = transition(s1, ev.actionDrained('card_other'));
    expect(s2).toBe(s1);
  });
});

describe('content substate transitions', () => {
  let contentState: AnimatorState;
  beforeAll(() => {
    contentState = transition(
      transition(INITIAL_STATE, ev.pushStarted('card_1')),
      ev.stackItemAppended('card_1'),
    );
  });

  it('content + handshake_started → content with handshake substate', () => {
    const next = transition(contentState, ev.handshakeStarted('h1', 'next'));
    expect(next).toEqual({
      kind: 'content',
      activeItemId: 'card_1',
      substate: { kind: 'handshake', intent: 'next' },
    });
  });

  it('content + push_started → content with constructing substate', () => {
    const next = transition(contentState, ev.pushStarted('card_2', 'next-screen'));
    expect(next).toEqual({
      kind: 'content',
      activeItemId: 'card_1',
      substate: {
        kind: 'constructing',
        intent: 'next-screen',
        stackItemId: 'card_2',
      },
    });
  });

  it('content + consume_polling → content with listening substate', () => {
    const next = transition(contentState, ev.consumePolling('card_1'));
    expect(next).toEqual({
      kind: 'content',
      activeItemId: 'card_1',
      substate: { kind: 'listening', stackItemId: 'card_1' },
    });
  });

  it('content + stack_item_appended → content with NEW activeItemId, idle substate', () => {
    const next = transition(contentState, ev.stackItemAppended('card_2'));
    expect(next).toEqual({
      kind: 'content',
      activeItemId: 'card_2',
      substate: { kind: 'idle' },
    });
  });

  it('content listening + matching action_drained → content idle substate', () => {
    const withListening = transition(contentState, ev.consumePolling('card_1'));
    const next = transition(withListening, ev.actionDrained('card_1'));
    expect(next).toEqual({
      kind: 'content',
      activeItemId: 'card_1',
      substate: { kind: 'idle' },
    });
  });

  it('content listening + non-matching action_drained → unchanged', () => {
    const withListening = transition(contentState, ev.consumePolling('card_1'));
    const next = transition(withListening, ev.actionDrained('card_other'));
    expect(next).toBe(withListening);
  });

  it('content + stack_emptied → ready', () => {
    const next = transition(contentState, ev.stackEmptied());
    expect(next).toEqual({ kind: 'ready' });
  });
});

describe('error overlay', () => {
  it('contract_error from ready → error, recoveryTo: ready', () => {
    const next = transition(INITIAL_STATE, ev.contractError('OH_NO'));
    expect(next).toEqual({
      kind: 'error',
      message: 'OH_NO',
      recoveryTo: { kind: 'ready' },
    });
  });

  it('error + error_dismissed → returns to recoveryTo', () => {
    const s1 = transition(INITIAL_STATE, ev.contractError('X'));
    const s2 = transition(s1, ev.errorDismissed());
    expect(s2).toEqual({ kind: 'ready' });
  });

  it('contract_error from constructing → error remembers constructing', () => {
    const constructing = transition(INITIAL_STATE, ev.pushStarted('card_1'));
    const erred = transition(constructing, ev.contractError('X'));
    expect(erred.kind).toBe('error');
    if (erred.kind !== 'error') throw new Error('unreachable');
    expect(erred.recoveryTo).toEqual(constructing);

    const dismissed = transition(erred, ev.errorDismissed());
    expect(dismissed).toEqual(constructing);
  });

  it('contract_error stacks: second error preserves the FIRST recoveryTo', () => {
    // Two errors in a row shouldn't bury the original state behind
    // error-as-recoveryTo. The recovery target is the underlying
    // non-error state.
    const s1 = transition(INITIAL_STATE, ev.contractError('X'));
    const s2 = transition(s1, ev.contractError('Y'));
    expect(s2.kind).toBe('error');
    if (s2.kind !== 'error') throw new Error('unreachable');
    expect(s2.recoveryTo).toEqual({ kind: 'ready' });
  });

  it('error_dismissed from non-error state → unchanged', () => {
    const next = transition(INITIAL_STATE, ev.errorDismissed());
    expect(next).toBe(INITIAL_STATE);
  });
});

describe('transport offline / online', () => {
  it('any state + transport_offline → offline', () => {
    const constructing = transition(INITIAL_STATE, ev.pushStarted('card_1'));
    expect(transition(constructing, ev.transportOffline())).toEqual({
      kind: 'offline',
    });
  });

  it('offline + transport_online → ready (fresh start; subscribe-ack drives next state)', () => {
    const offline = transition(INITIAL_STATE, ev.transportOffline());
    expect(transition(offline, ev.transportOnline())).toEqual({ kind: 'ready' });
  });

  it('transport_online from non-offline state → unchanged', () => {
    const constructing = transition(INITIAL_STATE, ev.pushStarted('card_1'));
    expect(transition(constructing, ev.transportOnline())).toBe(constructing);
  });

  it('repeated transport_offline events are idempotent', () => {
    const o1 = transition(INITIAL_STATE, ev.transportOffline());
    const o2 = transition(o1, ev.transportOffline());
    expect(o2).toBe(o1);
  });
});

describe('full happy-path turn (ready → handshake → constructing → content → listening → ready)', () => {
  it('end-to-end transitions match the design doc state machine', () => {
    let s: AnimatorState = INITIAL_STATE;
    s = transition(s, ev.handshakeStarted('h1', 'show weather'));
    expect(s.kind).toBe('handshake');
    s = transition(s, ev.handshakeCompleted('h1'));
    expect(s.kind).toBe('ready');
    s = transition(s, ev.pushStarted('card_1', 'show weather'));
    expect(s.kind).toBe('constructing');
    s = transition(s, ev.stackItemAppended('card_1'));
    expect(s).toEqual({
      kind: 'content',
      activeItemId: 'card_1',
      substate: { kind: 'idle' },
    });
    s = transition(s, ev.consumePolling('card_1'));
    expect((s as { substate: { kind: string } }).substate.kind).toBe('listening');
    s = transition(s, ev.actionDrained('card_1'));
    expect((s as { substate: { kind: string } }).substate.kind).toBe('idle');
    s = transition(s, ev.stackEmptied());
    expect(s).toEqual({ kind: 'ready' });
  });
});

// `beforeAll` import (vitest auto-globals).
import { beforeAll } from 'vitest';
