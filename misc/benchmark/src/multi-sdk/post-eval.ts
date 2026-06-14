/**
 * Post-Generation Aesthetic Evaluation
 *
 * Lightweight LLM-based evaluation that scores generated components on
 * ggui-specific quality criteria. Runs after generation, before reporting.
 *
 * {@link evaluateAestheticsPanel} — a 3-provider judge PANEL (Anthropic +
 * OpenAI + Google) scored at temperature 0; reports the mean score and the
 * spread (max−min) so a single biased self-judge can no longer dominate.
 *
 * Routes its LLM calls through `@ggui-ai/ui-gen/harness`'s `callLLM`,
 * which reads provider keys from env (ANTHROPIC_API_KEY / OPENAI_API_KEY /
 * GEMINI_API_KEY|GOOGLE_API_KEY).
 */

import { callLLM, type AgentConfig } from '@ggui-ai/ui-gen/harness';

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
// Panel evaluation (3-provider, avg + spread, temp 0)
// =============================================================================

export const AESTHETIC_PROMPT_VERSION_PANEL = 'aesthetic-eval.v2-panel';

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
  { provider: 'google', model: 'gemini-3-flash-preview' },
] as const;

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
      judge: { model, promptVersion: AESTHETIC_PROMPT_VERSION_PANEL },
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
 * Run the 3-provider aesthetic judge panel. Fires all judges concurrently,
 * drops any that fail, then aggregates the survivors. Returns null when fewer
 * than 2 judges respond (no defensible panel score).
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

  const settled = await Promise.all(
    PANEL.map((p) => runSingleJudge(p.provider, p.model, sourceCode, prompt, contract)),
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
