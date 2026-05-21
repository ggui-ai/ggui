/**
 * Error Boundary for React Native
 *
 * React Native equivalent of SelfRepairBoundary.
 * Catches runtime errors in generated components and displays
 * a native error UI with retry capability.
 */

import React, { Component, type ReactNode, type ErrorInfo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';

export interface ErrorBoundaryProps {
  children: ReactNode;
  onError?: (error: Error, componentStack?: string) => void;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.props.onError?.(error, errorInfo.componentStack || undefined);
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    const { children, fallback } = this.props;
    const { hasError, error } = this.state;

    if (!hasError) {
      return children;
    }

    if (fallback) {
      return fallback;
    }

    return (
      <View style={styles.container}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.message}>{error?.message || 'An error occurred'}</Text>
        <Pressable style={styles.retryButton} onPress={this.reset}>
          <Text style={styles.retryText}>Try Again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 8,
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontWeight: '700',
    color: '#991b1b',
    fontSize: 16,
  },
  message: {
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
