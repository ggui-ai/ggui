/**
 * Post-Generation Aesthetic Evaluation
 *
 * Lightweight LLM-based evaluation that scores generated components on
 * ggui-specific quality criteria. Runs after generation, before reporting.
 *
 * {@link evaluateAestheticsPanel} — a 3-provider judge PANEL (Anthropic +
 * OpenAI + Google) that REQUESTS temperature 0 for reproducibility and
 * discloses, per judge, the sampling the router actually applied (model
 * families that reject sampling params get it stripped — ggui#710/#713);
 * reports the mean score and the spread (max−min) so a single biased
 * self-judge can no longer dominate.
 *
 * Routes its LLM calls through `@ggui-ai/ui-gen/harness`'s `callLLM`,
 * which reads provider keys from env (ANTHROPIC_API_KEY / OPENAI_API_KEY /
 * GEMINI_API_KEY|GOOGLE_API_KEY).
 */

import { callLLM, type AgentConfig, type LLMResponse } from '@ggui-ai/ui-gen/harness';

/**
 * The sampling the router reports it ACTUALLY applied to a judge call —
 * derived from the response contract so the disclosure can never drift
 * from what the harness emits (ggui#710: Opus 4.7+/5-family reject
 * sampling params; the router strips them and says so).
 */
export type JudgeSampling = NonNullable<LLMResponse['sampling']>;

/**
 * Extract the first balanced JSON object from LLM output. Handles the case
 * where the model returns commentary before and/or after the JSON block —
 * a greedy `/\{[\s\S]*\}/` regex over-captures trailing commentary and
 * JSON.parse crashes. This walks the string honoring string literals and
 * returns the first substring bounded by matched `{`/`}`.
 */
