// packages/ui-gen/src/workflows.ts
//
// Workflow registry + classification-driven picker. Each workflow
// describes an execution topology (phases × tasks) for producing source
// from a contract + prompt; the harness runtime owns actual LLM calls.
//
// Workflow shapes are validated shipping defaults — even `staged` /
// `staged-concurrent` are reserved-but-registered topologies the picker
// may route to in future risk-tier routing. Classification-driven
// routing itself is deliberately conservative today (always
// `single_pass`); changing the picker is a behavior change that should
// be validated against the generation benchmark suite.
//
// Public surface is intentionally minimal: consumers import `WORKFLOWS`
// (the map) + `pickWorkflow` (the router) + `WorkflowId` (the key
// type). Individual topology constants (SINGLE_PASS, STAGED,
// STAGED_CONCURRENT) are internal — access them via
// `WORKFLOWS.single_pass` etc.

import type { Classification } from "./classifier/axes.js";
import type { Workflow } from "./harness/types-public.js";

/** Identity parser — used for tasks whose output is already a string. */
const identityParser = (raw: unknown): string => raw as string;

/**
 * single_pass — one phase, one task. The current default. The task runs
 * the existing impl/patch/eval-fix loop as a single atomic block.
 */
const SINGLE_PASS: Workflow = {
  id: "single_pass@1",
  name: "single_pass",
  description: "One LLM-driven impl loop. Used for risk:low + risk:medium contract.",
  phases: [
    {
      id: "impl",
      tasks: [
        {
          id: "generate",
          systemPrompt: (ctx) => ctx.harness.how.systemPrompt,
          contextBuilder: (ctx) =>
            `User prompt: ${ctx.prompt}\n\nBoilerplate is pre-written. Fill it in with apply_changes.`,
          outputFormat: "tool-call",
          outputParser: identityParser,
          outputName: "source",
        },
      ],
    },
  ],
};

/**
 * staged — plan phase then execute phase. For risk:high contract where
 * decomposing planning from authoring reduces light-model cognitive load.
 *
 * Registered but not yet routed by `pickWorkflow` — the executor wires
 * architect/coder TaskRunners through a separate dispatch path in core/.
 */
const STAGED: Workflow = {
  id: "staged@1",
  name: "staged",
  description: "plan → execute. One architect task then one coder task.",
  phases: [
    {
      id: "plan",
      tasks: [
        {
          id: "architect",
          systemPrompt: "You are a UI architect. Produce a plan, no code.",
          contextBuilder: (ctx) => `Plan the UI for: ${ctx.prompt}`,
          outputFormat: "structured",
          outputParser: identityParser,
          outputName: "plan",
          maxTokens: 800,
        },
      ],
    },
    {
      id: "execute",
      tasks: [
        {
          id: "coder",
          systemPrompt: (ctx) => ctx.harness.how.systemPrompt,
          contextBuilder: (ctx) =>
            `User prompt: ${ctx.prompt}\n\nPlan:\n${ctx.priorResults.plan ?? "(no plan)"}\n\nImplement per plan with apply_changes.`,
          inputs: ["plan"],
          outputFormat: "tool-call",
          outputParser: identityParser,
          outputName: "source",
        },
      ],
    },
  ],
};

/**
 * staged-concurrent — plan, then parallel skeleton tasks, then integrate.
 * Reserved shape for risk:high + multi-axis contract where the LLM
 * benefits from breaking structural concerns apart.
 */
const STAGED_CONCURRENT: Workflow = {
  id: "staged_concurrent@1",
  name: "staged-concurrent",
  description: "plan → [types ∥ hooks ∥ jsx] → integrate. DAG with parallel skeleton phase.",
  phases: [
    {
      id: "plan",
      tasks: [
        {
          id: "architect",
          systemPrompt: "Plan the UI. No code.",
          contextBuilder: (ctx) => `Plan the UI for: ${ctx.prompt}`,
          outputFormat: "structured",
          outputParser: identityParser,
          outputName: "plan",
          maxTokens: 600,
        },
      ],
    },
    {
      id: "skeleton",
      tasks: [
        {
          id: "types",
          systemPrompt: "Emit only type declarations for the contract.",
          contextBuilder: (ctx) =>
            `Emit TypeScript types for: ${ctx.prompt}. Plan: ${ctx.priorResults.plan ?? "(n/a)"}`,
          inputs: ["plan"],
          outputFormat: "structured",
          outputParser: identityParser,
          outputName: "types",
          maxTokens: 400,
        },
        {
          id: "hooks",
          systemPrompt: "Emit only hook declarations (useState/useEffect/useStream).",
          contextBuilder: (ctx) =>
            `Emit hooks for: ${ctx.prompt}. Plan: ${ctx.priorResults.plan ?? "(n/a)"}`,
          inputs: ["plan"],
          outputFormat: "structured",
          outputParser: identityParser,
          outputName: "hooks",
          maxTokens: 400,
        },
        {
          id: "jsx",
          systemPrompt: "Emit only the render JSX tree skeleton.",
          contextBuilder: (ctx) =>
            `Emit JSX for: ${ctx.prompt}. Plan: ${ctx.priorResults.plan ?? "(n/a)"}`,
          inputs: ["plan"],
          outputFormat: "structured",
          outputParser: identityParser,
          outputName: "jsx",
          maxTokens: 400,
        },
      ],
    },
    {
      id: "integrate",
      tasks: [
        {
          id: "glue",
          systemPrompt: (ctx) => ctx.harness.how.systemPrompt,
          contextBuilder: (ctx) =>
            `Combine into one component. Types:\n${ctx.priorResults.types}\n\nHooks:\n${ctx.priorResults.hooks}\n\nJSX:\n${ctx.priorResults.jsx}`,
          inputs: ["types", "hooks", "jsx"],
          outputFormat: "tool-call",
          outputParser: identityParser,
          outputName: "source",
        },
      ],
    },
  ],
};

export const WORKFLOWS = {
  single_pass: SINGLE_PASS,
  staged: STAGED,
  staged_concurrent: STAGED_CONCURRENT,
} as const;

export type WorkflowId = keyof typeof WORKFLOWS;

/**
 * Pick a workflow based on classification shape. One dispatch rule —
 * kept small on purpose. Changing this mapping is a first-class
 * experiment.
 *
 * Deliberately conservative — always `single_pass`. Classification-
 * driven routing to `staged` / `staged-concurrent` will follow once
 * the workflow executor can actually run non-single_pass shapes end-
 * to-end on the dispatch path.
 */
export function pickWorkflow(_classification: Classification): Workflow {
  return WORKFLOWS.single_pass;
}
