/**
 * The `dispatch-idempotency` catalog grades a server, so it is graded here
 * against fake servers whose behaviour is known: a correct one passes every
 * case, one that does not dedupe warns on every case, one that keeps the
 * SECOND gesture of a reused id warns on that case only, and a host without
 * the seam or the tools is skipped with the reason named. The rest are the
 * ways a server can look idempotent and not be: deduping by content instead
 * of by id, by id across sessions, or with a check-then-write race; and a
 * driver that throws or a read that answers `isError`, each named rather
 * than read as an empty pipe.
 */
import { describe, expect, it } from 'vitest';
import type { RawToolCallResult, ToolCallScenario } from '../domain-error-conformance/index.js';
import {
  runDispatchIdempotencyConformance,
  type DispatchIdempotencyHost,
  type DispatchIdempotencySession,
} from './index.js';

type Behaviour =
  | 'correct'
  | 'no-dedupe'
  | 'last-wins'
  | 'refuse-reuse'
  /** Dedupes by what the gesture carries, not by its id. */
  | 'by-content'
  /** Dedupes by id across every session, not per session. */
  | 'global-id'
  /** Reads the ledger of ids, yields, then writes: two in flight both miss. */
  | 'racing'
  /** The transport throws on every dispatch. */
  | 'throws'
  /** `ggui_consume` answers `isError`. */
  | 'consume-error';

/** A fake server holding one session's pipe and ledger, deduping as told. */
function fakeHost(behaviour: Behaviour): DispatchIdempotencyHost {
  let pipe: Array<Record<string, unknown>> = [];
  let ledger: Array<Record<string, unknown>> = [];
  const seen = new Map<string, string>();
  const ok = (structuredContent: unknown): RawToolCallResult => ({ content: [], structuredContent });
  const callTool = async (scenario: ToolCallScenario): Promise<RawToolCallResult | null> => {
    const args = scenario.args;
    if (scenario.tool === 'ggui_runtime_submit_action') {
      const payload = args['payload'];
      const actionId = String(args['actionId']);
      const envelope = { type: 'action', actionId, actionData: typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'actionData') : null };
      if (behaviour === 'throws') throw new Error('transport closed');
      const digest = JSON.stringify(envelope.actionData);
      const key = behaviour === 'by-content' ? digest : actionId;
      const prior = seen.get(key);
      if (behaviour === 'racing') await new Promise((resolve) => setTimeout(resolve, 0));
      if (behaviour !== 'no-dedupe' && prior !== undefined) {
        if (prior !== digest && behaviour === 'last-wins') {
          pipe = pipe.map((e) => (e['actionId'] === actionId ? envelope : e));
        }
        if (prior !== digest && behaviour === 'refuse-reuse') return ok({ ok: false, code: 'ACTION_ID_REUSED' });
        return ok({ ok: true });
      }
      seen.set(key, digest);
      pipe.push(envelope);
      ledger.push({ type: 'user.submitted', data: envelope });
      return ok({ ok: true });
    }
    if (scenario.tool === 'ggui_consume') {
      if (behaviour === 'consume-error') return { isError: true, content: [{ type: 'text', text: 'consume failed' }] };
      const events = pipe;
      pipe = [];
      return ok({ events, status: 'active' });
    }
    if (scenario.tool === 'ggui_runtime_pull') return ok({ events: ledger, lastSequence: ledger.length, hasMore: false });
    return null;
  };
  const openSession = async (): Promise<DispatchIdempotencySession> => {
    pipe = [];
    ledger = [];
    if (behaviour !== 'global-id') seen.clear();
    return { sessionId: 'sess-kit', appId: 'app-kit', close: async () => undefined };
  };
  return { callTool, openSession };
}

