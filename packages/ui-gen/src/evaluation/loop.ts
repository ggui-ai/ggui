// packages/ui-gen/src/evaluation/loop.ts

import { query, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { sdkToolPins } from '../adapters/claude/sdk-tool-pins';
import { runEvaluation } from './evaluator';
import {
  extractCompiledCodeFromMessage,
  extractSourceCodeFromMessage,
} from './message-parsing';
import { buildFixPrompt } from './prompts';
import {
  MAX_EVAL_ROUNDS_HARD_LIMIT,
} from './types';
import type {
  EvaluationConfig,
  EvaluationContext,
  EvaluationResult,
  QualityMetadata,
} from './types';
import type { SdkMessage } from './message-parsing';

/**
 * Options for running the evaluation loop.
 *
 * Controls the evaluate-fix-re-evaluate cycle that improves generated
 * component quality until it passes or the round limit is reached.
 */
export interface EvaluationLoopOptions {
  /** Session ID of the generator to resume for fixes */
  generatorSessionId: string;
  /** Evaluation context (code, prompt, design, theme) */
  context: EvaluationContext;
  /** Evaluation configuration (thresholds, budgets, round limits) */
  config: EvaluationConfig;
  /** Progress callback for evaluating/fixing status updates */
  onProgress?: (event: { type: 'evaluating' | 'fixing'; round: number }) => void;
  /** Generator context to pass when resuming the session for fixes */
  generatorOptions?: {
    /** Working directory for the generator session */
    cwd?: string;
    /** MCP servers available to the fix agent */
    mcpServers?: Record<string, McpServerConfig>;
    /** Tool names to approve. Absent → every tool of every server in `mcpServers` (ggui#1714). */
    allowedTools?: string[];
    /**
     * CLI built-in tools to offer the fix agent (e.g. `['Write']`). Default: none.
     * An explicit opt-in: a built-in that writes or executes acts on the host (ggui#1714).
     */
    builtinTools?: readonly string[];
    /** LLM model for fix rounds */
    model?: string;
    /** Environment variables (includes BYOK credentials) */
    env?: Record<string, string>;
    /** Stderr capture callback for debugging */
    stderr?: (data: string) => void;
  };
}

/**
 * Result of the evaluation loop.
 *
 * Contains the final (possibly fixed) code, quality scores, and
 * the evaluation history from each round.
 */
export interface EvaluationLoopResult {
  /** Final compiled code (may be updated by fix rounds) */
  finalCode: string;
  /** Final source code (may be updated by fix rounds) */
  finalSourceCode?: string;
  /** Quality metadata for the generation result */
  qualityMetadata: QualityMetadata;
  /** All evaluation results from each round */
  evaluationResults: EvaluationResult[];
}

/**
 * Run the evaluation loop: evaluate -> fix -> re-evaluate (up to maxRounds).
 *
 * If the first evaluation passes, returns immediately.
 * If it fails, resumes the generator session with critique feedback,
 * captures the fixed code, and re-evaluates. Repeats until the score
 * passes or the round limit is reached.
 *
 * @param options - Evaluation loop configuration and callbacks
 * @returns The final code, quality metadata, and evaluation history
 */
export async function runEvaluationLoop(
  options: EvaluationLoopOptions
): Promise<EvaluationLoopResult> {
  const { generatorSessionId, context, config, onProgress, generatorOptions } = options;
  const startTime = Date.now();
  const evaluationResults: EvaluationResult[] = [];

  let currentCode = context.compiledCode;
  let currentSourceCode: string | undefined = context.sourceCode;
  let round = 0;
  const maxRounds = Math.min(config.maxRounds ?? 3, MAX_EVAL_ROUNDS_HARD_LIMIT);

  // ggui#1714 — a fix round runs with no CLI built-ins unless asked for. With no
  // MCP server and no built-in either, the fix agent has nothing that can return
  // code, and every fix round would silently hand back the original: refuse.
  const offersATool =
    Object.keys(generatorOptions?.mcpServers ?? {}).length > 0 || (generatorOptions?.builtinTools?.length ?? 0) > 0;
  if (maxRounds > 1 && !offersATool) {
    throw new Error(
      'runEvaluationLoop: a fix round needs a tool that can return code — pass generatorOptions.mcpServers ' +
        "(e.g. a server with compile_component) or opt into a built-in with generatorOptions.builtinTools (e.g. ['Write']).",
    );
  }

  while (round < maxRounds) {
    round++;

    // --- Evaluate ---
    onProgress?.({ type: 'evaluating', round });
    console.log(`[eval] Round ${round}: evaluating...`);

    const evalContext: EvaluationContext = {
      ...context,
      compiledCode: currentCode,
      sourceCode: currentSourceCode || context.sourceCode,
    };
    const evalResult = await runEvaluation(evalContext, config);
    evaluationResults.push(evalResult);

    console.log(
      `[eval] Round ${round}: score=${evalResult.finalScore}, passed=${evalResult.passed}, issues=${evalResult.issues.length}`
    );

    // If passed or last round, we're done
    if (evalResult.passed || round >= maxRounds) {
      break;
    }

    // --- Fix ---
    onProgress?.({ type: 'fixing', round });
    console.log(`[eval] Round ${round}: fixing...`);

    const fixPrompt = buildFixPrompt(evalResult, context.originalPrompt);

    // Get custom CLI path from environment (for Docker deployments)
    const cliPath = process.env.CLAUDE_WRAPPER_PATH;

    // Build environment — use BYOK-enriched env from generator if provided
    const env: Record<string, string> = {};
    if (generatorOptions?.env) {
      Object.assign(env, generatorOptions.env);
    } else {
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
    }

    let fixedCompiledCode: string | undefined;
    let fixedSourceCode: string | undefined;

    for await (const message of query({
      prompt: fixPrompt,
      options: {
        resume: generatorSessionId,
        maxTurns: 15,
        maxBudgetUsd: config.maxBudgetPerFix,
        env,
        ...(cliPath && { pathToClaudeCodeExecutable: cliPath }),
        ...(generatorOptions?.cwd && { cwd: generatorOptions.cwd }),
        ...(generatorOptions?.mcpServers && { mcpServers: generatorOptions.mcpServers }),
        // ggui#1714 — no CLI built-ins unless asked for, no host settings, no permission bypass.
        ...sdkToolPins({
          mcpServers: generatorOptions?.mcpServers,
          allowedTools: generatorOptions?.allowedTools,
          builtinTools: generatorOptions?.builtinTools,
        }),
        ...(generatorOptions?.model && { model: generatorOptions.model }),
        ...(generatorOptions?.stderr && { stderr: generatorOptions.stderr }),
      },
    })) {
      const msg = message as SdkMessage;

      // Capture fixed compiledCode
      const compiled = extractCompiledCodeFromMessage(msg);
      if (compiled) fixedCompiledCode = compiled;

      // Capture source code from Write tool
      const source = extractSourceCodeFromMessage(msg);
      if (source) fixedSourceCode = source;
    }

    // Update current code if fix produced new output
    if (fixedCompiledCode) {
      currentCode = fixedCompiledCode;
      console.log(`[eval] Round ${round}: fixed code captured (${currentCode.length} bytes)`);
    }
    if (fixedSourceCode) {
      currentSourceCode = fixedSourceCode;
    }
  }

  const lastResult = evaluationResults[evaluationResults.length - 1];
  const evaluationTimeMs = Date.now() - startTime;

  const qualityMetadata: QualityMetadata = {
    evaluationRounds: evaluationResults.length,
    finalScore: lastResult.finalScore,
    dimensions: lastResult.dimensions,
    passed: lastResult.passed,
    evaluatorModel: config.model ?? 'default',
    evaluationTimeMs,
  };

  return {
    finalCode: currentCode,
    finalSourceCode: currentSourceCode,
    qualityMetadata,
    evaluationResults,
  };
}
