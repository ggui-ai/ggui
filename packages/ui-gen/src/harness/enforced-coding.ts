// packages/ui-gen/src/harness/enforced-coding.ts
//
// Shared enforced coding loop used by the harness runtime.
//
// The loop calls the LLM in text-only mode (no tool calls), then automatically
// runs self_check + compile_component on the extracted code. If either fails,
// the error is fed back to the LLM for another attempt.
//
// Optional aesthetic evaluation: if an aestheticThreshold is provided, compiled
// code is scored by the evaluator before being accepted.

import type { AdapterResult, ToolDefinition } from '../adapters/types';
import type { EvaluationResult, EvaluationIssue } from '../evaluation/types';
import type { AgentConfig, LLMTool } from './llm-router';
import { callLLM } from './llm-router';
import {
  createCapture,
  captureCompiledCode,
  captureMarkers,
  compileLastResort,
} from '../adapters/extract-code';
import {
  ENFORCED_CODER_PROMPT,
  buildEnforcedCoderPrompt,
} from './prompts';

// =============================================================================
// Types
// =============================================================================

export interface EnforcedCodingParams {
  userPrompt: string;
  designSpec: string;
  tools: ToolDefinition[];
  maxAttempts: number;
  prefetchedContext?: string;
  evalFeedback?: { score: number; feedback: string };
  /** Aesthetic score threshold (0-100). If set, compiled code is evaluated and must meet this score. */
  aestheticThreshold?: number;
  /** Original prompt text for the evaluator (without injected context) */
  originalPrompt?: string;
  /** Agent config for aesthetic evaluation */
  evalAgent?: AgentConfig;
  /** Reference tools for hybrid agentic mode (get_primitives, get_design_system, etc.) */
  referenceTools?: LLMTool[];
  /** Previous source code from a prior generation pass — fed back so the model can fix incrementally */
  previousSourceCode?: string;
}

// =============================================================================
// Provider Mapping
// =============================================================================

/**
 * Map AgentConfig provider names ('anthropic') to evaluator provider names ('claude').
 * The evaluator.ts uses 'claude' | 'openai' | 'google', while AgentConfig uses 'anthropic' | 'openai' | 'google'.
 */
export function mapProviderForEvaluator(provider: 'anthropic' | 'openai' | 'google' | 'openrouter'): 'claude' | 'openai' | 'google' | 'openrouter' {
  return provider === 'anthropic' ? 'claude' : provider;
}

// =============================================================================
// Enforced Coding Loop
// =============================================================================

/**
 * Run the enforced coding loop — auto-run self_check + compile after each LLM response.
 *
 * Used by both the the harness runtime to eliminate duplication.
 *
 * @param codingAgent - The agent config for the coding LLM
 * @param params - Coding loop parameters (prompt, tools, thresholds, etc.)
 * @returns AdapterResult with compiled code, tokens, and timing
 */
