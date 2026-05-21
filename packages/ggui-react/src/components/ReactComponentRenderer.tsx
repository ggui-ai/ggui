/**
 * ReactComponentRenderer - Renders a compiled ESM component directly in the
 * host React tree (no iframe). Uses globalThis.__ggui__ registry + data-url
 * import rewriting to resolve bare specifiers at runtime.
 *
 * Wire hooks (@ggui-ai/wire) are available to generated components via the
 * __ggui__.wire registry entry, enabling useAction, useStream, etc.
 */

import React, {
  useEffect,
  useId,
  useState,
  type ReactNode,
} from 'react';
import * as Primitives from '@ggui-ai/design/primitives';
import * as Components from '@ggui-ai/design/components';
import * as Compositions from '@ggui-ai/design/compositions';
import * as Interact from '@ggui-ai/design/interact';
import { stripMarkers, rewriteImports, getScopedThemeCss, getScopedCssTokens } from '@ggui-ai/design/rendering';
import { hoistImports, loadModule } from '@ggui-ai/design/module-loader';
import * as Wire from '@ggui-ai/wire';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReactComponentRendererProps {
  /** Compiled JavaScript code (ESM module with default export), or a URL to fetch it from */
  code: string;
  /** Props to pass to the rendered component */
  props?: Record<string, unknown>;
  /** Theme ID to use for CSS variables (uses default theme if omitted) */
  themeId?: string;
  /** Extra CSS injected after the theme CSS (e.g. dark-mode overrides) */
  cssOverrides?: string;
  /** Fallback UI while loading */
  fallback?: ReactNode;
  /** Error handler */
  onError?: (error: Error) => void;
  /** Called when auto-retry fails — parent should trigger re-generation */
  onRequestRepair?: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// Scope class counter (fallback for environments without useId)
// ---------------------------------------------------------------------------

let scopeCounter = 0;

/**
 * Generate a CSS-safe scope class from a React useId value.
 * React useId returns strings like `:r0:` which are not valid CSS class names.
 */
function makeScopeClass(reactId: string): string {
  return `ggui-rcr-${reactId.replace(/[^a-z0-9]/gi, '')}`;
}

// ---------------------------------------------------------------------------
// ErrorBoundary
// ---------------------------------------------------------------------------

/** Max auto-retries before showing error UI */
const AUTO_RETRY_LIMIT = 1;
/** Delay before auto-retry (ms) */
const AUTO_RETRY_DELAY = 500;

interface ErrorBoundaryProps {
  children: ReactNode;
  onError?: (error: Error) => void;
  /** Called when auto-retry exhausts — passes error for repair. */
  onRequestRepair?: (error: Error) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Total times we've caught an error (includes auto-retries) */
  catchCount: number;
  /** Whether we're in auto-retry delay */
  autoRetrying: boolean;
  /** Whether repair was requested */
  repairRequested: boolean;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, catchCount: 0, autoRetrying: false, repairRequested: false };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error): void {
    const nextCount = this.state.catchCount + 1;
    this.setState({ catchCount: nextCount });

    if (nextCount <= AUTO_RETRY_LIMIT) {
      // Auto-retry: clear error after a short delay and re-render
      this.setState({ autoRetrying: true });
      this.retryTimer = setTimeout(() => {
        this.setState({ error: null, autoRetrying: false });
      }, AUTO_RETRY_DELAY);
    } else {
      // Auto-retries exhausted — request repair automatically
      this.props.onError?.(error);
      if (this.props.onRequestRepair && !this.state.repairRequested) {
        this.setState({ repairRequested: true });
        this.props.onRequestRepair(error);
      }
    }
  }

  componentWillUnmount(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  render(): ReactNode {
    const { error, autoRetrying, repairRequested, catchCount } = this.state;

    if (!error) return this.props.children;

    // Auto-retrying — show subtle loading state
    if (autoRetrying) {
      return (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 24, minHeight: 80, gap: 8,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          fontSize: 13, color: 'rgba(255,255,255,0.4)',
        }}>
          <div style={{
            width: 16, height: 16, border: '2px solid rgba(255,255,255,0.15)',
            borderTopColor: 'rgba(255,255,255,0.5)', borderRadius: '50%',
            animation: 'ggui-err-spin 0.6s linear infinite',
          }} />
          Retrying...
          <style>{`@keyframes ggui-err-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      );
    }

    // Repair requested — show repairing state
    if (repairRequested) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '32px 24px', minHeight: 120, gap: 10, textAlign: 'center',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}>
          <div style={{
            width: 16, height: 16, border: '2px solid rgba(139,92,246,0.2)',
            borderTopColor: 'rgba(139,92,246,0.7)', borderRadius: '50%',
            animation: 'ggui-err-spin 0.8s linear infinite',
          }} />
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
            Repairing component...
          </div>
          <style>{`@keyframes ggui-err-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      );
    }

    // Exhausted retries, no repair available — show error UI
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '32px 24px', minHeight: 120, gap: 12, textAlign: 'center',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14,
          background: 'rgba(239, 68, 68, 0.1)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', fontSize: 22,
        }}>
          !
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.8)' }}>
          Something went wrong
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', maxWidth: 280, lineHeight: 1.4 }}>
          This component encountered an error. Try asking for a different view.
        </div>
        <button
          onClick={() => this.setState({ error: null, catchCount: 0, repairRequested: false })}
          style={{
            marginTop: 4, padding: '8px 20px', borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)',
            color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
        {catchCount > 1 && (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>
            {error.message}
          </div>
        )}
      </div>
    );
  }
}

