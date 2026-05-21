// packages/ui-gen/src/coding-agent/planner.ts
//
// Two-step planner:
//   Step 1: Architect — decides component structure + types.d.ts (1 LLM call)
//   Step 2: Instruct — generates per-file instructions in parallel (N LLM calls)

import type { LLMAgent } from '../harness/llm-router';
import type { Plan, CommitInput, CodingCriteria } from './types';

// =============================================================================
// Types
// =============================================================================

/** Normalize whatever role the LLM outputs to our strict set */
function normalizeRole(filename: string, rawRole: string): FileTask['role'] {
  if (filename === 'constants.ts') return 'constants';
  if (filename === 'hooks.ts') return 'hooks';
  if (filename === 'components/index.tsx') return 'main-component';
  if (filename.startsWith('components/')) return 'sub-component';
  // Fallback based on raw role
  if (rawRole === 'constants') return 'constants';
  if (rawRole === 'hooks') return 'hooks';
  return 'sub-component';
}

export interface FileTask {
  filename: string;
  role: 'constants' | 'hooks' | 'main-component' | 'sub-component';
  instructions: string;
  needsDesignSystem: boolean;
}

export interface PlannerOutput {
  typesFile: string;
  files: FileTask[];
}

export interface PlannerMetrics {
  architectTimeMs: number;
  instructTimeMs: number;
  totalTimeMs: number;
  inputTokens: number;
  outputTokens: number;
}

// =============================================================================
// Step 1: Architect
// =============================================================================

interface ArchitectOutput {
  typesFile: string;
  files: Array<{
    filename: string;
    role: 'constants' | 'hooks' | 'component' | 'ui';
    needsDesignSystem: boolean;
    /** Brief purpose (used as input for Step 2) */
    purpose: string;
  }>;
}

function buildArchitectPrompt(
  plan: Plan,
  commitInput: CommitInput,
  criteria: CodingCriteria,
  designSystemSummary: string,
): string {
  return `You are a React component architect. Design the file structure and type interfaces.

## Our Boilerplate Structure
We generate these files for every component:
- \`types.d.ts\` — ALL shared interfaces (Props, HookReturn, sub-component props)
- \`constants.ts\` — static data, mappings, configs (no React, no design system)
- \`hooks.ts\` — custom hook: state, handlers, data transforms (imports types + constants)
- \`./components/*.tsx\` — reusable sub-components (each 20-60 lines, uses design system)
- \`components/index.tsx\` — main component composing sub-components (uses design system). Use role "ui" for this file.
- \`entrypoint.tsx\` — entry point wiring (auto-generated, not your concern — do NOT create this)

## Component Requirements
${plan.spec}

## Data Contract
Props: ${JSON.stringify(commitInput.propsSpec, null, 2)}
${commitInput.actionSpec ? `Actions: ${JSON.stringify(commitInput.actionSpec, null, 2)}` : ''}
${commitInput.streamSpec ? `Stream: ${JSON.stringify(commitInput.streamSpec, null, 2)}` : ''}

## Self-Check Criteria (code MUST pass these)
- No eval(), fetch(), or dynamic code loading
- No hardcoded hex colors — use var(--ggui-*) design tokens
- No raw pixel values for spacing — use spacing tokens
- Must have typed Props interface
- Allowed imports: react, @ggui-ai/design, local files (./types, ./constants, ./hooks, ./components)

## Evaluation Criteria (quality goals)
${criteria.evaluation.map((c) => `- ${c.description}`).join('\n') || '- Visual polish, accessibility, interactivity, code quality'}

## User Request
${criteria.userRequest}

## Design System (available primitives, components, tokens)
${designSystemSummary}

## Your Job
1. Decide what sub-components to extract (if any)
2. Define ALL type interfaces in types.d.ts
3. List all files with their role and purpose

IMPORTANT: Only reference primitives and components that exist in the design system above. Do NOT invent components like Grid, Flex, or Layout — use Stack, Box, Card, Container etc. from the design system.

## Rules for types.d.ts
- \`Props\` must match the data contract exactly
- \`HookReturn\` describes what the hook returns (state + handlers + computed values)
- One \`*Props\` interface per sub-component
- Export everything`;
}

