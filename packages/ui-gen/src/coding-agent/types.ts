// packages/ui-gen/src/coding-agent/types.ts
//
// Shared types for the virtual-git workspace + tool executor consumed
// by the harness coding loop (`harness/coding/*`).

// =============================================================================
// Build & Check Results
// =============================================================================

export interface BuildResult {
  success: boolean;
  compiledCode?: string;
  errors?: string[];
}

export interface CommitMetadata {
  build: BuildResult;
  selfCheck: { passed: boolean; violations: string[] };
}

// =============================================================================
// Tool Execution Types
// =============================================================================

export interface ToolResult {
  /** Text shown to LLM */
  result: string;
  /** Commit passed self-check — generation complete */
  done?: boolean;
  /** Tool execution failed */
  error?: boolean;
  /** Compiled code (only set when done) */
  compiledCode?: string;
}

export interface ApplyResult {
  success: boolean;
  error?: string;
}
