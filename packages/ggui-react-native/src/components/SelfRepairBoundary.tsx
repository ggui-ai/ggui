/**
 * Self-Repair Error Boundary for React Native
 *
 * A React error boundary that catches runtime errors in generated components
 * and sends them to the server for automatic repair.
 *
 * React Native adaptation: Uses View, Text, Pressable, ActivityIndicator
 * instead of HTML elements. Uses Platform/Dimensions for device context.
 *
 * @experimental This component is a preview/experimental feature.
 * Error reports are sent to the server, but automatic delivery of repair
 * results back to the client requires server-side support that is not yet
 * implemented. The `handleRepairResult()` method exists but must be called
 * manually (e.g., via a ref) until the server protocol is finalized.
 */

import React, { Component, type ReactNode, type ErrorInfo } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  Platform,
  Dimensions,
} from 'react-native';
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
  /** GguiSession identity — single flat id per the current render shape. */
  sessionId: string;
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

interface SelfRepairBoundaryState {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
  isRepairing: boolean;
  attemptCount: number;
  repairFailed: boolean;
  errorId: string | null;
}

function generateErrorId(): string {
  return `err_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function getDeviceContext(): string {
  const { width, height } = Dimensions.get('window');
  return `${Platform.OS}/${Platform.Version} ${width}x${height}`;
}

/**
 * Self-Repair Error Boundary for React Native
 *
 * Catches errors in child components and sends them to the server for repair.
 * If repair succeeds, the component is re-rendered with the fixed code.
 *
 * @experimental Repair result delivery requires server-side support that is
 * not yet implemented. Error reports are sent, but results must be delivered
 * manually via `handleRepairResult()` (e.g., through a ref).
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

    this.setState({ componentStack: errorInfo.componentStack || null });

    if (!config.enabled) {
      console.error('[SelfRepairBoundary] Error caught (repair disabled):', error);
      return;
    }

    this.attemptRepair(error, errorInfo.componentStack || undefined);
  }

  private async attemptRepair(error: Error, componentStack?: string): Promise<void> {
    const { config, appId, sessionId, sourceCode, compiledCode, onReportError } =
      this.props;
    const { attemptCount, errorId } = this.state;

    if (attemptCount >= config.maxAttempts) {
      this.setState({ repairFailed: true, isRepairing: false });
      config.onRepairFailure?.(errorId || 'unknown', 'Max repair attempts reached');
      return;
    }

    this.setState({ isRepairing: true });
    config.onRepairStart?.(errorId || 'unknown');

    const report: ComponentErrorReport = {
      errorId: errorId || generateErrorId(),
      appId,
      sessionId,
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack,
        componentStack,
      },
      context: {
        action: 'render',
        userAgent: getDeviceContext(),
      },
      sourceCode,
      compiledCode,
      timestamp: new Date().toISOString(),
      attemptCount: attemptCount + 1,
    };

    try {
      await onReportError(report);
      this.setState((prev) => ({ attemptCount: prev.attemptCount + 1 }));
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
   * Handle repair result from server (called when WebSocket receives repair result)
   */
  public handleRepairResult(result: ComponentRepairResult): void {
    const { config, onRepaired } = this.props;

    if (result.success) {
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
      const { attemptCount } = this.state;
      const { maxAttempts, retryDelayMs } = config;

      if (attemptCount < maxAttempts) {
        setTimeout(() => {
          if (this.state.error) {
            this.attemptRepair(this.state.error, this.state.componentStack || undefined);
          }
        }, retryDelayMs);
      } else {
        this.setState({ repairFailed: true, isRepairing: false });
        config.onRepairFailure?.(result.errorId, result.failureReason || 'Repair failed');
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

    if (!hasError) {
      return children;
    }

    // Repairing in progress
    if (isRepairing && config.showRepairUI) {
      return (
        repairingFallback || (
          <View style={styles.repairingContainer}>
            <ActivityIndicator size="small" color="#92400e" />
            <Text style={styles.repairingText}>Auto-repairing component...</Text>
            <Text style={styles.repairingAttempt}>
              Attempt {attemptCount + 1} of {config.maxAttempts}
            </Text>
          </View>
        )
      );
    }

    // Repair failed permanently
    if (repairFailed || !config.enabled) {
      return (
        errorFallback || (
          <View style={styles.errorContainer}>
            <Text style={styles.errorTitle}>Component Error</Text>
            <Text style={styles.errorMessage}>{error?.message || 'An error occurred'}</Text>
            {config.enabled && (
              <Pressable style={styles.retryButton} onPress={() => this.reset()}>
                <Text style={styles.retryText}>Try Again</Text>
              </Pressable>
            )}
          </View>
        )
      );
    }

    // Default error state (repair in progress but UI hidden)
    return null;
  }
}

const styles = StyleSheet.create({
  repairingContainer: {
    padding: 16,
    backgroundColor: '#fef3c7',
    borderWidth: 1,
    borderColor: '#f59e0b',
    borderRadius: 8,
    alignItems: 'center',
    gap: 8,
  },
  repairingText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#92400e',
  },
  repairingAttempt: {
    fontSize: 12,
    color: '#92400e',
  },
  errorContainer: {
    padding: 16,
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 8,
    alignItems: 'center',
    gap: 8,
  },
  errorTitle: {
    fontWeight: '700',
    color: '#991b1b',
    fontSize: 16,
  },
  errorMessage: {
    fontSize: 14,
    color: '#991b1b',
    textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#dc2626',
    borderRadius: 6,
    marginTop: 4,
  },
  retryText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 14,
  },
});
