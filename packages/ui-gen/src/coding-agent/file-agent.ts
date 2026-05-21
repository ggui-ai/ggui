// packages/ui-gen/src/coding-agent/file-agent.ts
//
// Single-file coding agent using multi-turn agentic loop.
// The LLM calls tools (get_components_info, write, apply_diff, etc.),
// sees the results, and decides what to do next — just like Claude Code.

import type { LLMAgent, LLMTool } from '../harness/llm-router';
import { AgentWorkspace } from './workspace';
import { executeTool, fullToolSchemas } from './tools';
import type { CommitMetadata } from './types';
import type { JsonObject } from '@ggui-ai/protocol';

// =============================================================================
// Types
// =============================================================================

export interface FileAgentInput {
  filename: string;
  role: string;
  boilerplate: string;
  typesFile: string;
  instructions: string;
  additionalContext?: string;
  llmAgent: LLMAgent;
  model: string;
  maxTurns?: number;
}

export interface FileAgentOutput {
  filename: string;
  sourceCode: string;
  passed: boolean;
  violations: string[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

// =============================================================================
// File Agent
// =============================================================================

export async function runFileAgent(
  input: FileAgentInput,
): Promise<FileAgentOutput> {
  const workspace = new AgentWorkspace();
  await workspace.init();

  // Write boilerplate
  workspace.write(input.boilerplate);
  await workspace.stage();
  await workspace.commit(`scaffold: ${input.filename} boilerplate`);

  const commitMeta = new Map<string, CommitMetadata>();
  const maxTurns = input.maxTurns ?? 15;

  // Build LLM tools with handlers — callWithTools executes these
  // and feeds results back to the LLM automatically
  let done = false;
  const llmTools: LLMTool[] = Object.entries(fullToolSchemas).map(
    ([name, schema]) => ({
      name,
      description: schema.description,
      parameters: schema.input as JsonObject,
      handler: async (args: JsonObject) => {
        const result = await executeTool(
          workspace,
          name,
          args,
          commitMeta,
        );

        if (result.done) {
          done = true;
          // Tell the LLM the task is complete — it should stop calling tools
          return {
            content: [
              {
                text: `${result.result}\n\nTask complete — all checks passed. Do not call any more tools.`,
              },
            ],
          };
        }

        return {
          content: [{ text: result.result }],
          isError: !!result.error,
        };
      },
    }),
  );

  const systemPrompt = buildFileAgentPrompt(input);
  const currentFile = workspace.cat();
  const userPrompt = `Implement ${input.filename} based on the instructions. The boilerplate is ready.\n\n# Current ${input.filename}\n\`\`\`tsx\n${currentFile}\n\`\`\``;

  console.log(`[file-agent:${input.filename}] starting agentic loop (max ${maxTurns} turns)...`);

  const llmStart = Date.now();
  const result = await input.llmAgent.callWithTools(
    input.model,
    systemPrompt,
    userPrompt,
    llmTools,
    maxTurns,
  );
  const llmMs = Date.now() - llmStart;

  console.log(
    `[file-agent:${input.filename}] ${done ? 'DONE' : 'MAX TURNS'} | ${llmMs}ms | turns=${result.turnsUsed} | in=${result.inputTokens} out=${result.outputTokens}`,
  );

  const lastMeta = [...commitMeta.values()].pop();

  return {
    filename: input.filename,
    sourceCode: workspace.read() ?? '',
    passed: done || (lastMeta?.selfCheck.passed ?? false),
    violations: lastMeta?.selfCheck.violations ?? [],
    turns: result.turnsUsed,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

// =============================================================================
// Prompt
// =============================================================================

function buildFileAgentPrompt(input: FileAgentInput): string {
  const hasDesignSystem = !!input.additionalContext;

  return `You are implementing ${input.filename} for a React component.

${hasDesignSystem
    ? `## Workflow
1. Call \`get_components_info\` with ALL design system components you plan to use
2. Read the component docs returned
3. Call \`write\` with the complete implementation + commit_message
4. If validation fails, read the violations and call \`apply_diff\` to fix`
    : `## Workflow
1. Call \`write\` with the complete implementation + commit_message
2. If validation fails, read the violations and call \`apply_diff\` to fix`}

## Type Definitions (types.d.ts)
\`\`\`typescript
${input.typesFile}
\`\`\`

## Instructions for ${input.filename}
${input.instructions}

${input.additionalContext ? `## Additional Context\n${input.additionalContext}` : ''}

## Rules
- Import types from './types' (they are pre-defined)
- Follow the type interfaces exactly
- No \`eval()\`, \`fetch()\`, or dynamic code loading
- Only allowed imports: react, @ggui-ai/design, and local files (./types, ./constants, ./hooks, ./components)`;
}
