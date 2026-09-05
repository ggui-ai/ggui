import { describe, expect, it, vi } from 'vitest';
import { armDrainDeadline } from './drain-deadline';

type Timer = { unref: () => void };

function harness() {
  let fired: (() => void) | null = null;
  const timer: Timer = { unref: vi.fn() };
  const setTimer = vi.fn((fn: () => void, _ms: number): Timer => {
    fired = fn;
    return timer;
  });
  const exit = vi.fn();
  const stderr = vi.fn();
  return {
    timer,
    setTimer,
    exit,
    stderr,
    fire: () => {
      if (!fired) throw new Error('deadline was never armed');
      fired();
    },
  };
}

describe('armDrainDeadline (the success path drains; this is the bounded fallback)', () => {
  it('arms an unref\'d timer for the deadline so the deadline itself never keeps the loop alive', () => {
    const h = harness();
    armDrainDeadline({ exitCode: 0, deadlineMs: 5_000, exit: h.exit, stderr: h.stderr, setTimer: h.setTimer, liveResources: () => [] });
    expect(h.setTimer).toHaveBeenCalledWith(expect.any(Function), 5_000);
    expect(h.timer.unref).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('when the loop has not drained by the deadline: names the live resources on stderr and hard-exits with the code', () => {
    const h = harness();
    armDrainDeadline({ exitCode: 3, deadlineMs: 5_000, exit: h.exit, stderr: h.stderr, setTimer: h.setTimer, liveResources: () => ['TCPServerWrap', 'Timeout'] });
    h.fire();
    expect(h.stderr).toHaveBeenCalledTimes(1);
    const line = h.stderr.mock.calls[0]?.[0] as string;
    expect(line).toMatch(/did not drain within 5000ms/);
    expect(line).toMatch(/TCPServerWrap, Timeout/);
    expect(h.exit).toHaveBeenCalledWith(3);
  });

  it('a drained loop never reaches the deadline — nothing is written and exit is not called', () => {
    const h = harness();
    armDrainDeadline({ exitCode: 0, deadlineMs: 5_000, exit: h.exit, stderr: h.stderr, setTimer: h.setTimer, liveResources: () => [] });
    expect(h.stderr).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });
});
