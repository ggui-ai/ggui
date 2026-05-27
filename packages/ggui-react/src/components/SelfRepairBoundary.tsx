/**
 * Self-Repair Error Boundary
 *
 * A React error boundary that catches runtime errors in generated components
 * and sends them to the server for automatic repair.
 *
 * Premium Feature: Requires self-repair to be enabled in the app config.
 *
 * @experimental This component is a preview/experimental feature.
 * Error reports are sent to the server, but automatic delivery of repair
 * results back to the client requires server-side support that is not yet
 * implemented. The `handleRepairResult()` method exists but must be called
 * manually (e.g., via a ref) until the server protocol is finalized.
 */

import React, { Component, type ReactNode, type ErrorInfo } from 'react';
import type {
  ComponentErrorReport,
  ComponentRepairResult,
  SelfRepairConfig,
} from '@ggui-ai/shared';

/**
 * Props for SelfRepairBoundary
 */
export interface SelfRepairBoundaryProps {
  /** Child components to wrap */
  children: ReactNode;
  /** App ID */
  appId: string;
  /** Render identity — single flat id post-Phase-B (replaces the legacy
   *  `sessionId` + `stackItemId` pair). */
  renderId: string;
  /** Original source code (if available) */
  sourceCode?: string;
  /** Compiled code */
  compiledCode?: string;
  /** Self-repair configuration */
  config: SelfRepairConfig;
  /** Function to send error report to server */
  onReportError: (report: ComponentErrorReport) => Promise<void>;
  /** Callback when component is repaired */
  onRepaired?: (result: ComponentRepairResult) => void;
  /** Fallback UI while repairing */
  repairingFallback?: ReactNode;
  /** Fallback UI when repair fails */
  errorFallback?: ReactNode;
}

/**
 * State for SelfRepairBoundary
 */
interface SelfRepairBoundaryState {
  /** Whether an error has occurred */
  hasError: boolean;
  /** The error that occurred */
  error: Error | null;
  /** Component stack from React */
  componentStack: string | null;
  /** Whether repair is in progress */
  isRepairing: boolean;
  /** Number of repair attempts */
  attemptCount: number;
  /** Whether repair has failed permanently */
  repairFailed: boolean;
  /** Error ID for tracking */
  errorId: string | null;
}

/**
 * Generate unique error ID
 */
