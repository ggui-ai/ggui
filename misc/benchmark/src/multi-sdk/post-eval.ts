/**
 * Post-Generation Aesthetic Evaluation
 *
 * Lightweight LLM-based evaluation that scores generated components on
 * ggui-specific quality criteria. Runs after generation, before reporting.
 *
 * Uses the Anthropic API directly (not Claude Agent SDK) for speed.
 */

import Anthropic from '@anthropic-ai/sdk';

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
 * Judge disclosure — recorded on every {@link PostEvalResult} and
 * propagated into report meta + the published headline so readers know
 * which model and prompt produced the quality score.
 */
export interface JudgeDisclosure {
  /** Pinned judge model id. */
  model: string;
  /** Version tag of {@link AESTHETIC_EVAL_PROMPT}-derived scoring prompt. */
  promptVersion: string;
}

/**
 * The pinned aesthetic judge. `--eval` does NOT change this — that flag
 * only overrides the in-loop evaluation agent (`modelRoles.evaluation`).
 * Changing the judge invalidates score comparability across runs; bump
 * {@link AESTHETIC_PROMPT_VERSION} alongside any prompt change.
 */
export const AESTHETIC_JUDGE_MODEL = 'claude-haiku-4-5-20251001';
export const AESTHETIC_PROMPT_VERSION = 'aesthetic-eval.v1';

export interface PostEvalResult {
  /** Whether the component passed the quality threshold */
  passed: boolean;
  /** Weighted average score (0-100) */
  score: number;
  /** Per-dimension breakdown — exactly the 5 dimensions the judge measures. */
  dimensions: AestheticScores;
  /** Which model + prompt version produced this score. */
  judge: JudgeDisclosure;
  /** Specific issues — empty for post-eval (no issue extraction) */
  issues: never[];
  /** Brief critique text */
  critique: string;
  /** Evaluation time in ms */
  evalTimeMs: number;
}

/** System prompt for the pinned aesthetic judge. Module-private — the only caller is {@link evaluateAesthetics}. */
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

/**
 * Run post-generation aesthetic evaluation on a component.
 * Uses Haiku for speed (~1-2s, ~$0.001).
 *
 * `contract` (optional): the commit's data contract. When passed, the eval
 * LLM sees the same shape `buildMotherPrompt` shows the generator —
 * stops the eval from hallucinating "missing X" against UNAMPUTATED
 * source.
 */
export async function evaluateAesthetics(
  sourceCode: string,
  prompt: string,
  apiKey?: string,
  contract?: unknown,
): Promise<PostEvalResult | null> {
  const startTime = Date.now();

  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  try {
    // Bench runs under Node.js but the runtime-render probe pulls in
    // happy-dom, which sets `window`/`document` globals. The Anthropic SDK's
    // browser detection misfires in that hybrid state. Explicit allow-flag
    // — we're server-side, key lives in process.env, not exposed to a
    // real browser.
    const client = new Anthropic({
      apiKey: key,
      baseURL: 'https://api.anthropic.com',
      dangerouslyAllowBrowser: true,
    });

    // Full source is sent untruncated; the previous slice(0, 8000) clamp
    // amputated the post-line-135 region of medium-complexity components
    // and the eval LLM hallucinated "incomplete code" against it. Same
    // for prompt slice(0, 500) — kanban's prompt at char 600+ carries
    // the "buttons or select dropdown" directive that, when amputated,
    // led the eval to demand drag-and-drop. The sibling in-loop eval at
    // `oss/packages/ui-gen/src/evaluation/llm-evaluator.ts` already
    // sends full source; this matches that posture.
    const contractBlock = contract
      ? `\n\nData contract:\n\`\`\`json\n${JSON.stringify(contract, null, 2).slice(0, 3000)}\n\`\`\``
      : '';

    const response = await client.messages.create({
      model: AESTHETIC_JUDGE_MODEL,
      max_tokens: 2000,
      system: AESTHETIC_EVAL_PROMPT,
      messages: [{
        role: 'user',
        content: `Original prompt: ${prompt}${contractBlock}\n\nComponent source code:\n\`\`\`tsx\n${sourceCode}\n\`\`\``,
      }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonBlock = extractBalancedJson(text);
    if (!jsonBlock) return null;

    const scores = JSON.parse(jsonBlock) as AestheticScores & { critique: string };

    const weights = { layout: 0.2, designTokens: 0.2, hierarchy: 0.2, polish: 0.2, dataPresentation: 0.2 };
    const weightedScore =
      scores.layout * weights.layout +
      scores.designTokens * weights.designTokens +
      scores.hierarchy * weights.hierarchy +
      scores.polish * weights.polish +
      scores.dataPresentation * weights.dataPresentation;

    const roundedScore = Math.round(weightedScore * 10) / 10;
    return {
      passed: weightedScore >= 70,
      score: roundedScore,
      issues: [],
      dimensions: {
        layout: scores.layout,
        designTokens: scores.designTokens,
        hierarchy: scores.hierarchy,
        polish: scores.polish,
        dataPresentation: scores.dataPresentation,
      },
      judge: {
        model: AESTHETIC_JUDGE_MODEL,
        promptVersion: AESTHETIC_PROMPT_VERSION,
      },
      critique: scores.critique,
      evalTimeMs: Date.now() - startTime,
    };
  } catch (err) {
    console.warn('[post-eval] Aesthetic evaluation failed:', err);
    return null;
  }
}