export async function runEnforcedCodingLoop(
  codingAgent: AgentConfig,
  params: EnforcedCodingParams,
): Promise<AdapterResult> {
  const startTime = Date.now();
  const capture = createCapture();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastError = '';

  const hasReferenceTools = (params.referenceTools?.length ?? 0) > 0;
  const designSpecSize = params.designSpec.length;
  const userPromptSize = params.userPrompt.length;

  // Pre-fetch reference docs if we have tools but no prefetched context.
  // These go in the user prompt (at the end) — system prompt stays small.
  let referenceContext = params.prefetchedContext;
  if (!referenceContext && hasReferenceTools) {
    const contextParts: string[] = [];
    for (const tool of params.referenceTools!) {
      const result = await tool.handler({});
      const toolText = result.content[0]?.text;
      if (toolText) contextParts.push(toolText);
    }
    if (contextParts.length > 0) {
      referenceContext = contextParts.join('\n\n');
    }
  }

  console.log(`[enforced-coding] starting | context=${Math.round((referenceContext?.length ?? 0)/1024)}KB designSpec=${Math.round(designSpecSize/1024)}KB userPrompt=${Math.round(userPromptSize/1024)}KB | maxAttempts=${params.maxAttempts} threshold=${params.aestheticThreshold ?? 'none'}`);

  let previousCode: string | undefined = params.previousSourceCode;

  for (let attempt = 1; attempt <= params.maxAttempts; attempt++) {
    const attemptStart = Date.now();

    // Build user prompt: previous code + errors → task → context
    let errorFeedback: string | undefined;
    if (attempt > 1 && lastError) {
      errorFeedback = lastError;
    } else if (attempt === 1 && params.evalFeedback) {
      errorFeedback = `Evaluation score: ${params.evalFeedback.score}/100\n\n${params.evalFeedback.feedback}`;
    }

    const userPrompt = buildEnforcedCoderPrompt(
      params.userPrompt,
      params.designSpec,
      referenceContext,
      errorFeedback,
      previousCode,
    );

    // System prompt is small (~2KB rules). User prompt has everything dynamic.
    const llmStart = Date.now();
    const response = await callLLM(codingAgent, ENFORCED_CODER_PROMPT, userPrompt, 32768);
    const attemptInputTokens = response.inputTokens;
    const attemptOutputTokens = response.outputTokens;
    const text = response.text;
    const llmMs = Date.now() - llmStart;
    totalInputTokens += attemptInputTokens;
    totalOutputTokens += attemptOutputTokens;
    captureMarkers(capture, text);

    // Extract code from text
    const codeMatch =
      text.match(/```(?:tsx?|jsx?|typescript|javascript)?\s*\n([\s\S]*?)```/) ??
      text.match(/```\s*\n([\s\S]*?)```/);
    let code = codeMatch ? codeMatch[1].trim() : '';

    if (!code && (text.includes('export default') || text.includes('export function'))) {
      code = text;
    }

    if (!code || !(code.includes('export default') || code.includes('export function'))) {
      console.log(`[enforced-coding] attempt=${attempt}/${params.maxAttempts} | llm=${llmMs}ms | result=NO_CODE | in=${attemptInputTokens} out=${attemptOutputTokens}`);
      lastError = 'No code block found in response. You MUST output your component in a ```tsx code block.';
      continue;
    }

    // Save for next attempt — model can see what it wrote and fix incrementally
    previousCode = code;

    // Run self_check programmatically
    const selfCheckStart = Date.now();
    const errorParts: string[] = [];
    const selfCheckTool = params.tools.find((t) => t.name === 'self_check');
    let selfCheckPassed = true;
    if (selfCheckTool) {
      const checkResult = await selfCheckTool.handler({ code });
      if (checkResult.isError) {
        selfCheckPassed = false;
        errorParts.push('## self_check errors\n' + (checkResult.content[0]?.text ?? 'Unknown error'));
      }
    }
    const selfCheckMs = Date.now() - selfCheckStart;

    // Run compile_component programmatically
    const compileStart = Date.now();
    const compileTool = params.tools.find((t) => t.name === 'compile_component');
    if (!compileTool) {
      throw new Error('compile_component tool not found');
    }

    capture.sourceCode = code;
    const compileResult = await compileTool.handler({ code, filename: 'Component.tsx' });
    captureCompiledCode(capture, 'compile_component', compileResult);
    const compileMs = Date.now() - compileStart;

    if (!compileResult.isError && capture.compiledCode) {
      // If aesthetic threshold is set, evaluate before accepting
      if (params.aestheticThreshold && params.aestheticThreshold > 0 && capture.sourceCode) {
        const evalStart = Date.now();
        try {
          const evalAgentConfig = params.evalAgent ?? codingAgent;
          const evalProviderForEvaluator = mapProviderForEvaluator(evalAgentConfig.provider);
          const { runEvaluation } = await import('../evaluation/evaluator');
          const evalResult = await runEvaluation(
            {
              sourceCode: capture.sourceCode,
              compiledCode: capture.compiledCode,
              originalPrompt: params.originalPrompt || params.userPrompt,
              themeTokens: 'Default ggui theme',
            },
            {
              enabled: true,
              passThreshold: params.aestheticThreshold,
              provider: evalProviderForEvaluator,
              model: evalAgentConfig.model,
            },
          );
          const evalMs = Date.now() - evalStart;

          // Accumulate eval tokens
          totalInputTokens += evalResult.inputTokens ?? 0;
          totalOutputTokens += evalResult.outputTokens ?? 0;

          if (evalResult.finalScore < params.aestheticThreshold) {
            console.log(`[enforced-coding] attempt=${attempt}/${params.maxAttempts} | llm=${llmMs}ms selfCheck=${selfCheckMs}ms compile=${compileMs}ms eval=${evalMs}ms total=${Date.now() - attemptStart}ms | result=EVAL_FAIL score=${evalResult.finalScore}/${params.aestheticThreshold} | in=${attemptInputTokens} out=${attemptOutputTokens}`);
            const dims = evalResult.dimensions;
            const issueText = evalResult.issues.length > 0
              ? '\n\nIssues:\n' + evalResult.issues.map(i => `- [${i.severity}] ${i.dimension}: ${i.description}\n  Fix: ${i.fix}`).join('\n')
              : '';
            lastError = `## Aesthetic Evaluation (score: ${evalResult.finalScore}/${params.aestheticThreshold} required)\n\n`
              + `${evalResult.critique || ''}\n\n`
              + `Scores: completeness=${dims.completeness}, visualDesign=${dims.visualPolish}, interactivity=${dims.interactivity}, accessibility=${dims.accessibility}, codeQuality=${dims.codeQuality}`
              + issueText
              + `\n\nImprove the visual quality to score at least ${params.aestheticThreshold}/100. Focus on the lowest-scoring dimensions.`;
            capture.compiledCode = '';
            continue;
          }

          console.log(`[enforced-coding] attempt=${attempt}/${params.maxAttempts} | llm=${llmMs}ms selfCheck=${selfCheckMs}ms compile=${compileMs}ms eval=${evalMs}ms total=${Date.now() - attemptStart}ms | result=PASS score=${evalResult.finalScore} | in=${attemptInputTokens} out=${attemptOutputTokens}`);
        } catch (err) {
          console.warn('[enforced-coding] Aesthetic eval failed, accepting code:', err instanceof Error ? err.message : String(err));
          console.log(`[enforced-coding] attempt=${attempt}/${params.maxAttempts} | llm=${llmMs}ms selfCheck=${selfCheckMs}ms compile=${compileMs}ms eval=ERROR total=${Date.now() - attemptStart}ms | result=PASS(eval_skip) | in=${attemptInputTokens} out=${attemptOutputTokens}`);
        }
      } else {
        console.log(`[enforced-coding] attempt=${attempt}/${params.maxAttempts} | llm=${llmMs}ms selfCheck=${selfCheckMs}ms compile=${compileMs}ms total=${Date.now() - attemptStart}ms | result=PASS(no_eval) | in=${attemptInputTokens} out=${attemptOutputTokens}`);
      }

      // Success
      return {
        compiledCode: capture.compiledCode,
        sourceCode: capture.sourceCode,
        stream: capture.stream,
        generatorMeta: capture.generatorMeta,
        tokens: { input: totalInputTokens, output: totalOutputTokens, total: totalInputTokens + totalOutputTokens },
        generationTimeMs: Date.now() - startTime,
        turnsUsed: attempt,
      };
    }

    // Compile failed — build error feedback
    if (compileResult.isError || !capture.compiledCode) {
      errorParts.push('## compile_component errors\n' + (compileResult.content[0]?.text ?? 'Compilation failed'));
    }

    lastError = errorParts.join('\n\n');

    const failReason = !selfCheckPassed ? 'SELF_CHECK_FAIL' : 'COMPILE_FAIL';
    console.log(`[enforced-coding] attempt=${attempt}/${params.maxAttempts} | llm=${llmMs}ms selfCheck=${selfCheckMs}ms compile=${compileMs}ms total=${Date.now() - attemptStart}ms | result=${failReason} | in=${attemptInputTokens} out=${attemptOutputTokens}`);
    console.log(`[enforced-coding] feedback→LLM: ${lastError.replace(/\n/g, ' ').slice(0, 500)}`);
    capture.compiledCode = '';
  }

  // All attempts failed — try last-resort compilation
  await compileLastResort(capture);

  if (!capture.compiledCode) {
    throw new Error(
      `Enforced coding loop: all ${params.maxAttempts} attempts failed (${totalInputTokens + totalOutputTokens} tokens)\nLast error: ${lastError}`,
    );
  }

  return {
    compiledCode: capture.compiledCode,
    sourceCode: capture.sourceCode,
    stream: capture.stream,
    generatorMeta: capture.generatorMeta,
    tokens: { input: totalInputTokens, output: totalOutputTokens, total: totalInputTokens + totalOutputTokens },
    generationTimeMs: Date.now() - startTime,
    turnsUsed: params.maxAttempts,
  };
}

