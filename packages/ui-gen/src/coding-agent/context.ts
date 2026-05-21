// packages/ui-gen/src/coding-agent/context.ts
//
// Context serialization and compaction for the coding agent.
// Static context (never compacted) + dynamic context from git history.

import type { AgentWorkspace } from './workspace';
import type {
  CodingAgentInput,
  CommitMetadata,
  Plan,
  CommitInput,
  CodingCriteria,
} from './types';

// =============================================================================
// Static Context
// =============================================================================

export interface StaticContext {
  designSystem: string;
  plan: Plan;
  commitInput: CommitInput;
  criteria: CodingCriteria;
  evaluationFeedback?: string;
}

export function buildStaticContext(input: CodingAgentInput): StaticContext {
  return {
    designSystem: input.designSystem,
    plan: input.plan,
    commitInput: input.commitInput,
    criteria: input.criteria,
    evaluationFeedback: input.evaluationFeedback,
  };
}

// =============================================================================
// Dynamic Context
// =============================================================================

export interface RecentCommit {
  oid: string;
  message: string;
  status: string;
  violations: string;
  diff: string;
}

export interface DynamicContext {
  currentFile: string;
  recentCommits: RecentCommit[];
  olderCommits: string[];
}

export async function buildDynamicContext(
  workspace: AgentWorkspace,
  commitMeta: Map<string, CommitMetadata>,
): Promise<DynamicContext> {
  const commits = await workspace.log();
  const currentFile = workspace.cat();

  // Recent 2 commits: full diffs
  const recentCommits = await Promise.all(
    commits.slice(0, 2).map(async (c, i) => {
      const meta = commitMeta.get(c.oid);
      const parentOid =
        i + 1 < commits.length ? commits[i + 1].oid : null;
      const diff = parentOid
        ? await workspace.diffBetween(parentOid, c.oid)
        : '(initial commit)';
      const status = meta?.selfCheck.passed ? 'PASS' : meta?.selfCheck ? 'FAIL' : '—';
      const violations =
        meta?.selfCheck.passed === false
          ? `Violations: ${meta.selfCheck.violations.join(', ')}`
          : '';
      return {
        oid: c.oid,
        message: c.commit.message.trim(),
        status,
        violations,
        diff,
      };
    }),
  );

  // Older commits: message + status only
  const olderCommits = commits.slice(2).map((c) => {
    const meta = commitMeta.get(c.oid);
    const status = meta?.selfCheck.passed ? 'PASS' : meta?.selfCheck ? 'FAIL' : '—';
    return `${c.oid.slice(0, 7)} [${status}] ${c.commit.message.trim()}`;
  });

  return { currentFile, recentCommits, olderCommits };
}

// =============================================================================
// Serialization — Phase 1 (Initial)
// =============================================================================

export function serializeInitialContext(staticCtx: StaticContext): string {
  const parts: string[] = [];

  parts.push(`# Component Requirements\n${staticCtx.plan.spec}`);
  if (staticCtx.plan.primitivesSelected?.length) {
    parts.push(
      `Preferred primitives: ${staticCtx.plan.primitivesSelected.join(', ')}`,
    );
  }

  parts.push(
    `\n# Data Contract\nProps: ${JSON.stringify(staticCtx.commitInput.propsSpec, null, 2)}`,
  );
  if (staticCtx.commitInput.actionSpec) {
    parts.push(
      `Actions: ${JSON.stringify(staticCtx.commitInput.actionSpec, null, 2)}`,
    );
  }
  if (staticCtx.commitInput.streamSpec) {
    parts.push(
      `Stream: ${JSON.stringify(staticCtx.commitInput.streamSpec, null, 2)}`,
    );
  }

  parts.push(`\n# User Request\n${staticCtx.criteria.userRequest}`);
  parts.push(`\n# Design System\n${staticCtx.designSystem}`);

  if (staticCtx.evaluationFeedback) {
    parts.push(
      `\n# Evaluation Feedback (from previous attempt)\n${staticCtx.evaluationFeedback}`,
    );
  }

  return parts.join('\n');
}

// =============================================================================
// Serialization — Phase 2 (Fix Loop)
// =============================================================================

export function serializeFixLoopContext(
  staticCtx: StaticContext,
  dynamicCtx: DynamicContext,
): string {
  const parts: string[] = [];

  // Current file
  parts.push(`# Current ui.tsx\n\`\`\`tsx\n${dynamicCtx.currentFile}\n\`\`\``);

  // Recent changes (full diffs)
  if (dynamicCtx.recentCommits.length > 0) {
    parts.push('\n# Recent Changes');
    for (const c of dynamicCtx.recentCommits) {
      parts.push(
        `\n## ${c.oid.slice(0, 7)}: ${c.message} [${c.status}]`,
      );
      if (c.violations) parts.push(c.violations);
      parts.push(`\`\`\`diff\n${c.diff}\n\`\`\``);
    }
  }

  // Older history
  if (dynamicCtx.olderCommits.length > 0) {
    parts.push('\n# Earlier History');
    for (const line of dynamicCtx.olderCommits) {
      parts.push(`- ${line}`);
    }
  }

  // Data contract reminder (brief)
  parts.push(
    `\n# Data Contract (reminder)\nProps: ${JSON.stringify(staticCtx.commitInput.propsSpec)}`,
  );
  if (staticCtx.commitInput.actionSpec) {
    parts.push(
      `Actions: ${JSON.stringify(staticCtx.commitInput.actionSpec)}`,
    );
  }

  // Evaluation feedback
  if (staticCtx.evaluationFeedback) {
    parts.push(`\n# Evaluation Feedback\n${staticCtx.evaluationFeedback}`);
  }

  return parts.join('\n');
}
