/**
 * React component renderer for the iframe runtime.
 *
 * Port of `@ggui-ai/react::components/ReactComponentRenderer.tsx` (L10-384)
 * with the enclosing React component stripped — the iframe runtime
 * does not have an outer React tree; it owns the root `createRoot`
 * mount itself. The inner eval + data-URL-shim + error-boundary
 * pattern is preserved verbatim so today's generated code (which
 * reads `globalThis.__ggui__` via the shim rewrite) keeps working.
 *
 * Lifecycle seams:
 *
 *   - `mount(container, render)` — replace the container's
 *     children with a React root rendering the compiled component.
 *     Returns a `ReactRootMount` handle; callers use `update()` to
 *     swap props without re-evaluating the module, `unmount()` to
 *     tear down.
 *   - `update(render)` — swap props (and/or componentCode). When
 *     componentCode changes, re-evaluates; when only props change,
 *     re-renders the existing component tree with new props.
 *   - `unmount()` — `root.unmount()` + detach observability.
 *
 * Error handling — ErrorBoundary with auto-retry (AUTO_RETRY_LIMIT +
 * AUTO_RETRY_DELAY) matches the `ReactComponentRenderer` contract.
 * On terminal error, the callback `onRequestRepair` fires; the
 * render dispatcher (`render-item.ts`) wires this to the
 * `ggui:request-repair` live-channel envelope it dispatches.
 *
 * No JSX in this file — the mount-root code uses
 * `React.createElement` + `React.Fragment` directly so the renderer's
 * TypeScript config doesn't need a JSX runtime plumbing.
 */
import React, {
  Component,
  createElement,
  Fragment,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  stripMarkers,
  rewriteImports,
  getScopedThemeCss,
  getScopedCssTokens,
  getThemeCss,
  getCssTokens,
} from '@ggui-ai/design/rendering';
import { hoistImports, loadModule } from '@ggui-ai/design/module-loader';

// =============================================================================
// Scope class helpers — port of RCR's `makeScopeClass` + counter.
// =============================================================================

let scopeCounter = 0;

/**
 * Generate a CSS-safe scope class. The iframe-internal mount doesn't
 * have access to React's `useId` (we're not inside a React tree at
 * the call site), so the counter is the always-available fallback.
 * `data-` attribute wrapping plus the counter-based class is fine —
 * only one ReactRootMount exists per iframe by construction.
 */
function makeScopeClass(): string {
  scopeCounter += 1;
  return `ggui-rcr-${scopeCounter}`;
}

// =============================================================================
// Error boundary — port of RCR's internal ErrorBoundary (L68–203).
// =============================================================================

const AUTO_RETRY_LIMIT = 1;
const AUTO_RETRY_DELAY = 500;

interface ErrorBoundaryProps {
  // `children` declared optional so `React.createElement(Boundary,
  // props, ...children)` is accepted by TS — the positional children
  // path doesn't include the key in `props`. At runtime React always
  // populates `this.props.children`.
  readonly children?: ReactNode;
  readonly onError?: (error: Error) => void;
  readonly onRequestRepair?: (error: Error) => void;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
  readonly catchCount: number;
  readonly autoRetrying: boolean;
  readonly repairRequested: boolean;
}

class RcrErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
    catchCount: 0,
    autoRetrying: false,
    repairRequested: false,
  };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    const nextCount = this.state.catchCount + 1;
    this.setState({ catchCount: nextCount });

    if (nextCount <= AUTO_RETRY_LIMIT) {
      this.setState({ autoRetrying: true });
      this.retryTimer = setTimeout(() => {
        this.setState({ error: null, autoRetrying: false });
      }, AUTO_RETRY_DELAY);
      return;
    }

    this.props.onError?.(error);
    if (this.props.onRequestRepair && !this.state.repairRequested) {
      this.setState({ repairRequested: true });
      this.props.onRequestRepair(error);
    }
  }

  componentWillUnmount(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
  }

  render(): ReactNode {
    const { error, autoRetrying, repairRequested, catchCount } = this.state;
    if (error === null) return this.props.children;

    // The three fallback UIs match the host-SDK error boundary
    // verbatim (same inline styles so operator-visible DOM is
    // identical between the host-SDK and iframe-renderer paths).
    const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    if (autoRetrying) {
      return createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            minHeight: 80,
            gap: 8,
            fontFamily: FONT,
            fontSize: 13,
            color: 'rgba(255,255,255,0.4)',
          },
        },
        createElement('div', {
          style: {
            width: 16,
            height: 16,
            border: '2px solid rgba(255,255,255,0.15)',
            borderTopColor: 'rgba(255,255,255,0.5)',
            borderRadius: '50%',
            animation: 'ggui-err-spin 0.6s linear infinite',
          },
        }),
        'Retrying...',
        createElement('style', null, '@keyframes ggui-err-spin { to { transform: rotate(360deg); } }'),
      );
    }

    if (repairRequested) {
      return createElement(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '32px 24px',
            minHeight: 120,
            gap: 10,
            textAlign: 'center',
            fontFamily: FONT,
          },
        },
        createElement('div', {
          style: {
            width: 16,
            height: 16,
            border: '2px solid rgba(139,92,246,0.2)',
            borderTopColor: 'rgba(139,92,246,0.7)',
            borderRadius: '50%',
            animation: 'ggui-err-spin 0.8s linear infinite',
          },
        }),
        createElement(
          'div',
          { style: { fontSize: 13, color: 'rgba(255,255,255,0.5)' } },
          'Repairing component...',
        ),
        createElement('style', null, '@keyframes ggui-err-spin { to { transform: rotate(360deg); } }'),
      );
    }

    return createElement(
      'div',
      {
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px 24px',
          minHeight: 120,
          gap: 12,
          textAlign: 'center',
          fontFamily: FONT,
        },
      },
      createElement(
        'div',
        {
          style: {
            width: 48,
            height: 48,
            borderRadius: 14,
            background: 'rgba(239, 68, 68, 0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
          },
        },
        '!',
      ),
      createElement(
        'div',
        { style: { fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.8)' } },
        'Something went wrong',
      ),
      createElement(
        'div',
        { style: { fontSize: 12, color: 'rgba(255,255,255,0.4)', maxWidth: 280, lineHeight: 1.4 } },
        'This component encountered an error. Try asking for a different view.',
      ),
      createElement(
        'button',
        {
          onClick: () => this.setState({ error: null, catchCount: 0, repairRequested: false }),
          style: {
            marginTop: 4,
            padding: '8px 20px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'rgba(255,255,255,0.08)',
            color: 'rgba(255,255,255,0.7)',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          },
        },
        'Retry',
      ),
      catchCount > 1
        ? createElement(
            'div',
            { style: { fontSize: 11, color: 'rgba(255,255,255,0.2)' } },
            error.message,
          )
        : null,
    );
  }
}

