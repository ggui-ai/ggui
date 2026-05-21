/**
 * Unit tests for `RuntimeSupervisor`. Runs directly against the
 * stub adapter from `@ggui-ai/agent-runtime` — no HTTP, no
 * subprocesses — so each assertion is a statement about the
 * supervisor's own behaviour independent of dev-stack wiring.
 */
import { describe, expect, it } from 'vitest';
import { createStubAgentRuntime } from '@ggui-ai/agent-runtime';
import {
  RuntimeSupervisor,
  emptyRuntimeSnapshot,
  formatRuntimeEventLine,
  type RuntimeEventRecord,
} from './runtime-supervisor.js';

const BASE_INPUT = {
  projectRoot: '/tmp/fake',
  project: { slug: 'test', name: 'Test', protocol: '1.1' },
};

describe('RuntimeSupervisor', () => {
  it('snapshot() reflects the adapter name, capabilities, and handle runId', async () => {
    const { adapter } = createStubAgentRuntime({ name: 'weather-bot' });
    const handle = await adapter.start(BASE_INPUT);
    const supervisor = new RuntimeSupervisor({ adapter, handle });

    const snap = supervisor.snapshot();
    expect(snap.present).toBe(true);
    expect(snap.name).toBe('weather-bot');
    expect(snap.runId).toBe('stub-run-1');
    expect(snap.capabilities).toEqual({ observable: true, restartable: false });
    expect(snap.status).toBe('starting');
    supervisor.close();
    await handle.stop();
  });

  it('records events in emission order with monotonic sequence numbers', async () => {
    const { adapter, controller } = createStubAgentRuntime({ manualReady: true });
    const handle = await adapter.start(BASE_INPUT);
    const supervisor = new RuntimeSupervisor({ adapter, handle });

    controller.emitStatus('ready');
    controller.emitLog('stderr', 'one');
    controller.emitLog('stderr', 'two');
    controller.emitError('boom');

    const snap = supervisor.snapshot();
    const summary = snap.recentEvents.map((e) =>
      e.type === 'log' ? `log:${e.line}` : e.type === 'status' ? `status:${e.status}` : `error:${e.message}`,
    );
    expect(summary).toEqual(['status:ready', 'log:one', 'log:two', 'error:boom']);
    const seqs = snap.recentEvents.map((e) => e.sequence);
    expect(seqs).toEqual([1, 2, 3, 4]);
    supervisor.close();
    await handle.stop();
  });

  it('respects bufferSize — oldest events drop but sequence stays monotonic', async () => {
    const { adapter, controller } = createStubAgentRuntime({ manualReady: true });
    const handle = await adapter.start(BASE_INPUT);
    const supervisor = new RuntimeSupervisor({ adapter, handle, bufferSize: 3 });

    for (let i = 0; i < 6; i++) {
      controller.emitLog('stderr', `line-${i}`);
    }

    const snap = supervisor.snapshot();
    expect(snap.recentEvents.length).toBe(3);
    // Oldest-first ordering preserved; kept the LAST three.
    expect(snap.recentEvents.map((e) => (e.type === 'log' ? e.line : ''))).toEqual([
      'line-3',
      'line-4',
      'line-5',
    ]);
    // Sequence shows the rollover gap (4, 5, 6 — NOT restart at 1).
    expect(snap.recentEvents.map((e) => e.sequence)).toEqual([4, 5, 6]);
    supervisor.close();
    await handle.stop();
  });

  it('onEvent forwards each record, error in pipe does not break buffering', async () => {
    const { adapter, controller } = createStubAgentRuntime({ manualReady: true });
    const handle = await adapter.start(BASE_INPUT);
    const forwarded: RuntimeEventRecord[] = [];
    let throwOnce = true;
    const supervisor = new RuntimeSupervisor({
      adapter,
      handle,
      onEvent: (e) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('pipe broke');
        }
        forwarded.push(e);
      },
    });

    controller.emitLog('stderr', 'dropped-by-pipe');
    controller.emitLog('stderr', 'survived');
    controller.emitStatus('ready');

    // Buffer keeps everything regardless of pipe state.
    expect(supervisor.snapshot().recentEvents.length).toBe(3);
    // Pipe skipped the first event (threw) but kept forwarding.
    expect(forwarded.map((e) => (e.type === 'log' ? e.line : `status:${e.status}`))).toEqual([
      'survived',
      'status:ready',
    ]);
    supervisor.close();
    await handle.stop();
  });

  it('close() detaches the listener so further emits stop accruing', async () => {
    const { adapter, controller } = createStubAgentRuntime({ manualReady: true });
    const handle = await adapter.start(BASE_INPUT);
    const supervisor = new RuntimeSupervisor({ adapter, handle });

    controller.emitLog('stderr', 'before-close');
    supervisor.close();
    controller.emitLog('stderr', 'after-close');

    const snap = supervisor.snapshot();
    expect(snap.recentEvents.map((e) => (e.type === 'log' ? e.line : ''))).toEqual([
      'before-close',
    ]);
    // close() is idempotent.
    supervisor.close();
    await handle.stop();
  });

  it('lastEventAt tracks the most recent event timestamp, null before any', async () => {
    const { adapter, controller } = createStubAgentRuntime({ manualReady: true });
    const handle = await adapter.start(BASE_INPUT);
    const supervisor = new RuntimeSupervisor({ adapter, handle });
    expect(supervisor.snapshot().lastEventAt).toBeNull();

    controller.emitLog('stderr', 'first');
    const t1 = supervisor.snapshot().lastEventAt;
    expect(t1).not.toBeNull();
    controller.emitLog('stderr', 'second');
    const t2 = supervisor.snapshot().lastEventAt;
    expect(t2).not.toBeNull();
    expect(t2!).toBeGreaterThanOrEqual(t1!);
    supervisor.close();
    await handle.stop();
  });

  it('formatRuntimeEventLine produces stable log lines for all three event kinds', () => {
    expect(
      formatRuntimeEventLine({ type: 'status', status: 'ready', timestamp: 0, sequence: 1 }),
    ).toBe('[runtime status] ready');
    expect(
      formatRuntimeEventLine({
        type: 'log',
        stream: 'stdout',
        line: 'hello',
        timestamp: 0,
        sequence: 2,
      }),
    ).toBe('[runtime stdout] hello');
    expect(
      formatRuntimeEventLine({
        type: 'error',
        message: 'boom',
        timestamp: 0,
        sequence: 3,
      }),
    ).toBe('[runtime error]  boom');
  });

  it('emptyRuntimeSnapshot represents the no-runtime case with present:false', () => {
    const empty = emptyRuntimeSnapshot();
    expect(empty.present).toBe(false);
  });
});