describe('runDispatchIdempotencyConformance (ggui#1519)', () => {
  it('a server that dedupes committed dispatches passes every case', async () => {
    const r = await runDispatchIdempotencyConformance(fakeHost('correct'));
    expect(r.passed.map((c) => c.name)).toEqual([
      'sequential-retry-is-one-gesture',
      'concurrent-retry-is-one-gesture',
      'reused-id-keeps-the-first-gesture',
    ]);
    expect([...r.warned, ...r.failed, ...r.skipped]).toEqual([]);
  });

  it('refusing a reused id with ACTION_ID_REUSED also passes (the answer the next release emits)', async () => {
    const r = await runDispatchIdempotencyConformance(fakeHost('refuse-reuse'));
    expect(r.passed).toHaveLength(3);
  });

  it('a server that does not dedupe WARNS on every case (SHOULD level), naming the second event and ledger row', async () => {
    const r = await runDispatchIdempotencyConformance(fakeHost('no-dedupe'));
    expect(r.warned.map((c) => c.name)).toEqual([
      'sequential-retry-is-one-gesture',
      'concurrent-retry-is-one-gesture',
      'reused-id-keeps-the-first-gesture',
    ]);
    expect(r.warned[0]?.detail).toContain('delivered 2 events');
    expect(r.warned[0]?.detail).toContain('2 user.submitted rows');
    expect(r.failed).toEqual([]);
  });

  it('a server that lets a reused id replace the first gesture warns on that case only', async () => {
    const r = await runDispatchIdempotencyConformance(fakeHost('last-wins'));
    expect(r.warned.map((c) => c.name)).toEqual(['reused-id-keeps-the-first-gesture']);
    expect(r.warned[0]?.detail).toContain('not the first gesture');
  });

  it('a server that dedupes by CONTENT, not by id, warns on every case: the control repeats the gesture under a new id', async () => {
    const r = await runDispatchIdempotencyConformance(fakeHost('by-content'));
    expect(r.warned).toHaveLength(3);
    expect(r.warned[0]?.detail).toContain("the control's gesture was delivered 0 times");
    expect(r.passed).toEqual([]);
  });

  it('a server that dedupes by id across SESSIONS warns from the second case on: the ids repeat across cases', async () => {
    const r = await runDispatchIdempotencyConformance(fakeHost('global-id'));
    expect(r.passed.map((c) => c.name)).toEqual(['sequential-retry-is-one-gesture']);
    expect(r.warned.map((c) => c.name)).toEqual(['concurrent-retry-is-one-gesture', 'reused-id-keeps-the-first-gesture']);
    expect(r.warned[0]?.detail).toContain('delivered 0 events');
  });

  it('a server whose dedupe races (check, yield, write) passes in sequence and warns in flight', async () => {
    const r = await runDispatchIdempotencyConformance(fakeHost('racing'));
    expect(r.warned.map((c) => c.name)).toEqual(['concurrent-retry-is-one-gesture']);
    expect(r.warned[0]?.detail).toContain('delivered 2 events');
  });

  it('a driver that throws warns on that case, naming the throw; the run goes on to the next case', async () => {
    const r = await runDispatchIdempotencyConformance(fakeHost('throws'));
    expect(r.warned).toHaveLength(3);
    expect(r.warned[0]?.detail).toContain('the case threw: transport closed');
  });

  it('a read that answers isError is named as such, not read as an empty pipe', async () => {
    const r = await runDispatchIdempotencyConformance(fakeHost('consume-error'));
    expect(r.warned).toHaveLength(3);
    expect(r.warned[0]?.detail).toContain('ggui_consume answered isError');
    expect(r.warned[0]?.detail).not.toContain('delivered 0 events');
  });

  it('a host with no openSession seam, or without the tools, is SKIPPED with the reason named', async () => {
    const noSeam = await runDispatchIdempotencyConformance({ callTool: fakeHost('correct').callTool });
    expect(noSeam.skipped).toHaveLength(3);
    expect(noSeam.skipped[0]?.detail).toContain('openSession');
    const noTools = await runDispatchIdempotencyConformance({
      callTool: async () => null,
      openSession: async () => ({ sessionId: 's', appId: 'a', close: async () => undefined }),
    });
    expect(noTools.skipped.map((c) => c.detail)).toEqual([
      'ggui_runtime_submit_action is not bound on this deployment',
      'ggui_runtime_submit_action is not bound on this deployment',
      'ggui_runtime_submit_action is not bound on this deployment',
    ]);
  });
});
