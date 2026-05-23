/**
 * Behavioral tests for the task-scoped dispatch dedup primitive.
 *
 * The primitive is load-bearing for the no-silent-block runtime safety
 * net in `useAction` — these cases lock the contract directly so a
 * future refactor of `tryAcceptDispatch` can't silently regress without
 * tripping the suite. The end-to-end behavior is covered separately by
 * the scenario-7 LLM-to-LLM round-trip; this file pins the unit-level
 * invariants the e2e relies on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetDispatchDedupForTests,
  payloadSignature,
  tryAcceptDispatch,
} from '../dispatch-dedup';

describe('payloadSignature', () => {
  it('encodes the action name and payload together', () => {
    expect(payloadSignature('toggle', { id: 'x' })).toBe(
      'toggle::{"id":"x"}',
    );
  });

  it('distinguishes the same payload across different action names', () => {
    expect(payloadSignature('a', { id: 1 })).not.toBe(
      payloadSignature('b', { id: 1 }),
    );
  });

  it('treats undefined payload as null for a stable signature', () => {
    expect(payloadSignature('x', undefined)).toBe('x::null');
  });

  it('returns null for un-serializable payloads (circular refs)', () => {
    interface Circular {
      self?: Circular;
    }
    const circular: Circular = {};
    circular.self = circular;
    expect(payloadSignature('x', circular)).toBeNull();
  });
});

describe('tryAcceptDispatch — task-scoped dedup', () => {
  afterEach(() => {
    __resetDispatchDedupForTests();
  });

  it('accepts the first dispatch in a task', () => {
    const decision = tryAcceptDispatch('toggle', { id: 'x' });
    expect(decision.suppressed).toBe(false);
    expect(decision.signature).toBe('toggle::{"id":"x"}');
  });

  it('suppresses an identical (name, payload) re-dispatch in the same task', () => {
    // Simulates the scenario-7 bug: one user click hits a Checkbox
    // `onChange` AND bubbles to an outer Card `onClick`, both wired to
    // the same `useAction` binding. Both fire dispatch synchronously
    // within the same event-loop task. The first wins; the second is
    // suppressed BEFORE reaching the wire.
    tryAcceptDispatch('toggle', { id: 'x' });
    const second = tryAcceptDispatch('toggle', { id: 'x' });
    expect(second.suppressed).toBe(true);
  });

  it('accepts a different payload with the same action name in the same task', () => {
    tryAcceptDispatch('toggle', { id: 'a' });
    const second = tryAcceptDispatch('toggle', { id: 'b' });
    expect(second.suppressed).toBe(false);
  });

  it('accepts the same payload under a different action name in the same task', () => {
    tryAcceptDispatch('toggle', { id: 'x' });
    const second = tryAcceptDispatch('log', { id: 'x' });
    expect(second.suppressed).toBe(false);
  });

  it('passes un-serializable payloads through (no signature, no dedup possible)', () => {
    // Circular payloads would fail JSON.stringify; the contract is to
    // skip dedup and forward the dispatch. The wire-level schema
    // validator rejects such payloads downstream — graceful
    // degradation rather than a swallowed error.
    interface Circular {
      self?: Circular;
    }
    const circular: Circular = {};
    circular.self = circular;
    expect(tryAcceptDispatch('x', circular).suppressed).toBe(false);
    expect(tryAcceptDispatch('x', circular).suppressed).toBe(false);
  });

  it('clears the dedup set after the microtask drain (next gesture passes)', async () => {
    // A genuine second user gesture is a separate event-loop task, so
    // the microtask scheduled by the first dispatch has already
    // drained the set before the next task runs. Verify by awaiting a
    // microtask boundary between the two dispatches.
    const first = tryAcceptDispatch('toggle', { id: 'x' });
    expect(first.suppressed).toBe(false);
    await new Promise<void>((resolve) => {
      queueMicrotask(() => resolve());
    });
    const second = tryAcceptDispatch('toggle', { id: 'x' });
    expect(second.suppressed).toBe(false);
  });

  it('multiple distinct actions accumulate in the same task without colliding', () => {
    expect(tryAcceptDispatch('a', { n: 1 }).suppressed).toBe(false);
    expect(tryAcceptDispatch('b', { n: 1 }).suppressed).toBe(false);
    expect(tryAcceptDispatch('c', { n: 1 }).suppressed).toBe(false);
    // Re-firing any of them is suppressed.
    expect(tryAcceptDispatch('b', { n: 1 }).suppressed).toBe(true);
  });

  it('surfaces the decision signature so callers (useAction) can hand it to onDispatchSuppressed', () => {
    // `tryAcceptDispatch` returns `{ suppressed, signature }`. The
    // signature is what `useAction` forwards into the optional
    // `WireConfig.onDispatchSuppressed` observability hook so hosts
    // can route structured events to telemetry sinks without
    // re-computing the key.
    const first = tryAcceptDispatch('toggle', { id: 'x' });
    const second = tryAcceptDispatch('toggle', { id: 'x' });
    expect(first.signature).toBe(second.signature);
    expect(second.signature).toBe('toggle::{"id":"x"}');
  });
});
