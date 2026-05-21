// packages/ui-gen/src/coding-agent/agent.ts
//
// Main coding agent — uses callWithTools for multi-turn agentic loop.
// The LLM calls tools, sees results, and decides what to do next.

import { AgentWorkspace } from './workspace';
import { executeTool, fullToolSchemas } from './tools';
import { buildInitialSystemPrompt } from './prompts';
import { TraceCollector } from './trace';
import type { LLMTool } from '../harness/llm-router';
import type { JsonObject } from '@ggui-ai/protocol';
import type {
  CodingAgentInput,
  CodingAgentOutput,
  CommitMetadata,
  CommitSummary,
  ToolSchema,
} from './types';

// =============================================================================
// Public API
// =============================================================================

export async function runCodingAgent(
  input: CodingAgentInput,
): Promise<CodingAgentOutput> {
  const workspace = new AgentWorkspace();
  await workspace.init();

  const commitMeta = new Map<string, CommitMetadata>();
  const tracer = new TraceCollector(
    `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const startTime = Date.now();
  const maxTurns = input.maxTurns ?? 15;
  let done = false;

  // Write boilerplate if provided
  if (input.boilerplate) {
    workspace.write(input.boilerplate);
    await workspace.stage();
    await workspace.commit('scaffold: boilerplate');
  }

  const systemPrompt = input.systemPrompt ?? buildInitialSystemPrompt(
    input.designSystem,
    input.plan,
    input.commitInput,
    input.criteria,
  );

  const currentFile = workspace.cat();
  const userPrompt = `Implement the component based on the instructions. The boilerplate is ready.\n\n# Current file\n\`\`\`tsx\n${currentFile}\n\`\`\``;

  if (input.llmAgent) {
    // ── Production path: callWithTools agentic loop ────────
    const llmTools = buildLLMTools(
      workspace,
      commitMeta,
      () => { done = true; },
      input.onProgress,
    );

    console.log(`[coding-agent] starting agentic loop (max ${maxTurns} turns)...`);
    input.onProgress?.({ type: 'turn_start', turn: 1 });

    const turnRecorder = tracer.startTurn(1, 'initial');
    const llmStart = Date.now();

    const result = await input.llmAgent.callWithTools(
      input.model,
      systemPrompt,
      userPrompt,
      llmTools,
      maxTurns,
    );

    const llmMs = Date.now() - llmStart;
    turnRecorder.recordPrompt(systemPrompt, userPrompt, estimateTokens(systemPrompt + userPrompt));
    turnRecorder.recordLLMResponse(
      [],
      { input: result.inputTokens, output: result.outputTokens },
      llmMs,
    );
    turnRecorder.finalize();

    console.log(
      `[coding-agent] ${done ? 'DONE' : 'MAX TURNS'} | ${llmMs}ms | turns=${result.turnsUsed} | in=${result.inputTokens} out=${result.outputTokens}`,
    );

    const metrics = {
      turns: result.turnsUsed,
      tokens: {
        input: result.inputTokens,
        output: result.outputTokens,
        total: result.inputTokens + result.outputTokens,
      },
      generationTimeMs: Date.now() - startTime,
      commitAttempts: commitMeta.size,
      selfCheckViolations: [...commitMeta.values()]
        .flatMap((m) => m.selfCheck.violations),
      maxTurnsExceeded: !done ? true : undefined,
    };

    // Find best compiled code
    const bestCommit = findBestCommit(commitMeta);

    return {
      sourceCode: workspace.read() ?? '',
      compiledCode: bestCommit?.metadata.build.compiledCode ?? '',
      commitHistory: await buildCommitSummaries(workspace, commitMeta),
      metrics,
      trace: tracer.build(input.model, done ? 'success' : 'max_turns_fallback'),
    };
  }

  if (input.llmCaller) {
    // ── Test path: legacy LLMCaller (for unit tests) ──────
    return runWithLLMCaller(input, workspace, commitMeta, tracer, systemPrompt, startTime);
  }

  throw new Error('CodingAgentInput must provide either llmAgent or llmCaller');
}

// =============================================================================
// Build LLM Tools (with handlers for callWithTools)
// =============================================================================

function buildLLMTools(
  workspace: AgentWorkspace,
  commitMeta: Map<string, CommitMetadata>,
  onDone: () => void,
  onProgress?: CodingAgentInput['onProgress'],
): LLMTool[] {
  let turnCount = 0;
  const label = `[coding-agent]`;

  return Object.entries(fullToolSchemas).map(([name, schema]) => ({
    name,
    description: schema.description,
    parameters: schema.input as JsonObject,
    handler: async (args: JsonObject) => {
      turnCount++;
      const toolStart = Date.now();
      const result = await executeTool(workspace, name, args, commitMeta);
      const toolMs = Date.now() - toolStart;

      // Log each tool call with details
      if (name === 'get_components_info') {
        const names = (args.names as string[]) ?? [];
        console.log(`${label} turn=${turnCount} | get_components_info([${names.join(', ')}]) | ${toolMs}ms`);
      } else if (name === 'write') {
        const lines = ((args.code as string) ?? '').split('\n').length;
        const status = result.done ? 'PASS' : result.error ? 'ERROR' : 'FAIL';
        console.log(`${label} turn=${turnCount} | write(${lines} lines) → ${status} | ${toolMs}ms`);
      } else if (name === 'apply_diff') {
        const status = result.done ? 'PASS' : result.error ? 'ERROR' : 'FAIL';
        console.log(`${label} turn=${turnCount} | apply_diff → ${status} | ${toolMs}ms`);
      } else {
        console.log(`${label} turn=${turnCount} | ${name} | ${toolMs}ms`);
      }

      onProgress?.({ type: 'tool_executed', tool: name, result: result.result.slice(0, 200) });

      if (result.done) {
        onDone();
        onProgress?.({ type: 'commit_result', passed: true });
        return {
          content: [{ text: `${result.result}\n\nAll checks passed. Task complete.` }],
        };
      }

      if (name === 'write' || name === 'apply_diff') {
        onProgress?.({ type: 'commit_result', passed: false });
      }

      return {
        content: [{ text: result.result }],
        isError: !!result.error,
      };
    },
  }));
}

// =============================================================================
// Legacy LLMCaller path (for tests)
// =============================================================================

async function runWithLLMCaller(
  input: CodingAgentInput,
  workspace: AgentWorkspace,
  commitMeta: Map<string, CommitMetadata>,
  tracer: TraceCollector,
  systemPrompt: string,
  startTime: number,
): Promise<CodingAgentOutput> {
  const maxTurns = input.maxTurns ?? 15;
  const metrics = {
    turns: 0,
    tokens: { input: 0, output: 0, total: 0 },
    generationTimeMs: 0,
    commitAttempts: 0,
    selfCheckViolations: [] as string[],
    maxTurnsExceeded: undefined as boolean | undefined,
  };

  // Convert tool schemas to the format LLMCaller expects
  const toolSchemaRecord: Record<string, ToolSchema> = fullToolSchemas;

  for (let turn = 0; turn < maxTurns; turn++) {
    metrics.turns++;
    input.onProgress?.({ type: 'turn_start', turn: turn + 1 });
    const turnRecorder = tracer.startTurn(turn + 1, turn === 0 ? 'initial' : 'fix');
    const currentFile = workspace.cat();
    const userContext = turn === 0
      ? `Implement the component.\n\n# Current file\n\`\`\`tsx\n${currentFile}\n\`\`\``
      : `Fix violations.\n\n# Current file\n\`\`\`tsx\n${currentFile}\n\`\`\``;

    const { toolCalls, usage } = await input.llmCaller!(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContext },
      ],
      { model: input.model, tools: toolSchemaRecord, toolChoice: 'required' },
    );

    metrics.tokens.input += usage.inputTokens;
    metrics.tokens.output += usage.outputTokens;
    metrics.tokens.total = metrics.tokens.input + metrics.tokens.output;
    turnRecorder.recordLLMResponse(
      toolCalls, { input: usage.inputTokens, output: usage.outputTokens }, 0,
    );

    // Execute tools
    let done = false;
    for (const call of toolCalls) {
      const result = await executeTool(
        workspace, call.tool, call.input, commitMeta,
      );
      if (result.done) { done = true; break; }
      if (result.error) break;
    }

    turnRecorder.finalize();

    if (done) {
      metrics.generationTimeMs = Date.now() - startTime;
      const bestCommit = findBestCommit(commitMeta);
      return {
        sourceCode: workspace.read() ?? '',
        compiledCode: bestCommit?.metadata.build.compiledCode ?? '',
        commitHistory: await buildCommitSummaries(workspace, commitMeta),
        metrics,
        trace: tracer.build(input.model, 'success'),
      };
    }
  }

  metrics.generationTimeMs = Date.now() - startTime;
  metrics.maxTurnsExceeded = true;
  const bestCommit = findBestCommit(commitMeta);
  return {
    sourceCode: workspace.read() ?? '',
    compiledCode: bestCommit?.metadata.build.compiledCode ?? '',
    commitHistory: await buildCommitSummaries(workspace, commitMeta),
    metrics,
    trace: tracer.build(input.model, 'max_turns_fallback'),
  };
}

// =============================================================================
// Helpers
// =============================================================================

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function findBestCommit(
  commitMeta: Map<string, CommitMetadata>,
): { oid: string; metadata: CommitMetadata } | null {
  let bestBuild: { oid: string; metadata: CommitMetadata } | null = null;
  let last: { oid: string; metadata: CommitMetadata } | null = null;

  for (const [oid, metadata] of commitMeta) {
    last = { oid, metadata };
    if (metadata.build.success && metadata.selfCheck.passed) return { oid, metadata };
    if (metadata.build.success && !bestBuild) bestBuild = { oid, metadata };
  }

  return bestBuild ?? last;
}

async function buildCommitSummaries(
  workspace: AgentWorkspace,
  commitMeta: Map<string, CommitMetadata>,
): Promise<CommitSummary[]> {
  const commits = await workspace.log();
  return commits.map((c) => {
    const meta = commitMeta.get(c.oid);
    return {
      oid: c.oid,
      message: c.commit.message.trim(),
      selfCheckPassed: meta?.selfCheck.passed ?? false,
      buildPassed: meta?.build.success ?? false,
      violations: meta?.selfCheck.violations ?? [],
    };
  });
}
