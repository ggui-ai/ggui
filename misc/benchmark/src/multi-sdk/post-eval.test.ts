import { describe, it, expect } from 'vitest';
import {
  aggregatePanel,
  retryWithBackoff,
  createLimiter,
  buildJudgeDisclosure,
  AESTHETIC_PROMPT_VERSION_PANEL,
  type SingleJudgeResult,
  type AestheticScores,
} from './post-eval.js';

describe('buildJudgeDisclosure (effective sampling, #713)', () => {
  it('records the sampling the router reports it applied', () => {
    expect(
      buildJudgeDisclosure('claude-opus-5', {
        temperature: 'provider-default',
        strippedReason: 'claude-opus-5 rejects sampling params',
      }),
    ).toEqual({
      model: 'claude-opus-5',
      promptVersion: AESTHETIC_PROMPT_VERSION_PANEL,
      sampling: { temperature: 'provider-default', strippedReason: 'claude-opus-5 rejects sampling params' },
    });
  });

  it('omits the sampling key entirely when the router reported none — unknown, not assumed', () => {
    const d = buildJudgeDisclosure('gpt-5.4-mini', undefined);
    expect(d).toEqual({ model: 'gpt-5.4-mini', promptVersion: AESTHETIC_PROMPT_VERSION_PANEL });
    expect('sampling' in d).toBe(false);
  });
});

/** Build a SingleJudgeResult with the given score + (optionally) per-dim scores. */
function judge(score: number, dims?: Partial<AestheticScores>): SingleJudgeResult {
  const dimensions: AestheticScores = {
    layout: score,
    designTokens: score,
    hierarchy: score,
    polish: score,
    dataPresentation: score,
    ...dims,
  };
  return {
    judge: { model: 'test', promptVersion: 'aesthetic-eval.v2-panel' },
    score,
    dimensions,
    critique: `critique@${score}`,
    tokens: { input: 100, output: 50 },
  };
}

describe('aggregatePanel', () => {
  it('averages 3 judges (80/70/90 → score 80, spread 20)', () => {
    const result = aggregatePanel([judge(80), judge(70), judge(90)]);
    expect(result).not.toBeNull();
    expect(result?.score).toBe(80);
    expect(result?.spread).toBe(20);
  });

  it('averages per-dimension independently (layout 60/70/80 → 70)', () => {
    const result = aggregatePanel([
      judge(75, { layout: 60 }),
      judge(75, { layout: 70 }),
      judge(75, { layout: 80 }),
    ]);
    expect(result).not.toBeNull();
    expect(result?.dimensions.layout).toBe(70);
    // The other dims are all 75 across judges → mean stays 75.
    expect(result?.dimensions.designTokens).toBe(75);
    expect(result?.dimensions.hierarchy).toBe(75);
    expect(result?.dimensions.polish).toBe(75);
    expect(result?.dimensions.dataPresentation).toBe(75);
  });

  it('rounds means to 1 decimal place', () => {
    // 70/71/73 → mean 71.333… → 71.3
    const result = aggregatePanel([judge(70), judge(71), judge(73)]);
    expect(result?.score).toBe(71.3);
  });

  it('returns null for a 1-judge "panel"', () => {
    expect(aggregatePanel([judge(85)])).toBeNull();
  });

  it('returns null for 0 judges', () => {
    expect(aggregatePanel([])).toBeNull();
  });

  it('aggregates a valid 2-judge panel (80/90 → score 85, spread 10)', () => {
    const result = aggregatePanel([judge(80), judge(90)]);
    expect(result).not.toBeNull();
    expect(result?.score).toBe(85);
    expect(result?.spread).toBe(10);
  });
});

describe('retryWithBackoff', () => {
  /** Injectable sleep that records requested delays and resolves immediately. */
  function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
    const delays: number[] = [];
    return {
      sleep: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      },
      delays,
    };
  }

  it('returns the first non-null result without retrying', async () => {
    const { sleep, delays } = fakeSleep();
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        return 'ok';
      },
      { attempts: 3, baseDelayMs: 5000, sleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('retries on null and returns the eventual success', async () => {
    const { sleep } = fakeSleep();
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        return calls < 3 ? null : 'ok';
      },
      { attempts: 3, baseDelayMs: 5000, sleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('retries on a thrown error and returns the eventual success', async () => {
    const { sleep } = fakeSleep();
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls === 1) throw new Error('429 rate limited');
        return 'ok';
      },
      { attempts: 3, baseDelayMs: 5000, sleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('backs off exponentially between attempts (5s then 10s)', async () => {
    const { sleep, delays } = fakeSleep();
    await retryWithBackoff(async () => null, { attempts: 3, baseDelayMs: 5000, sleep });
    expect(delays).toEqual([5000, 10000]);
  });

  it('returns null (never throws) after exhausting all attempts', async () => {
    const { sleep } = fakeSleep();
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        throw new Error('persistent failure');
      },
      { attempts: 3, baseDelayMs: 5000, sleep },
    );
    expect(result).toBeNull();
    expect(calls).toBe(3);
  });
});

describe('createLimiter', () => {
  /** A task that resolves on demand, tracking a shared in-flight counter. */
  function gatedTask(counter: { inFlight: number; peak: number }) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async () => {
      counter.inFlight++;
      counter.peak = Math.max(counter.peak, counter.inFlight);
      await gate;
      counter.inFlight--;
      return counter.peak;
    };
    return { run, release };
  }

  it('never exceeds the concurrency cap', async () => {
    const limit = createLimiter(2);
    const counter = { inFlight: 0, peak: 0 };
    const tasks = Array.from({ length: 5 }, () => gatedTask(counter));
    const promises = tasks.map((t) => limit(t.run));
    // Let the limiter admit what it will, then release everything.
    await new Promise((r) => setTimeout(r, 0));
    expect(counter.inFlight).toBe(2);
    for (const t of tasks) t.release();
    await Promise.all(promises);
    expect(counter.peak).toBe(2);
  });

  it('re-checks the cap on wake — a fresh caller in the release window cannot overshoot', async () => {
    const limit = createLimiter(1);
    const counter = { inFlight: 0, peak: 0 };
    const a = gatedTask(counter);
    const b = gatedTask(counter);
    const c = gatedTask(counter);
    const pa = limit(a.run);
    const pb = limit(b.run); // queued behind a
    await new Promise((r) => setTimeout(r, 0));
    a.release();
    // Land a fresh call in the microtask window between a's slot release
    // (finally → next() wakes b) and b's queued resumption — without a
    // wake re-check, BOTH admit. Two ticks: a's completion resolves
    // through `await fn()` before its finally releases the slot.
    const pc = Promise.resolve()
      .then(() => undefined)
      .then(() => limit(c.run));
    await new Promise((r) => setTimeout(r, 0));
    expect(counter.inFlight).toBe(1);
    b.release();
    c.release();
    await Promise.all([pa, pb, pc]);
    expect(counter.peak).toBe(1);
  });

  it('returns each task result and keeps admitting after a rejection', async () => {
    const limit = createLimiter(1);
    const results = await Promise.allSettled([
      limit(async () => 'a'),
      limit(async () => {
        throw new Error('boom');
      }),
      limit(async () => 'c'),
    ]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'a' });
    expect(results[1].status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'c' });
  });
});