// =============================================================================
// Public mount API
// =============================================================================

export interface ReactRootMountOptions {
  /**
   * Render whose componentCode + props drive the mount. Only
   * `componentCode` + `props` are read here; the caller is
   * responsible for wrapping this with a `<GguiWireProvider>` at the
   * higher-level dispatcher (see `render-item.ts`).
   */
  readonly render: {
    readonly id?: string;
    readonly componentCode: string;
    readonly props?: Record<string, unknown>;
  };
  readonly themeId?: string;
  /**
   * Theme color mode resolved for this mount. Forwards to
   * `getScopedThemeCss` / `getThemeCss` so the dark variant of the
   * registered theme paints when the operator selected it.
   */
  readonly themeMode?: 'light' | 'dark';
  readonly cssOverrides?: string;
  readonly onError?: (error: Error) => void;
  readonly onRequestRepair?: (error: Error) => void;
  /**
   * Children injected BETWEEN the mount DOM (scope + CSS) and the
   * evaluated component element. The caller's render dispatcher
   * uses this to wrap the eval'd component in `<GguiWireProvider>`
   * so wire hooks resolve per-render contracts.
   *
   * When `undefined`, the evaluated component renders directly.
   */
  readonly renderWrapper?: (mountedComponent: ReactNode) => ReactNode;
  /**
   * Bare npm package names of the operator-registered 3rd-party gadget
   * packages reachable in this render (GG.8.2). Forwarded to
   * `rewriteImports` so each direct gadget import resolves to its
   * per-package data-URL shim. Sourced from the bootstrap's `gadgets`
   * channel; `@ggui-ai/gadgets` (STDLIB) is always rewritten and need
   * not appear here.
   */
  readonly gadgetPackages?: readonly string[];
}

export interface ReactRootMount {
  /**
   * Swap props (and/or componentCode). When componentCode changes,
   * the module is re-evaluated. Pure-props changes skip the
   * evaluation and re-render with new props — matches RCR's
   * `useEffect([code])` dependency behavior.
   */
  update(next: ReactRootMountOptions): Promise<void>;
  /** Tear down the React root + release retained state. */
  unmount(): void;
  /** Current component code (useful for tests + audit). */
  readonly currentCode: string | null;
}

/**
 * Mount a React root inside `container` and render `render`'s
 * compiled componentCode. The container is fully owned after this
 * call (existing children are replaced).
 */
