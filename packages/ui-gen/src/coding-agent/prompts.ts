// packages/ui-gen/src/coding-agent/prompts.ts
//
// Two-phase system prompts for the coding agent.
// Phase 1: initial generation (write only)
// Phase 2: reactive fix loop (write + apply_diff + read-only tools)
//
// write and apply_diff auto-commit and auto-validate — no separate commit step.

import type { Plan, CommitInput, CodingCriteria } from './types';

// =============================================================================
// Shared
// =============================================================================

function getOutputConstraints(): string {
  return `## Output Constraints
- The component must \`export default\` a React function component.
- Define an \`interface Props\` with typed fields.
- Use only primitives and hooks available in the design system context.
- No \`eval()\`, \`fetch()\`, or dynamic code loading.
- Only allowed imports: \`react\` and \`@ggui-ai/design\` packages.
- Use CSS variables \`var(--ggui-*)\` from the design system.
- Wire all props from propsSpec. Wire all actions from actionSpec.
- No hardcoded hex colors — use design tokens.
- No raw pixel values for spacing — use spacing tokens.
- Design system components only accept their typed props — do NOT pass \`role\`, \`aria-label\`, or arbitrary HTML attributes.`;
}

function serializeContract(commitInput: CommitInput): string {
  const parts = [`Props: ${JSON.stringify(commitInput.propsSpec, null, 2)}`];
  if (commitInput.actionSpec) {
    parts.push(`Actions: ${JSON.stringify(commitInput.actionSpec, null, 2)}`);
  }
  if (commitInput.streamSpec) {
    parts.push(`Stream: ${JSON.stringify(commitInput.streamSpec, null, 2)}`);
  }
  return parts.join('\n');
}

// =============================================================================
// Phase 1: Initial Generation
// =============================================================================

export function buildInitialSystemPrompt(
  designSystem: string,
  plan: Plan,
  commitInput: CommitInput,
  criteria: CodingCriteria,
): string {
  return `You are a UI component developer. A boilerplate with the correct Props interface and imports is already prepared. Implement the component based on the plan below.

Use \`write\` to replace the boilerplate with the full implementation, or \`apply_diff\` to patch it. Include a commit_message. The system will automatically compile and validate your code.

## Component Requirements
${plan.spec}
${plan.primitivesSelected ? `\nPreferred primitives: ${plan.primitivesSelected.join(', ')}` : ''}
${plan.stateStrategy ? `\nState strategy: ${plan.stateStrategy}` : ''}

## Data Contract
${serializeContract(commitInput)}

## User Request
${criteria.userRequest}

## Design System
${designSystem}

${getOutputConstraints()}`;
}

// =============================================================================
// Phase 2: Fix Loop
// =============================================================================

export function buildFixLoopSystemPrompt(): string {
  return `You are fixing a UI component that failed validation. Review the violations and the current file, then fix the issues.

Call \`write\` to replace the entire file, or \`apply_diff\` for targeted fixes. Include a commit_message describing your fix. The system will automatically compile and validate after each change.

## Diff Format (for apply_diff)
Use standard unified diff format:
  --- a/ui.tsx
  +++ b/ui.tsx
  @@ -<old_start>,<old_count> +<new_start>,<new_count> @@
   <context line (space prefix)>
  -<removed line>
  +<added line>
   <context line>

Include 3 lines of context around changes.

${getOutputConstraints()}`;
}