export function extractBalancedJson(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

export interface AestheticScores {
  /** Layout quality: proper grid/flex usage, responsive, no overflow/clipping */
  layout: number;
  /** Design token usage: semantic colors, spacing tokens, no hardcoded values */
  designTokens: number;
  /** Visual hierarchy: clear headings, proper contrast, scannable structure */
  hierarchy: number;
  /** Component polish: hover states, transitions, loading states, empty states */
  polish: number;
  /** Data presentation: proper rendering of props data, no placeholder remnants */
  dataPresentation: number;
}

/**
 * Judge disclosure — recorded on every {@link SingleJudgeResult} and
 * propagated into report meta + the published headline so readers know
 * which model and prompt produced the quality score.
 */
export interface JudgeDisclosure {
  /** Pinned judge model id. */
  model: string;
  /** Version tag of the scoring prompt that produced this score. */
  promptVersion: string;
  /**
   * Effective sampling per the router's report (#713). The panel REQUESTS
   * temperature 0; this records what was applied — `'provider-default'`
   * with a reason when the model family rejects sampling params. Absent
   * when the router reported nothing (unknown, never assumed).
   */
  sampling?: JudgeSampling;
}

/**
 * Build a judge's disclosure from the router's applied-sampling report.
 * Pure — unit-tested directly; {@link runSingleJudge} is the only caller.
 */
export function buildJudgeDisclosure(
  model: string,
  sampling: JudgeSampling | undefined,
): JudgeDisclosure {
  return {
    model,
    promptVersion: AESTHETIC_PROMPT_VERSION_PANEL,
    ...(sampling !== undefined ? { sampling } : {}),
  };
}

/** System prompt for the aesthetic judge panel. Module-private. */
const AESTHETIC_EVAL_PROMPT = `You are a UI quality evaluator for ggui, a platform that generates React components.

Score the following generated component source code on 5 aesthetic dimensions (0-100 each):

1. **layout** (20%): Is the layout correct? Proper grid/flex usage, responsive, no overflow or clipping issues, appropriate spacing between elements.

2. **designTokens** (20%): Does it use ggui design tokens? Check for:
   - var(--ggui-color-*) for colors (especially semantic: surface, onSurface, outline)
   - var(--ggui-spacing-*) for padding/margins
   - NO hardcoded hex colors, NO rgba()/hsl(), NO raw pixel values for spacing

3. **hierarchy** (20%): Clear visual hierarchy? Proper heading sizes, section separation, scannable structure, good use of whitespace.

4. **polish** (20%): Interactive polish? Hover/focus states on buttons/links, transitions, disabled states on forms, loading indicators where appropriate.

5. **dataPresentation** (20%): Does it render data from props correctly? No placeholder text like "Lorem ipsum", no hardcoded example data in the component body (defaults in props are OK), proper formatting of numbers/dates.

Respond with ONLY a JSON object, no markdown:
{
  "layout": <0-100>,
  "designTokens": <0-100>,
  "hierarchy": <0-100>,
  "polish": <0-100>,
  "dataPresentation": <0-100>,
  "critique": "<2-3 sentences summarizing the main issues>"
}`;

/** Per-dimension weights — equal 20% each, summing to 100%. */
const WEIGHTS = { layout: 0.2, designTokens: 0.2, hierarchy: 0.2, polish: 0.2, dataPresentation: 0.2 };

/**
 * Build the judge user message: original prompt + (optional) data contract +
 * the full component source. Full source/prompt are sent untruncated; an
 * earlier slice(0, 8000)/slice(0, 500) clamp amputated mid-complexity
 * components and led judges to hallucinate "incomplete code". The contract
 * block lets the judge see the same shape the generator saw — stops "missing
 * X" hallucinations against UNAMPUTATED source.
 */
function buildJudgeUserMessage(sourceCode: string, prompt: string, contract?: unknown): string {
  const contractBlock = contract
    ? `\n\nData contract:\n\`\`\`json\n${JSON.stringify(contract, null, 2).slice(0, 3000)}\n\`\`\``
    : '';
  return `Original prompt: ${prompt}${contractBlock}\n\nComponent source code:\n\`\`\`tsx\n${sourceCode}\n\`\`\``;
}

/** Compute the equal-weighted 5-dimension score, rounded to 1dp. */
function weightedScore(scores: AestheticScores): number {
  const raw =
    scores.layout * WEIGHTS.layout +
    scores.designTokens * WEIGHTS.designTokens +
    scores.hierarchy * WEIGHTS.hierarchy +
    scores.polish * WEIGHTS.polish +
    scores.dataPresentation * WEIGHTS.dataPresentation;
  return Math.round(raw * 10) / 10;
}

// =============================================================================
// Resilience primitives (retry + concurrency cap) — #565 item 1
// =============================================================================

export interface RetryOptions {
  /** Total attempts, including the first (>= 1). */
  attempts: number;
  /** Delay before the first retry; doubles per subsequent retry. */
  baseDelayMs: number;
  /** Injectable sleep for tests. Defaults to a real setTimeout wait. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retry an operation whose failure modes are BOTH `null` returns (the
 * judge contract — see {@link runSingleJudge}) and thrown errors. Waits
 * `baseDelayMs * 2^n` between attempts. Never throws: after the final
 * attempt fails, returns null so the caller's swallow-and-aggregate
 * contract is preserved — the point is that failures stop being FIRST-try
 * failures, not that they become fatal.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T | null>,
  opts: RetryOptions,
): Promise<T | null> {
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    if (attempt > 0) await sleep(opts.baseDelayMs * 2 ** (attempt - 1));
    try {
      const result = await fn();
      if (result !== null) return result;
    } catch {
      // fall through to the next attempt; the final failure returns null
    }
  }
  return null;
}

/**
 * Minimal promise-concurrency limiter: at most `max` wrapped calls run at
 * once; excess callers queue FIFO. A rejection releases its slot like any
 * completion — the queue keeps draining. Woken waiters RE-CHECK the cap
 * (`while`, not `if`): a fresh caller can land in the microtask window
 * between a slot release and the waiter's resumption and legitimately take
 * the slot — without the re-check both would admit and overshoot `max`.
 * A re-queued waiter is always woken again: whoever holds the contested
 * slot calls `next()` on completion.
 */
export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

// =============================================================================
// Panel evaluation (3-provider, avg + spread, temp 0)
// =============================================================================

// v3-panel (2026-08-19): google judge gemini-3-flash-preview → gemini-3.5-flash
// (the preview id is gone from the current Gemini model docs; 3.5-flash is the
// GA replacement). Prompt text unchanged. Bumped per the PANEL docstring —
// no prior comparable data exists (every earlier run failed on auth, #557),
// so this is the zero-cost moment to move the panel to GA ids.
export const AESTHETIC_PROMPT_VERSION_PANEL = 'aesthetic-eval.v3-panel';

/** One judge's contribution to a panel. */
export interface SingleJudgeResult {
  judge: JudgeDisclosure;
  /** Weighted score (0-100), 1dp. */
  score: number;
  dimensions: AestheticScores;
  critique: string;
  /** Token counts from the LLM call — needed for cost accounting. */
  tokens: { input: number; output: number };
}

export interface PanelEvalResult {
  passed: boolean;
  score: number;
  dimensions: AestheticScores;
  /** max−min of the surviving judges' weighted scores (1dp) — disagreement signal. */
  spread: number;
  /** Per-judge breakdown (includes tokens) for the judges that responded. */
  judges: SingleJudgeResult[];
  promptVersion: string;
  critique: string;
  evalTimeMs: number;
}

/**
 * The judge panel. One model per provider, scored at temperature 0 so a
 * re-run is reproducible. Changing this set or the prompt invalidates score
 * comparability across runs; bump {@link AESTHETIC_PROMPT_VERSION_PANEL}.
 */
const PANEL = [
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  { provider: 'openai', model: 'gpt-5.4-mini' },
  { provider: 'google', model: 'gemini-3.5-flash' },
] as const;

/**
 * Judge-call resilience knobs (#565 item 1). The first real run (2026-08-19)
 * fired ~237 judge calls in 6 minutes with NO cap and NO retry: coverage
 * decayed front-to-back (claude-balanced 9/9 evaluated → google-balanced
 * 0/10 — the rate-limit signature), landing at 24/79 = 30% overall.
 *
 * - Cap: 9 concurrent judge calls ACROSS all panels. Each panel fires one
 *   call per provider, so ~3 in-flight per provider at the cap — far under
 *   provider rate limits while barely stretching wall time (judges are
 *   seconds-cheap next to 30-300s generations).
 * - Retry: 3 attempts, 5s → 10s backoff — enough to ride out a short 429
 *   window; a provider outage still degrades to null after ~15s.
 */
const JUDGE_CONCURRENCY = 9;
const JUDGE_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 5000 };

/** Module-wide limiter: one gate for every panel this process runs. */
const judgeLimit = createLimiter(JUDGE_CONCURRENCY);

/**
 * Run a single panel judge. Builds the shared judge user message and calls
 * `callLLM` at temperature 0. Returns null (and logs) on any failure —
 * empty/unparseable response or a thrown provider error — so a flaky judge
 * doesn't sink the panel; the panel aggregator tolerates missing judges down
 * to a 2-judge floor.
 */
async function runSingleJudge(
  provider: AgentConfig['provider'],
  model: string,
  sourceCode: string,
  prompt: string,
  contract?: unknown,
): Promise<SingleJudgeResult | null> {
  try {
    const userMessage = buildJudgeUserMessage(sourceCode, prompt, contract);
    const response = await callLLM(
      { provider, model, temperature: 0 },
      AESTHETIC_EVAL_PROMPT,
      userMessage,
      2000,
    );

    const jsonBlock = extractBalancedJson(response.text);
    if (!jsonBlock) {
      console.warn(`[post-eval] judge ${provider}/${model} failed: no JSON in response`);
      return null;
    }

    const parsed = JSON.parse(jsonBlock) as AestheticScores & { critique: string };
    const dimensions: AestheticScores = {
      layout: parsed.layout,
      designTokens: parsed.designTokens,
      hierarchy: parsed.hierarchy,
      polish: parsed.polish,
      dataPresentation: parsed.dataPresentation,
    };

    return {
      judge: buildJudgeDisclosure(model, response.sampling),
      score: weightedScore(dimensions),
      dimensions,
      critique: parsed.critique,
      tokens: { input: response.inputTokens, output: response.outputTokens },
    };
  } catch (err) {
    console.warn(`[post-eval] judge ${provider}/${model} failed:`, err);
    return null;
  }
}

/**
 * Aggregate a panel of judge results into mean score + per-dim means + spread.
 * Pure — no LLM, no clock — so it is unit-tested directly. A "panel" needs at
 * least 2 judges; a lone surviving judge isn't a panel, so we return null.
 */
export function aggregatePanel(
  results: SingleJudgeResult[],
): { score: number; dimensions: AestheticScores; spread: number } | null {
  if (results.length < 2) return null; // a 1-judge "panel" isn't one
  const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
  const scores = results.map((r) => r.score);
  return {
    score: mean(scores),
    dimensions: {
      layout: mean(results.map((r) => r.dimensions.layout)),
      designTokens: mean(results.map((r) => r.dimensions.designTokens)),
      hierarchy: mean(results.map((r) => r.dimensions.hierarchy)),
      polish: mean(results.map((r) => r.dimensions.polish)),
      dataPresentation: mean(results.map((r) => r.dimensions.dataPresentation)),
    },
    spread: Math.round((Math.max(...scores) - Math.min(...scores)) * 10) / 10,
  };
}

/**
 * Run the 3-provider aesthetic judge panel. Fires all judges concurrently
 * (globally capped at {@link JUDGE_CONCURRENCY} in-flight calls across every
 * panel in the process, retried per {@link JUDGE_RETRY}), drops any that
 * still fail, then aggregates the survivors. Returns null when fewer than 2
 * judges respond (no defensible panel score).
 *
 * `contract` (optional): the commit's data contract — see
 * {@link buildJudgeUserMessage}.
 */
export async function evaluateAestheticsPanel(
  sourceCode: string,
  prompt: string,
  contract?: unknown,
): Promise<PanelEvalResult | null> {
  const startTime = Date.now();

  // Each judge: globally concurrency-capped per ATTEMPT, retried with
  // backoff on null/throw. The backoff sleep happens OUTSIDE the limiter
  // slot so a rate-limited judge doesn't block other judges while waiting.
  const settled = await Promise.all(
    PANEL.map((p) =>
      retryWithBackoff(
        () => judgeLimit(() => runSingleJudge(p.provider, p.model, sourceCode, prompt, contract)),
        JUDGE_RETRY,
      ),
    ),
  );
  const survivors = settled.filter((r): r is SingleJudgeResult => r !== null);

  const agg = aggregatePanel(survivors);
  if (agg === null) {
    console.warn(`[post-eval] panel failed: ${survivors.length} judges responded`);
    return null;
  }

  // Critique = the LOWEST-scoring surviving judge's critique. The harshest
  // judge surfaces the most actionable issues — a high-scoring judge tends to
  // say "looks good" with nothing to act on.
  const harshest = survivors.reduce((lo, r) => (r.score < lo.score ? r : lo), survivors[0]);

  return {
    passed: agg.score >= 70,
    score: agg.score,
    dimensions: agg.dimensions,
    spread: agg.spread,
    judges: survivors,
    promptVersion: AESTHETIC_PROMPT_VERSION_PANEL,
    critique: harshest.critique,
    evalTimeMs: Date.now() - startTime,
  };
}