export async function mountReactRoot(
  container: HTMLElement,
  opts: ReactRootMountOptions,
): Promise<ReactRootMount> {
  container.replaceChildren();
  const root = createRoot(container);
  const scopeClass = makeScopeClass();

  let currentOpts = opts;
  let currentCode: string | null = null;
  let currentComponent: ComponentType<Record<string, unknown>> | null = null;

  async function evaluate(code: string): Promise<ComponentType<Record<string, unknown>>> {
    // 0. If code is a URL (S3 presigned), fetch the bytes first.
    //    Matches RCR's first-step URL-fetch guard verbatim.
    let resolved = code;
    if (code.startsWith('https://')) {
      const response = await fetch(code);
      if (!response.ok) {
        throw new Error(`Failed to fetch component code: ${response.status}`);
      }
      resolved = await response.text();
    }

    // 1. Strip metadata markers (__GGUI_META__ / __GGUI_STREAM_SPEC__).
    const cleaned = stripMarkers(resolved);
    // 2. Hoist imports above var declarations.
    const hoisted = hoistImports(cleaned);
    // 3. Rewrite bare specifiers to data-url shims reading from
    //    `globalThis.__ggui__`. The __ggui__ registry is installed
    //    by `runtime.ts::bootSequence` BEFORE any mountReactRoot call
    //    — see globals.ts docstring on TOCTOU ordering.
    const rewritten = rewriteImports(hoisted, {
      mode: 'data-url',
      gadgetPackages: currentOpts.gadgetPackages,
    });
    // 4. Dynamically import the module.
    const mod = await loadModule(rewritten);
    // 5. Extract default export (or first function export).
    const Comp = (mod.default ??
      Object.values(mod).find(
        (v): v is ComponentType => typeof v === 'function',
      )) as ComponentType<Record<string, unknown>> | undefined;
    if (Comp === undefined) {
      throw new Error('Module does not export a default component');
    }
    return Comp;
  }

  function renderTree(opts: ReactRootMountOptions): void {
    const themeCss = opts.themeId
      ? getScopedThemeCss(opts.themeId, scopeClass, opts.themeMode)
      : getScopedCssTokens(scopeClass, opts.themeMode);

    // Also inject theme CSS at `:root` on `document.head`. The scoped
    // injection above isolates token resolution to the React tree, but
    // the embedding shell's body styles (font-family, color, background)
    // resolve against `:root` — without this, body chrome falls back to
    // the inline-style defaults (-apple-system, etc.) even when the
    // tree itself paints correctly. Idempotent — last mount wins on
    // repeat calls. Same shared id as `@ggui-ai/design/themes`'
    // `ThemeProvider` so a Studio/Portal context with both runtime + RP
    // active doesn't double-stack.
    if (typeof document !== 'undefined') {
      const rootCss = opts.themeId
        ? getThemeCss(opts.themeId, opts.themeMode)
        : getCssTokens(opts.themeMode);
      const styleId = 'ggui-theme-vars';
      let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        document.head.appendChild(styleEl);
      }
      if (styleEl.textContent !== rootCss) {
        styleEl.textContent = rootCss;
      }
    }

    const componentElement =
      currentComponent === null
        ? null
        : createElement(currentComponent, opts.render.props ?? {});

    const wrapped =
      opts.renderWrapper && componentElement !== null
        ? opts.renderWrapper(componentElement)
        : componentElement;

    // The scope `<div>` + inline `<style>` + error-boundary-wrapped
    // children match RCR L376–383. `key={currentCode?.length}` mirrors
    // RCR's "reset boundary when code changes" heuristic.
    root.render(
      createElement(
        'div',
        { className: scopeClass },
        createElement('style', null, `${themeCss}${opts.cssOverrides ?? ''}`),
        createElement(
          RcrErrorBoundary,
          {
            key: currentCode?.length ?? 0,
            ...(opts.onError ? { onError: opts.onError } : {}),
            ...(opts.onRequestRepair ? { onRequestRepair: opts.onRequestRepair } : {}),
          },
          createElement(Fragment, null, wrapped),
        ),
      ),
    );
  }

  async function initialEvaluate(): Promise<void> {
    const code = currentOpts.render.componentCode ?? '';
    if (code.trim().length === 0) {
      currentComponent = null;
      currentCode = null;
      renderTree(currentOpts);
      return;
    }
    try {
      currentComponent = await evaluate(code);
      currentCode = code;
      renderTree(currentOpts);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      // Fail-loud on eval errors. The OPTIONAL `onError` callback is
      // not enough on its own — bootSelfContained doesn't wire one,
      // so without this log a self-contained mount with a broken
      // component renders a blank iframe and emits nothing.
      // eslint-disable-next-line no-console -- operator-visible failure signal
      console.error('[ggui] mountReactRoot: component evaluation failed —', e);
      currentComponent = null;
      currentCode = null;
      renderTree(currentOpts);
      currentOpts.onError?.(e);
    }
  }

  await initialEvaluate();

  return {
    get currentCode() {
      return currentCode;
    },
    async update(next) {
      const prevCode = currentCode;
      currentOpts = next;
      const nextCode = next.render.componentCode ?? '';

      // Props-only change — skip module eval. Re-render with new props.
      if (nextCode === prevCode && currentComponent !== null) {
        renderTree(currentOpts);
        return;
      }

      if (nextCode.trim().length === 0) {
        currentComponent = null;
        currentCode = null;
        renderTree(currentOpts);
        return;
      }

      try {
        currentComponent = await evaluate(nextCode);
        currentCode = nextCode;
        renderTree(currentOpts);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        currentComponent = null;
        currentCode = null;
        renderTree(currentOpts);
        next.onError?.(e);
      }
    },
    unmount() {
      root.unmount();
      container.replaceChildren();
    },
  };
}

// Re-export React so downstream renderer modules can import it via
// the same module specifier as the mount consumer without a separate
// `react` import (keeps the dependency graph flat inside the renderer
// package).
export { React };