// ---------------------------------------------------------------------------
// Shared feedback builder
// ---------------------------------------------------------------------------

/**
 * Build evaluation feedback for the LLM to improve its code.
 * Used by the harness runtime's evaluate-then-regenerate loop.
 */
export function buildFeedback(evalResult: EvaluationResult): string {
  const sections: string[] = [];

  const dims = evalResult.dimensions;
  sections.push(
    `Score breakdown: completeness=${dims.completeness}, visualPolish=${dims.visualPolish}, ` +
    `interactivity=${dims.interactivity}, accessibility=${dims.accessibility}, codeQuality=${dims.codeQuality}`,
  );

  if (evalResult.issues.length > 0) {
    const byDimension = new Map<string, EvaluationIssue[]>();
    for (const issue of evalResult.issues) {
      const group = byDimension.get(issue.dimension) ?? [];
      group.push(issue);
      byDimension.set(issue.dimension, group);
    }
    for (const [dimension, issues] of byDimension) {
      const score = evalResult.dimensions[dimension as keyof typeof evalResult.dimensions];
      sections.push(
        `## ${dimension} (${score ?? '?'}/100)\n${issues.map((i) => `- [${i.severity}] ${i.description}\n  Fix: ${i.fix}`).join('\n')}`,
      );
    }
  } else {
    const lowest = Object.entries(dims).sort((a, b) => (a[1] as number) - (b[1] as number));
    sections.push(
      `Focus on improving the lowest-scoring dimensions: ${lowest.slice(0, 2).map(([k, v]) => `${k} (${v})`).join(', ')}`,
    );
  }

  return sections.join('\n\n');
}
