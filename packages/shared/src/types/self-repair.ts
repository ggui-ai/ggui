/**
 * Self-Repair Types
 *
 * Types for the self-repair system that automatically fixes runtime errors
 * in generated components. This is a premium feature.
 *
 * Flow:
 * 1. Client detects runtime error (React error boundary, window.onerror)
 * 2. Client sends error report to server via WebSocket
 * 3. Server analyzes error with LLM and generates fix
 * 4. Server sends repaired code back to client
 * 5. Client hot-reloads the fixed component
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

/**
 * WebSocket event types for self-repair
 */
export type SelfRepairEventType =
  | 'component:error'      // Client → Server: Report error
  | 'component:repairing'  // Server → Client: Repair in progress
  | 'component:repaired'   // Server → Client: Repair complete
  | 'component:repair-failed'; // Server → Client: Repair failed

/**
 * Self-repair WebSocket events
 */
export interface SelfRepairEvents {
  'component:error': ComponentErrorReport;
  'component:repairing': { errorId: string; sessionId: string };
  'component:repaired': ComponentRepairResult;
  'component:repair-failed': { errorId: string; sessionId: string; reason: string };
}

/**
 * Repair history entry (for analytics)
 */
export interface RepairHistoryEntry {
  /** Error ID */
  errorId: string;
  /** App ID */
  appId: string;
  /** GguiSession ID */
  sessionId: string;
  /** Error type */
  errorType: string;
  /** Error message */
  errorMessage: string;
  /** Whether repair succeeded */
  repairSucceeded: boolean;
  /** Number of attempts */
  attempts: number;
  /** Total repair time */
  totalRepairTimeMs: number;
  /** Timestamp */
  timestamp: string;
}