function generateErrorId(): string {
  return `err_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Self-Repair Error Boundary
 *
 * Catches errors in child components and sends them to the server for repair.
 * If repair succeeds, the component is re-rendered with the fixed code.
 *
 * @experimental Repair result delivery requires server-side support that is
 * not yet implemented. Error reports are sent, but results must be delivered
 * manually via `handleRepairResult()` (e.g., through a ref).
 *
 * @example
 * ```tsx
 * <SelfRepairBoundary
 *   appId="app-456"
 *   renderId="render-789"
 *   config={{ enabled: true, maxAttempts: 3, retryDelayMs: 1000, showRepairUI: true }}
 *   onReportError={reportError}
 * >
 *   <DynamicComponent code={compiledCode} />
 * </SelfRepairBoundary>
 * ```
 */
export class SelfRepairBoundary extends Component<
  SelfRepairBoundaryProps,
  SelfRepairBoundaryState
> {
  private static _warnedExperimental = false;

  constructor(props: SelfRepairBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      componentStack: null,
      isRepairing: false,
      attemptCount: 0,
      repairFailed: false,
      errorId: null,
    };
  }

  componentDidMount(): void {
    if (!SelfRepairBoundary._warnedExperimental) {
      SelfRepairBoundary._warnedExperimental = true;
      console.warn(
        'SelfRepairBoundary: This is an experimental feature. ' +
        'Repair result delivery requires server-side support that is not yet implemented. ' +
        'Error reports will be sent, but automatic repair results will not be received ' +
        'until the server protocol is finalized.'
      );
    }
  }

  static getDerivedStateFromError(error: Error): Partial<SelfRepairBoundaryState> {
    return {
      hasError: true,
      error,
      errorId: generateErrorId(),
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const { config } = this.props;

    // Update state with component stack
    this.setState({ componentStack: errorInfo.componentStack || null });

    // If self-repair is disabled, just log the error
    if (!config.enabled) {
      console.error('[SelfRepairBoundary] Error caught (repair disabled):', error);
      return;
    }

    // Trigger repair process
    this.attemptRepair(error, errorInfo.componentStack || undefined);
  }

  private async attemptRepair(error: Error, componentStack?: string): Promise<void> {
    const { config, appId, renderId, sourceCode, compiledCode, onReportError } =
      this.props;
    const { attemptCount, errorId } = this.state;

    // Check if max attempts reached
    if (attemptCount >= config.maxAttempts) {
      this.setState({ repairFailed: true, isRepairing: false });
      config.onRepairFailure?.(errorId || 'unknown', 'Max repair attempts reached');
      return;
    }

    // Start repair
    this.setState({ isRepairing: true });
    config.onRepairStart?.(errorId || 'unknown');

    // Build error report
    const report: ComponentErrorReport = {
      errorId: errorId || generateErrorId(),
      appId,
      renderId,
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack,
        componentStack,
      },
      context: {
        action: 'render',
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      },
      sourceCode,
      compiledCode,
      timestamp: new Date().toISOString(),
      attemptCount: attemptCount + 1,
    };

    try {
      // Send error report to server
      await onReportError(report);

      // Increment attempt count
      this.setState((prev) => ({ attemptCount: prev.attemptCount + 1 }));

      // Note: The actual repair result comes back via WebSocket event
      // which should call handleRepairResult
    } catch (err) {
      console.error('[SelfRepairBoundary] Failed to report error:', err);
      this.setState({ repairFailed: true, isRepairing: false });
      config.onRepairFailure?.(
        errorId || 'unknown',
        err instanceof Error ? err.message : 'Failed to report error'
      );
    }
  }

  /**
   * Handle repair result from server
   * This should be called when the WebSocket receives a repair result
   */
  public handleRepairResult(result: ComponentRepairResult): void {
    const { config, onRepaired } = this.props;

    if (result.success) {
      // Repair succeeded - reset error state
      this.setState({
        hasError: false,
        error: null,
        componentStack: null,
        isRepairing: false,
        repairFailed: false,
      });
      config.onRepairSuccess?.(result);
      onRepaired?.(result);
    } else {
      // Repair failed
      const { attemptCount } = this.state;
      const { maxAttempts, retryDelayMs } = config;

      if (attemptCount < maxAttempts) {
        // Retry after delay
        setTimeout(() => {
          if (this.state.error) {
            this.attemptRepair(this.state.error, this.state.componentStack || undefined);
          }
        }, retryDelayMs);
      } else {
        // Give up
        this.setState({ repairFailed: true, isRepairing: false });
        config.onRepairFailure?.(
          result.errorId,
          result.failureReason || 'Repair failed'
        );
      }
    }
  }

  /**
   * Reset the error boundary (for retry button)
   */
  public reset(): void {
    this.setState({
      hasError: false,
      error: null,
      componentStack: null,
      isRepairing: false,
      attemptCount: 0,
      repairFailed: false,
      errorId: null,
    });
  }

  render(): ReactNode {
    const { children, config, repairingFallback, errorFallback } = this.props;
    const { hasError, isRepairing, repairFailed, error, attemptCount } = this.state;

    // No error - render children normally
    if (!hasError) {
      return children;
    }

    // Repairing in progress
    if (isRepairing && config.showRepairUI) {
      return (
        repairingFallback || (
          <div
            style={{
              padding: '1rem',
              textAlign: 'center',
              backgroundColor: '#fef3c7',
              border: '1px solid #f59e0b',
              borderRadius: '0.5rem',
            }}
          >
            <div style={{ marginBottom: '0.5rem' }}>
              <span role="img" aria-label="repairing">
                🔧
              </span>{' '}
              Auto-repairing component...
            </div>
            <div style={{ fontSize: '0.875rem', color: '#92400e' }}>
              Attempt {attemptCount + 1} of {config.maxAttempts}
            </div>
          </div>
        )
      );
    }

    // Repair failed permanently
    if (repairFailed || !config.enabled) {
      return (
        errorFallback || (
          <div
            style={{
              padding: '1rem',
              textAlign: 'center',
              backgroundColor: '#fee2e2',
              border: '1px solid #ef4444',
              borderRadius: '0.5rem',
            }}
          >
            <div style={{ marginBottom: '0.5rem', fontWeight: 'bold' }}>
              <span role="img" aria-label="error">
                ❌
              </span>{' '}
              Component Error
            </div>
            <div style={{ fontSize: '0.875rem', color: '#991b1b', marginBottom: '0.5rem' }}>
              {error?.message || 'An error occurred'}
            </div>
            {config.enabled && (
              <button
                onClick={() => this.reset()}
                style={{
                  padding: '0.5rem 1rem',
                  backgroundColor: '#dc2626',
                  color: 'white',
                  border: 'none',
                  borderRadius: '0.25rem',
                  cursor: 'pointer',
                }}
              >
                Try Again
              </button>
            )}
          </div>
        )
      );
    }

    // Default error state (repair in progress but UI hidden)
    return null;
  }
}

export default SelfRepairBoundary;
