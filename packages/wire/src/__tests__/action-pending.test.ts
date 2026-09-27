/**
 * ggui#1398 — a dispatched action's in-flight state, as data.
 *
 * THE OBSERVABLE VIOLATION (#1376's prod read): the visitor re-tapped 1.5 s,
 * 5 s and 8.6 s after the first tap, because the card showed nothing while the
 * agent reacted (14–17 s to the new card). A generated card had nothing to
 * paint "sending" from: `useActionSpent` says a oneShot fired, nothing says a
 * dispatch is waiting for its answer. `buildWireConfig` now exposes that as a
 * source (`actionPending`): pending from the committed dispatch until the
 * session's next frame lands, or a bound elapses so a host that never answers
 * cannot freeze the control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionSpec } from '@ggui-ai/protocol/wire';
import { buildWireConfig, StreamBus, type BuildWireConfigOptions } from '../wire-config';

const SPEC: ActionSpec = {
  confirm: { label: 'Confirm', oneShot: true },
  log: { label: 'Log' },
};

function harness(opts: { valid?: boolean; boundMs?: number } = {}) {
  const frames = new Set<() => void>();
  let emitted = 0;
  const base: BuildWireConfigOptions = {
    app: { appId: 'a', appName: 'a' },
    render: { sessionId: 's1', isConnected: true },
    auth: { isAuthenticated: false },
    getActiveActionSpec: () => SPEC,
    pendingInputsChanged: (listener) => {
      frames.add(listener);
      return () => {
        frames.delete(listener);
      };
    },
    ...(opts.boundMs !== undefined ? { actionPendingBoundMs: opts.boundMs } : {}),
    validateEnvelope: () =>
      opts.valid === false
        ? { valid: false, violations: [{ field: 'data', message: 'rejected on purpose' }] }
        : { valid: true, violations: [] },
    onViolation: () => undefined,
    emitEnvelope: () => {
      emitted += 1;
    },
    streamBus: new StreamBus(),
  };
  const config = buildWireConfig(base);
  const frameLands = (): void => {
    for (const listener of [...frames]) listener();
  };
  return { config, frameLands, emitted: () => emitted };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('actionPending — a dispatch waiting for its answer, as data (ggui#1398)', () => {
  it('nothing is pending before a gesture', () => {
    const { config } = harness();
    expect(config.actionPending.isPending('log')).toBe(false);
    expect(config.actionPending.isPending('confirm')).toBe(false);
  });

  it('a committed dispatch is pending, and notifies its subscribers, until the session’s next frame lands', () => {
    const { config, frameLands } = harness();
    const heard = vi.fn();
    config.actionPending.subscribe(heard);
    config.dispatch('log', {});
    expect(config.actionPending.isPending('log')).toBe(true);
    expect(config.actionPending.isPending('confirm')).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
    frameLands();
    expect(config.actionPending.isPending('log')).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('a dispatch the validator refuses never reached the agent, so it is not pending', () => {
    const { config, emitted } = harness({ valid: false });
    config.dispatch('log', {});
    expect(emitted()).toBe(0);
    expect(config.actionPending.isPending('log')).toBe(false);
  });

  it('a suppressed repeat of a spent oneShot action does not re-arm pending', () => {
    const { config, frameLands } = harness();
    config.dispatch('confirm', {});
    frameLands();
    expect(config.actionPending.isPending('confirm')).toBe(false);
    config.dispatch('confirm', {}); // suppressed: already spent
    expect(config.actionPending.isPending('confirm')).toBe(false);
  });

  it('a host that never answers cannot freeze the control: pending clears at the bound', () => {
    vi.useFakeTimers();
    const { config } = harness({ boundMs: 1_000 });
    const heard = vi.fn();
    config.actionPending.subscribe(heard);
    config.dispatch('log', {});
    vi.advanceTimersByTime(999);
    expect(config.actionPending.isPending('log')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(config.actionPending.isPending('log')).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('a frame with nothing pending notifies no one; a second dispatch before the answer restarts the bound', () => {
    vi.useFakeTimers();
    const { config, frameLands } = harness({ boundMs: 1_000 });
    const heard = vi.fn();
    config.actionPending.subscribe(heard);
    frameLands();
    expect(heard).not.toHaveBeenCalled();
    config.dispatch('log', {});
    vi.advanceTimersByTime(800);
    config.dispatch('log', {});
    vi.advanceTimersByTime(800);
    expect(config.actionPending.isPending('log')).toBe(true);
    vi.advanceTimersByTime(200);
    expect(config.actionPending.isPending('log')).toBe(false);
  });
});
