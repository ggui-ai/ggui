/**
 * ggui#1679 — the runtime's render-failure reporter: ONE
 * `ggui_runtime_report_render_failure` per session and phase, ids and counts
 * only, never retried.
 *
 * The obligation the server-side tool states (`reportRenderFailureInputShape`,
 * ggui#1609) and the harm-stop read counts on (#1389): a card that throws past
 * the boundary's retries is reported once for the session it renders, in the
 * phase it failed. These specs pin the reporter alone, with a recording
 * `callTool`; the proof-carrying call site is pinned in
 * `render-failure-proof.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { RENDER_FAILURE_MAX_CATCHES } from '@ggui-ai/protocol';
import { createRenderFailureReporter } from '../render-failure-report.js';

const SESSION = 'render_1679_a';
const APP = 'app_1679';

function recorder(outcome: 'resolves' | 'rejects' = 'resolves') {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (outcome === 'rejects') throw new Error('tool not found: ggui_runtime_report_render_failure');
    return { ok: true };
  });
  return { calls, callTool };
}

describe('createRenderFailureReporter (ggui#1679)', () => {
  it('reports the first failure once, in the server\'s terms: ids, phase, the class name, the catch count', async () => {
    const { calls, callTool } = recorder();
    const reporter = createRenderFailureReporter({ sessionId: SESSION, appId: APP, callTool });

    reporter.report({ error: new RangeError('the message never travels'), phase: 'mount', catches: 2 });
    await Promise.resolve();

    expect(calls).toEqual([
      {
        name: 'ggui_runtime_report_render_failure',
        args: { sessionId: SESSION, appId: APP, phase: 'mount', errorName: 'RangeError', catches: 2 },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain('the message never travels');
  });

  it('a second failure in the same session and phase sends nothing', async () => {
    const { calls, callTool } = recorder();
    const reporter = createRenderFailureReporter({ sessionId: SESSION, appId: APP, callTool });

    reporter.report({ error: new Error('a'), phase: 'mount', catches: 2 });
    reporter.report({ error: new Error('b'), phase: 'mount', catches: 3 });
    await Promise.resolve();

    expect(calls).toHaveLength(1);
  });

  it('at most one per SESSION (SPEC §4.9): a later failure in the other phase sends nothing more, and reported() reads true', async () => {
    const { calls, callTool } = recorder();
    const reporter = createRenderFailureReporter({ sessionId: SESSION, appId: APP, callTool });
    expect(reporter.reported()).toBe(false);

    reporter.report({ error: new Error('a'), phase: 'mount', catches: 2 });
    reporter.report({ error: new TypeError('b'), phase: 'update', catches: 2 });
    await Promise.resolve();

    expect(calls.map((c) => [c.args['phase'], c.args['errorName']])).toEqual([['mount', 'Error']]);
    expect(reporter.reported()).toBe(true);
  });

  it('a failed report is never retried: the entry stays spent, the next failure in that phase sends nothing, and nothing throws', async () => {
    const { calls, callTool } = recorder('rejects');
    const reporter = createRenderFailureReporter({ sessionId: SESSION, appId: APP, callTool });

    expect(() => reporter.report({ error: new Error('a'), phase: 'mount', catches: 2 })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    reporter.report({ error: new Error('b'), phase: 'mount', catches: 2 });
    await Promise.resolve();

    expect(calls).toHaveLength(1);
  });

  it('what was thrown is reduced to a class name under the tool\'s pattern; anything else reports as Error; catches is clamped to the tool\'s bound', async () => {
    const { calls, callTool } = recorder();
    const reporter = createRenderFailureReporter({ sessionId: SESSION, appId: APP, callTool });
    const renamed = new Error('x');
    renamed.name = 'not a code identifier: ' + 'secret-looking value';

    reporter.report({ error: renamed, phase: 'mount', catches: RENDER_FAILURE_MAX_CATCHES + 50 });
    await Promise.resolve();
    // A second reporter (another session) with a subclass whose `name` is the
    // base one, and a count below the floor.
    const other = recorder();
    const second = createRenderFailureReporter({ sessionId: 'render_1679_b', appId: APP, callTool: other.callTool });
    second.report({ error: new (class Weird extends Error {})('w'), phase: 'update', catches: 0 });
    await Promise.resolve();

    expect(calls.map((c) => [c.args['errorName'], c.args['catches']])).toEqual([['Error', RENDER_FAILURE_MAX_CATCHES]]);
    expect(other.calls.map((c) => [c.args['errorName'], c.args['catches']])).toEqual([['Error', 1]]);
    expect(JSON.stringify(calls)).not.toContain('secret-looking');
  });
});