// ---------------------------------------------------------------------------
// ReactComponentRenderer
// ---------------------------------------------------------------------------

/**
 * Renders a compiled ESM component directly in the host React tree.
 *
 * The component's bare import specifiers (`react`, `@ggui-ai/design/*`) are
 * rewritten to data-URL shims that read from window globals. This avoids
 * iframes while still resolving the ESM imports that the generated code uses.
 *
 * @example
 * ```tsx
 * <ReactComponentRenderer
 *   code={compiledEsm}
 *   props={{ title: "Hello" }}
 *   themeId="ggui"
 *   fallback={<LoadingSkeleton />}
 *   onError={console.error}
 * />
 * ```
 */
export function ReactComponentRenderer({
  code,
  props = {},
  themeId,
  cssOverrides,
  fallback = <div>Loading component...</div>,
  onError,
  onRequestRepair,
}: ReactComponentRendererProps): React.JSX.Element {
  const reactId = useId();
  const [scopeClass] = useState(() => makeScopeClass(reactId) || `ggui-rcr-${++scopeCounter}`);
  const [Component, setComponent] = useState<React.ComponentType<Record<string, unknown>> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!code || code.trim().length === 0) {
      setComponent(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setComponent(null);

    async function load() {
      try {
        // 0. If code is a URL (S3 presigned), fetch the actual code first
        let resolvedCode = code;
        if (code.startsWith('https://')) {
          const response = await fetch(code);
          if (!response.ok) {
            throw new Error(`Failed to fetch component code: ${response.status}`);
          }
          resolvedCode = await response.text();
        }

        // 1. Strip metadata markers
        const cleaned = stripMarkers(resolvedCode);

        // 2. Set globalThis.__ggui__ registry for data-url shims to read
        const w = globalThis as unknown as Record<string, unknown>;
        // Lazy-import react-dom to avoid bundling it (Turbopack rejects dynamic require)
        let reactDomModule: Record<string, unknown> = {};
        try {
          reactDomModule = await import('react-dom');
        } catch { /* react-dom not available — shim will return empty object */ }

        w.__ggui__ = {
          react: React,
          reactDom: reactDomModule,
          primitives: Primitives,
          components: Components,
          compositions: Compositions,
          interact: Interact,
          wire: Wire,
        };
        // Legacy globals for backward compat (pre-rebuilt design package)
        w.__REACT = React;
        w.__GGUI_PRIMITIVES = Primitives;
        w.__GGUI_COMPONENTS = Components;
        w.__GGUI_COMPOSITIONS = Compositions;
        w.__GGUI_INTERACT = Interact;

        // 3. Hoist imports above var declarations (bundled code may interleave them)
        const hoisted = hoistImports(cleaned);

        // 4. Rewrite bare specifiers to data-url shims
        const rewritten = rewriteImports(hoisted, { mode: 'data-url' });

        // 5. Dynamically import the module
        const mod = await loadModule(rewritten);

        if (cancelled) return;

        // 6. Extract the default export (or first function export)
        const Comp = (mod.default ??
          Object.values(mod).find(
            (v): v is React.ComponentType => typeof v === 'function',
          )) as React.ComponentType<Record<string, unknown>> | undefined;

        if (!Comp) {
          throw new Error('Module does not export a default component');
        }

        setComponent(() => Comp);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setComponent(null);
        onError?.(e);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [code]);

  // Compute scoped CSS
  const themeCss = themeId
    ? getScopedThemeCss(themeId, scopeClass)
    : getScopedCssTokens(scopeClass);

  if (!code || code.trim().length === 0) {
    return <div>{fallback}</div>;
  }

  if (loading) {
    return <div>{fallback}</div>;
  }

  if (error) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '32px 24px', minHeight: 120, gap: 12, textAlign: 'center',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14,
          background: 'rgba(239, 68, 68, 0.1)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', fontSize: 22,
        }}>
          !
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.8)' }}>
          Failed to load component
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', maxWidth: 280, lineHeight: 1.4 }}>
          {error.message}
        </div>
      </div>
    );
  }

  if (!Component) {
    return <div>{fallback}</div>;
  }

  return (
    <div className={scopeClass}>
      <style>{themeCss}{cssOverrides ?? ''}</style>
      <ErrorBoundary key={code.length} onError={onError} onRequestRepair={onRequestRepair}>
        <Component {...props} />
      </ErrorBoundary>
    </div>
  );
}