async function runArchitect(
  agent: LLMAgent,
  model: string,
  plan: Plan,
  commitInput: CommitInput,
  criteria: CodingCriteria,
  designSystemSummary: string,
): Promise<{
  output: ArchitectOutput;
  inputTokens: number;
  outputTokens: number;
}> {
  const prompt = buildArchitectPrompt(
    plan,
    commitInput,
    criteria,
    designSystemSummary,
  );

  const result = await agent.callTools(
    model,
    prompt,
    'Design the component architecture now.',
    [
      {
        name: 'submit_architecture',
        description:
          'Submit types.d.ts and file decomposition.',
        parameters: {
          type: 'object',
          properties: {
            typesFile: {
              type: 'string',
              description:
                'Complete types.d.ts with Props, HookReturn, and sub-component props',
            },
            files: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  filename: { type: 'string' },
                  role: { type: 'string' },
                  needsDesignSystem: { type: 'boolean' },
                  purpose: {
                    type: 'string',
                    description: 'Brief purpose of this file',
                  },
                },
                required: [
                  'filename',
                  'role',
                  'needsDesignSystem',
                  'purpose',
                ],
              },
            },
          },
          required: ['typesFile', 'files'],
        },
      },
    ],
    'required',
  );

  const call = result.toolCalls[0];
  if (!call || call.name !== 'submit_architecture') {
    throw new Error(
      `Architect: expected submit_architecture, got ${call?.name ?? 'nothing'}`,
    );
  }

  return {
    output: {
      typesFile: (call.input.typesFile as string) ?? '',
      files: (call.input.files as ArchitectOutput['files']) ?? [],
    },
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

// =============================================================================
// Step 2: Instruct (parallel — 1 call per file)
// =============================================================================

function buildInstructPrompt(
  file: ArchitectOutput['files'][0],
  typesFile: string,
  plan: Plan,
  designSystemSummary: string,
): string {
  const baseContext = `## File: ${file.filename} (${file.role})
Purpose: ${file.purpose}

## Types (from types.d.ts)
\`\`\`typescript
${typesFile}
\`\`\`

## Component Requirements
${plan.spec}`;

  if (file.role === 'constants') {
    return `${baseContext}

Write specific instructions for implementing ${file.filename}.
Focus on: what data mappings, static configs, or lookup tables are needed.
Do NOT include any design system or React imports.`;
  }

  if (file.role === 'hooks') {
    return `${baseContext}

Write specific instructions for implementing the useComponent hook.
Focus on: what state to manage, what handlers to create, what data to transform.
Reference the HookReturn interface — every field must be implemented.
Do NOT include any design system or UI concerns.`;
  }

  if (file.role === 'component') {
    return `${baseContext}

## Design System Primitives
${designSystemSummary}

Write specific instructions for implementing ${file.filename}.
Focus on: layout structure, which design primitives to use, accessibility attributes.
Keep it small (20-60 lines). Use design tokens for all colors and spacing.`;
  }

  // ui
  return `${baseContext}

## Design System Primitives
${designSystemSummary}

Write specific instructions for implementing ui.tsx.
Focus on: overall layout composition, how to arrange sub-components, responsive behavior.
Import sub-components from './components'. Use design tokens throughout.`;
}

async function runInstructions(
  agent: LLMAgent,
  model: string,
  architecture: ArchitectOutput,
  plan: Plan,
  designSystemSummary: string,
): Promise<{
  instructions: Map<string, string>;
  inputTokens: number;
  outputTokens: number;
}> {
  // Generate instructions for all files in parallel
  const results = await Promise.all(
    architecture.files.map(async (file) => {
      const prompt = buildInstructPrompt(
        file,
        architecture.typesFile,
        plan,
        file.needsDesignSystem ? designSystemSummary : '',
      );

      const result = await agent.callTools(
        model,
        prompt,
        `Write the implementation instructions for ${file.filename}.`,
        [
          {
            name: 'submit_instructions',
            description: `Implementation instructions for ${file.filename}`,
            parameters: {
              type: 'object',
              properties: {
                instructions: {
                  type: 'string',
                  description:
                    'Detailed implementation instructions for the coding agent',
                },
              },
              required: ['instructions'],
            },
          },
        ],
        'required',
      );

      const call = result.toolCalls[0];
      return {
        filename: file.filename,
        instructions: (call?.input?.instructions as string) ?? file.purpose,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
    }),
  );

  const instructions = new Map<string, string>();
  let totalIn = 0;
  let totalOut = 0;
  for (const r of results) {
    instructions.set(r.filename, r.instructions);
    totalIn += r.inputTokens;
    totalOut += r.outputTokens;
  }

  return { instructions, inputTokens: totalIn, outputTokens: totalOut };
}

// =============================================================================
// Public API
// =============================================================================

export async function runPlanner(
  agent: LLMAgent,
  model: string,
  plan: Plan,
  commitInput: CommitInput,
  criteria: CodingCriteria,
  designSystemSummary: string,
): Promise<{
  output: PlannerOutput;
  metrics: PlannerMetrics;
}> {
  const startTime = Date.now();
  let totalIn = 0;
  let totalOut = 0;

  // ── Step 1: Architect ─────────────────────────────
  const architectStart = Date.now();
  const {
    output: architecture,
    inputTokens: aIn,
    outputTokens: aOut,
  } = await runArchitect(
    agent,
    model,
    plan,
    commitInput,
    criteria,
    designSystemSummary,
  );
  const architectMs = Date.now() - architectStart;
  totalIn += aIn;
  totalOut += aOut;

  console.log(
    `[planner] architect: ${architectMs}ms | ${architecture.files.length} files | types=${architecture.typesFile.length}B | in=${aIn} out=${aOut}`,
  );
  console.log(
    `[planner] files: ${architecture.files.map((f) => `${f.filename}(${f.role})`).join(', ')}`,
  );

  // ── Step 2: Instruct (parallel) ───────────────────
  const instructStart = Date.now();
  const {
    instructions,
    inputTokens: iIn,
    outputTokens: iOut,
  } = await runInstructions(
    agent,
    model,
    architecture,
    plan,
    designSystemSummary,
  );
  const instructMs = Date.now() - instructStart;
  totalIn += iIn;
  totalOut += iOut;

  console.log(
    `[planner] instruct: ${instructMs}ms (${architecture.files.length} parallel) | in=${iIn} out=${iOut}`,
  );

  // ── Assemble output ────────────────────────────────
  const files: FileTask[] = architecture.files.map((f) => ({
    filename: f.filename,
    role: normalizeRole(f.filename, f.role),
    instructions: instructions.get(f.filename) ?? f.purpose,
    needsDesignSystem: f.needsDesignSystem,
  }));

  return {
    output: {
      typesFile: architecture.typesFile,
      files,
    },
    metrics: {
      architectTimeMs: architectMs,
      instructTimeMs: instructMs,
      totalTimeMs: Date.now() - startTime,
      inputTokens: totalIn,
      outputTokens: totalOut,
    },
  };
}
