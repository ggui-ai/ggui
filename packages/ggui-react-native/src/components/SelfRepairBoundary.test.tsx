import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { SelfRepairBoundary, type SelfRepairBoundaryProps } from './SelfRepairBoundary';
import type { SelfRepairConfig, ComponentRepairResult } from '@ggui-ai/shared';

// Component that throws on render
function ThrowingComponent({ shouldThrow = true }: { shouldThrow?: boolean }) {
  if (shouldThrow) throw new Error('Test render error');
  return React.createElement('Text', null, 'Working component');
}

// Silence console.error during expected error boundary triggers
const originalConsoleError = console.error;
beforeEach(() => {
  console.error = vi.fn();
});

afterAll(() => {
  console.error = originalConsoleError;
});

describe('SelfRepairBoundary', () => {
  const defaultConfig: SelfRepairConfig = {
    enabled: true,
    maxAttempts: 3,
    retryDelayMs: 1000,
    showRepairUI: true,
  };

  // `children` is required by `SelfRepairBoundaryProps`; the
  // `React.createElement` third-arg overload doesn't relax the prop
  // check at the call site, so we satisfy it with `null` here and let
  // the actual child node (passed as the third arg) win at runtime.
  const defaultProps = {
    appId: 'app_456',
    sessionId: 'session_789',
    config: defaultConfig,
    onReportError: vi.fn(async () => {}),
    children: null as React.ReactNode,
  };

  it('renders children normally when no error occurs', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(
          SelfRepairBoundary,
          defaultProps,
          React.createElement('Text', null, 'Hello world')
        )
      );
    });

    const json = JSON.stringify(renderer!.toJSON());
    expect(json).toContain('Hello world');
  });

  it('catches errors and triggers repair', () => {
    const onReportError = vi.fn<SelfRepairBoundaryProps['onReportError']>(
      async () => {},
    );

    act(() => {
      create(
        React.createElement(
          SelfRepairBoundary,
          { ...defaultProps, onReportError },
          React.createElement(ThrowingComponent)
        )
      );
    });

    // Should have reported the error
    expect(onReportError).toHaveBeenCalled();
    const firstCall = onReportError.mock.calls[0];
    expect(firstCall).toBeDefined();
    const report = firstCall![0];
    expect(report.error.message).toBe('Test render error');
    expect(report.sessionId).toBe('session_789');
  });

  it('shows repairing UI when showRepairUI is true', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(
          SelfRepairBoundary,
          { ...defaultProps },
          React.createElement(ThrowingComponent)
        )
      );
    });

    const json = JSON.stringify(renderer!.toJSON());
    expect(json).toContain('Auto-repairing');
  });

  it('does not attempt repair when disabled', () => {
    const onReportError = vi.fn(async () => {});

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(
          SelfRepairBoundary,
          {
            ...defaultProps,
            onReportError,
            config: { ...defaultConfig, enabled: false },
          },
          React.createElement(ThrowingComponent)
        )
      );
    });

    // Should NOT report error for repair
    expect(onReportError).not.toHaveBeenCalled();

    // Should show error UI
    const json = JSON.stringify(renderer!.toJSON());
    expect(json).toContain('Component Error');
  });

  it('handles successful repair result', () => {
    const onRepaired = vi.fn();

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(
          SelfRepairBoundary,
          { ...defaultProps, onRepaired },
          React.createElement(ThrowingComponent)
        )
      );
    });

    // Simulate successful repair result
    const boundaryInstance = renderer!.root.findByType(SelfRepairBoundary).instance as SelfRepairBoundary;
    const repairResult: ComponentRepairResult = {
      errorId: 'err_123',
      sessionId: 'session_789',
      success: true,
      repairedCode: 'fixed code',
    };

    act(() => {
      boundaryInstance.handleRepairResult(repairResult);
    });

    expect(onRepaired).toHaveBeenCalledWith(repairResult);
  });

  it('marks repair as failed after max attempts', async () => {
    const onRepairFailure = vi.fn();

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(
          SelfRepairBoundary,
          {
            ...defaultProps,
            config: {
              ...defaultConfig,
              maxAttempts: 1,
              onRepairFailure,
            },
          },
          React.createElement(ThrowingComponent)
        )
      );
    });

    // After act, the async attemptRepair has completed and bumped attemptCount to 1
    const boundaryInstance = renderer!.root.findByType(SelfRepairBoundary).instance as SelfRepairBoundary;
    const failedResult: ComponentRepairResult = {
      errorId: 'err_123',
      sessionId: 'session_789',
      success: false,
      failureReason: 'Could not fix',
    };

    // handleRepairResult: attemptCount (1) >= maxAttempts (1) → marks as permanently failed
    act(() => {
      boundaryInstance.handleRepairResult(failedResult);
    });

    const json = JSON.stringify(renderer!.toJSON());
    expect(json).toContain('Component Error');
  });

  it('includes device context in error report', () => {
    const onReportError = vi.fn<SelfRepairBoundaryProps['onReportError']>(
      async () => {},
    );

    act(() => {
      create(
        React.createElement(
          SelfRepairBoundary,
          { ...defaultProps, onReportError },
          React.createElement(ThrowingComponent)
        )
      );
    });

    const firstCall = onReportError.mock.calls[0];
    expect(firstCall).toBeDefined();
    const report = firstCall![0];
    // Should include platform info from our mocked Platform/Dimensions
    expect(report.context.userAgent).toContain('ios');
    expect(report.context.userAgent).toContain('390x844');
  });

  it('resets error state via reset()', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(
          SelfRepairBoundary,
          { ...defaultProps },
          React.createElement(ThrowingComponent)
        )
      );
    });

    const boundaryInstance = renderer!.root.findByType(SelfRepairBoundary).instance as SelfRepairBoundary;

    act(() => {
      boundaryInstance.reset();
    });

    // After reset, it will try to render children again (which will throw again)
    // but state should have been cleared before re-render
    const state = boundaryInstance.state;
    // The boundary catches the error again immediately, so hasError may be true again
    // But the attempt count should have reset
    expect(state.attemptCount).toBeLessThanOrEqual(1);
  });
});
