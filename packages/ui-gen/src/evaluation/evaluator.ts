// packages/ui-gen/src/evaluation/evaluator.ts
//
// Unified, provider-agnostic UI evaluation.
//
// One evaluation function that works with Claude, OpenAI, and Google.
// Routes to the correct API based on config.provider.
//
// Responsibilities (things self_check CANNOT verify):
// - Visual design quality, hierarchy, composition
// - Interaction polish (hover, transitions, animations)
// - Prompt completeness (does it match what was requested?)
// - Data rendering quality (not just present, but well-formatted)
//
// Does NOT re-check (already handled by self_check):
// - Hardcoded hex colors (self_check catches these)
// - Raw pixel values (self_check catches these)
// - Wrong imports (self_check catches these)
// - Missing Props interface (self_check catches these)
// - Null safety (TypeChecker strictNullChecks catches these)

import type { EvaluationConfig, EvaluationContext, EvaluationResult, DimensionScores, EvaluationIssue } from './types';
import { createAgent } from '../harness/llm-router';
import type { LLMToolDef } from '../harness/llm-router';

// ---------------------------------------------------------------------------
// Evaluation tool (structured output via tool calling)
// ---------------------------------------------------------------------------

const EVAL_TOOL: LLMToolDef = {
  name: "submit_evaluation",
  description: "Submit the UI quality evaluation scores and feedback.",
  parameters: {
    type: "object",
    properties: {
      completeness: { type: "number", description: "0-100: Does the component implement ALL features from the prompt?" },
      visualDesign: { type: "number", description: "0-100: Layout, visual hierarchy, spacing, polished appearance" },
      interactivity: { type: "number", description: "0-100: Hover/focus states, transitions, form validation, loading states" },
      accessibility: { type: "number", description: "0-100: Semantic HTML, ARIA labels, keyboard navigation, contrast" },
      codeQuality: { type: "number", description: "0-100: Clean structure, state management, event handlers, defaults" },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            dimension: { type: "string" },
            severity: { type: "string", description: "critical, major, or minor" },
            description: { type: "string" },
            fix: { type: "string" },
          },
          required: ["dimension", "severity", "description", "fix"],
        },
        description: "List of specific issues found",
      },
      critique: { type: "string", description: "2-3 sentences: what's good and what needs improvement" },
    },
    required: ["completeness", "visualDesign", "interactivity", "accessibility", "codeQuality", "issues", "critique"],
  },
};

// ---------------------------------------------------------------------------
// Unified evaluation prompt
// ---------------------------------------------------------------------------

const EVAL_SYSTEM_PROMPT = `You are a UI quality evaluator for ggui-generated React components.

The code has ALREADY passed automated checks for:
- Design token usage (no hardcoded colors/spacing)
- Import constraints (only react + @ggui-ai/design)
- TypeScript types (Props interface, null safety)
- Compilation + render smoke test

Do NOT penalize for things the automated checks already cover. Focus ONLY on quality aspects that require human judgment.

## Dimensions (score each 0-100)

1. **completeness** (25%): Does the component implement ALL features from the original prompt? Are all requested UI elements present? Does it use ALL props from the contract (especially nested fields in arrays)?

2. **visualDesign** (25%): Is the layout well-composed? Clear visual hierarchy (headings > subheadings > body)? Good use of whitespace and spacing? Proper use of primitive variants (primary for CTAs, outline for secondary, ghost for tertiary)? Professional, polished appearance?

3. **interactivity** (20%): Are interactive elements polished? Hover/focus states on buttons and links? Smooth transitions (200ms ease)? Form validation with inline errors? Disabled states during submission? Loading indicators? Keyboard navigation?

4. **accessibility** (15%): Semantic HTML (headings, lists, landmarks)? ARIA labels on inputs and interactive elements? Keyboard-navigable? Focus management? Readable text contrast?

5. **codeQuality** (15%): Clean component structure? Proper state management? Event handlers wired correctly? No unnecessary re-renders? Default prop values for all optional props?

## Scoring Scale

- 90-100: Production-ready. Polished layout, smooth interactions, full accessibility, clean code.
- 80-89: Good. Minor improvements needed (a missing hover state, slightly tight spacing).
- 70-79: Acceptable. Works correctly but lacks polish (no transitions, generic layout).
- 60-69: Below standard. Missing features, poor layout, no interactive states.
- Below 60: Broken or fundamentally incomplete.

Call the \`submit_evaluation\` tool with your scores, issues, and critique.`;

