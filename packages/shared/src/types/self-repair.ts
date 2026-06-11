/**
 * Self-Repair Types
 *
 * Shared vocabulary for reporting runtime errors in generated
 * components and describing repair outcomes.
 *
 * `SelfRepairBoundary` (in the React SDKs) catches a component error,
 * builds a `ComponentErrorReport`, and hands it to the consumer-supplied
 * `onReportError` callback — how (and whether) the report reaches a
 * repair backend is the consumer's choice; the boundary itself carries
 * no transport. `ComponentRepairResult` describes the outcome a repair
 * backend returns; `SelfRepairConfig` shapes the boundary's retry/UI
 * policy.
 */

/**
 * Error report sent from client to server
 */
export interface ComponentErrorReport {
  /** Unique error ID for tracking */
  errorId: string;
  /** GguiSession that experienced the error. Post-Phase-B the old
   *  per-item identity is gone — every GguiSession is now a top-level
   *  instance, folded into a single `sessionId`. */
  sessionId: string;
  /** App ID */
  appId: string;
  /** Error details */
  error: {
    /** Error message */
    message: string;
    /** Error name/type (e.g., TypeError, SyntaxError) */
    name: string;
    /** Stack trace */
    stack?: string;
    /** Component stack (React-specific) */
    componentStack?: string;
  };
  /** Context about when/where error occurred */
  context: {
    /** What was happening when error occurred */
    action?: 'render' | 'event' | 'effect' | 'callback' | 'data-binding';
    /** Props passed to component (sanitized) */
    props?: Record<string, unknown>;
    /** Resolved bindings at time of error */
    resolvedBindings?: Record<string, unknown>;
    /** Browser/environment info */
    userAgent?: string;
  };
  /** Original source code (if available) */
  sourceCode?: string;
  /** Compiled code that failed */
  compiledCode?: string;
  /** Timestamp */
  timestamp: string;
  /** Number of repair attempts already made */
  attemptCount: number;
}

/**
 * Repair result from server
 */
export interface ComponentRepairResult {
  /** Whether repair was successful */
  success: boolean;
  /** The error ID this repairs */
  errorId: string;
  /** GguiSession ID — the failing component's render identity. */
  sessionId: string;
  /** Repaired compiled code (if successful) */
  repairedCode?: string;
  /** Repaired source code (if available) */
  repairedSourceCode?: string;
  /** Explanation of what was fixed */
  explanation?: string;
  /** If repair failed, why */
  failureReason?: string;
  /** Suggestions if auto-repair not possible */
  suggestions?: string[];
  /** Metrics */
  metrics?: {
    /** Time to generate repair */
    repairTimeMs: number;
    /** Tokens used */
    tokensUsed: number;
    /** Cost estimate */
    estimatedCostUsd: number;
  };
}

/**
 * Configuration for self-repair feature
 */
export interface SelfRepairConfig {
  /** Whether self-repair is enabled */
  enabled: boolean;
  /** Maximum repair attempts per component */
  maxAttempts: number;
  /** Delay between attempts (ms) */
  retryDelayMs: number;
  /** Whether to show repair status to user */
  showRepairUI: boolean;
  /** Callback when repair starts */
  onRepairStart?: (errorId: string) => void;
  /** Callback when repair succeeds */
  onRepairSuccess?: (result: ComponentRepairResult) => void;
  /** Callback when repair fails */
  onRepairFailure?: (errorId: string, reason: string) => void;
}
