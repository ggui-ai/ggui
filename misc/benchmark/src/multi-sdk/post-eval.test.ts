import { describe, it, expect } from 'vitest';
import {
  aggregatePanel,
  retryWithBackoff,
  createLimiter,
  buildJudgeDisclosure,
  AESTHETIC_PROMPT_VERSION_PANEL,
  selectPanelPrompt,
  JUDGE_PANELS,
  DEFAULT_JUDGE_PANEL,
  parseJudgePanelId,
  type SingleJudgeResult,
  type AestheticScores,
} from './post-eval.js';
import { MODEL_REGISTRY } from '@ggui-ai/protocol';
import { resolveJudgeCostModelId } from './runner.js';
import { getDefaultVariants } from './variants.js';

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

describe('arm-neutral panel prompt (#973 §5b — experiment-lane promptVersion; the published page keeps the default)', () => {
  it('selects the default prompt + version when unset', () => {
    const { promptVersion } = selectPanelPrompt(undefined);
    expect(promptVersion).toBe(AESTHETIC_PROMPT_VERSION_PANEL);
  });

  it('the arm-neutral prompt carries its own promptVersion and does not reward a token vocabulary', () => {
    const { prompt, promptVersion } = selectPanelPrompt('arm-neutral');
    expect(promptVersion).toBe('aesthetic-eval.v3-panel-arm-neutral');
    expect(promptVersion).not.toBe(AESTHETIC_PROMPT_VERSION_PANEL);
    expect(prompt).not.toMatch(/var\(--ggui/);
    expect(prompt).not.toMatch(/ggui design tokens/i);
    // still scores the same five keys so the report shape is unchanged
    for (const k of ['layout', 'designTokens', 'hierarchy', 'polish', 'dataPresentation']) expect(prompt).toContain(`"${k}"`);
  });
});

describe('default panel prompt (#1350 — the design-system rubric is the public judge)', () => {
  it('is versioned by the panel that scores with it: v5-panel by default, v4-panel on the bridge panel', () => {
    expect(selectPanelPrompt(undefined).promptVersion).toBe('aesthetic-eval.v5-panel');
    expect(AESTHETIC_PROMPT_VERSION_PANEL).toBe(`aesthetic-eval.${DEFAULT_JUDGE_PANEL}`);
    expect(selectPanelPrompt(undefined, 'v4-panel')).toEqual({ ...selectPanelPrompt(undefined), promptVersion: 'aesthetic-eval.v4-panel' });
  });

  it('no longer names the retired roles, names the current ones, and puts typed variants first', () => {
    const { prompt } = selectPanelPrompt(undefined);
    expect(prompt).not.toMatch(/onSurface/);
    expect(prompt).not.toMatch(/\bsurface\b/);
    for (const role of ['container/onContainer', 'sunken/onSunken', 'outline', 'link', 'primary-*']) expect(prompt).toContain(role);
    expect(prompt).toMatch(/typed variants first/);
    for (const k of ['layout', 'designTokens', 'hierarchy', 'polish', 'dataPresentation']) expect(prompt).toContain(`"${k}"`);
  });
});

describe('JUDGE_PANELS (#1798): runs use v5-panel; v4-panel stays as the bridge; a candidate differs in one seat', () => {
  it('runs use v5-panel: claude-opus-5-5 in the Anthropic seat, the OpenAI and Google seats unchanged', () => {
    expect(DEFAULT_JUDGE_PANEL).toBe('v5-panel');
    expect(JUDGE_PANELS['v5-panel']).toEqual([
      { provider: 'anthropic', model: 'claude-opus-5-5' },
      { provider: 'openai', model: 'gpt-5.4-mini' },
      { provider: 'google', model: 'gemini-3.6-flash' },
    ]);
  });

  it('keeps v4-panel, the judges every run used from 10-16 to 10-20, for bridge re-judges', () => {
    expect(JUDGE_PANELS['v4-panel']).toEqual([
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      { provider: 'openai', model: 'gpt-5.4-mini' },
      { provider: 'google', model: 'gemini-3.6-flash' },
    ]);
  });

  it('each candidate keeps the OpenAI and Google seats and changes only the Anthropic one', () => {
    const base = JUDGE_PANELS['v4-panel'];
    for (const [id, panel] of Object.entries(JUDGE_PANELS)) {
      if (id === 'v4-panel') continue;
      expect(panel.map((j) => j.provider), id).toEqual(base.map((j) => j.provider));
      const changed = panel.filter((j, i) => j.model !== base[i]!.model);
      expect(changed, id).toHaveLength(1);
      expect(changed[0]!.provider, id).toBe('anthropic');
    }
  });

  it('every judge in every panel is priced, so a calibration never reports a silent $0', () => {
    for (const panel of Object.values(JUDGE_PANELS)) {
      for (const j of panel) expect(MODEL_REGISTRY, j.model).toHaveProperty([resolveJudgeCostModelId(j.model)]);
    }
  });

  it('the opus-5 candidate seat is not a generator under test (the 2026-10-10 entry\'s stated intent)', () => {
    const arms = new Set(getDefaultVariants().map((v) => v.modelId));
    expect(arms.has(resolveJudgeCostModelId(JUDGE_PANELS['cand-anthropic-opus-5'][0].model))).toBe(false);
    expect(arms.has(resolveJudgeCostModelId(JUDGE_PANELS['cand-anthropic-haiku-5-5'][0].model))).toBe(true);
  });

  it('the v5-panel Anthropic seat IS a generator under test (the claude-premium arm), which the page discloses', () => {
    const premium = getDefaultVariants().find((v) => v.id === 'claude-premium');
    expect(premium?.modelId).toBe(resolveJudgeCostModelId(JUDGE_PANELS['v5-panel'][0].model));
  });

  it('parses a known id and is loud on an unknown one', () => {
    expect(parseJudgePanelId('cand-anthropic-haiku-5-5')).toBe('cand-anthropic-haiku-5-5');
    expect(() => parseJudgePanelId('v6-panel')).toThrow(/unknown judge panel 'v6-panel'/);
    expect(() => parseJudgePanelId('constructor')).toThrow(/unknown judge panel/);
  });
});