// ---------------------------------------------------------------------------
// Provider-agnostic evaluation
// ---------------------------------------------------------------------------

/**
 * Run a single evaluation round using any LLM provider.
 *
 * Provider-agnostic: routes to Claude, OpenAI, or Google API based on config.provider.
 * Falls back to Claude if no provider is specified.
 */
export async function runEvaluation(
  context: EvaluationContext,
  config: EvaluationConfig,
): Promise<EvaluationResult> {
  const providerName = config.provider ?? 'claude';
  const model = config.model || getDefaultEvalModel(providerName);
  const routerProvider = providerName === 'claude' ? 'anthropic' as const : providerName as 'openai' | 'google' | 'openrouter';

  const userPrompt = buildEvalUserPrompt(context);
  const agent = createAgent(routerProvider);

  // Use tool calling for structured output — no JSON parsing needed
  const response = await agent.callTools(
    model,
    EVAL_SYSTEM_PROMPT,
    userPrompt,
    [EVAL_TOOL],
    'required',
  );

  const call = response.toolCalls[0];
  if (!call) {
    throw new Error('Evaluator did not return a tool call');
  }

  const raw = call.input as Record<string, unknown>;
  return buildEvalResult(raw, config.passThreshold, response.inputTokens, response.outputTokens);
}

// ---------------------------------------------------------------------------
// (Provider routing removed — uses LLM router via createAgent/callTools)
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

function buildEvalUserPrompt(context: EvaluationContext): string {
  const parts: string[] = [];

  parts.push(`## Original Request\n${context.originalPrompt}`);

  if (context.designContext) {
    parts.push(`## App Design Context\n${context.designContext}`);
  }

  parts.push(`## Source Code\n\`\`\`tsx\n${context.sourceCode.slice(0, 10000)}\n\`\`\``);

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Build EvaluationResult from tool call input (structured data, no JSON parsing).
 */
function buildEvalResult(
  raw: Record<string, unknown>,
  passThreshold: number,
  inputTokens: number,
  outputTokens: number,
): EvaluationResult {
  const dimensions: DimensionScores = {
    completeness: (raw.completeness as number) ?? 0,
    visualPolish: (raw.visualDesign as number) ?? (raw.visualPolish as number) ?? 0,
    interactivity: (raw.interactivity as number) ?? 0,
    accessibility: (raw.accessibility as number) ?? 0,
    codeQuality: (raw.codeQuality as number) ?? 0,
  };

  const weights = {
    completeness: 0.25,
    visualPolish: 0.25,
    interactivity: 0.20,
    accessibility: 0.15,
    codeQuality: 0.15,
  };

  const finalScore = Math.round(
    dimensions.completeness * weights.completeness +
    dimensions.visualPolish * weights.visualPolish +
    dimensions.interactivity * weights.interactivity +
    dimensions.accessibility * weights.accessibility +
    dimensions.codeQuality * weights.codeQuality,
  );

  const rawIssues = (raw.issues ?? []) as Array<Record<string, string>>;
  const issues: EvaluationIssue[] = rawIssues.map((i) => ({
    dimension: i.dimension || 'unknown',
    severity: (i.severity as 'critical' | 'major' | 'minor') || 'minor',
    description: i.description || '',
    fix: i.fix || '',
  }));

  return {
    passed: finalScore >= passThreshold,
    finalScore,
    dimensions,
    issues,
    critique: raw.critique as string,
    inputTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Default models per provider (cheapest/fastest)
// ---------------------------------------------------------------------------

function getDefaultEvalModel(provider: string): string {
  switch (provider) {
    case 'claude': return 'claude-haiku-4-5-20251001';
    case 'openai': return 'gpt-5.4-mini';
    case 'google': return 'gemini-3-flash-preview';
    default: return 'claude-haiku-4-5-20251001';
  }
}
