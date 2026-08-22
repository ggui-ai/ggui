/**
 * React component renderer for the iframe runtime.
 *
 * Port of `@ggui-ai/mcp-apps-react::components/ReactComponentRenderer.tsx` (L10-384)
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
 * On terminal error, `onError` fires and the boundary paints the
 * terminal error UI.
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
  assembleDeliveredThemeCss,
  getThemeCss,
  getCssTokens,
} from '@ggui-ai/design/rendering';
import {
  hoistImports,
  loadModule,
  loadModuleInline,
  probeUrlModuleLoad,
} from '@ggui-ai/design/module-loader';

/**
 * Document-lifetime verdict: URL-scheme module loading (`blob:` main
 * module + `data:` import shims) is blocked by the host CSP. Set only
 * when the inline path succeeded where the URL path failed AND the
 * known-good `probeUrlModuleLoad()` module ALSO fails — an arbitrary
 * module's failure is not CSP evidence (an import-shim allowlist miss
 * rejects blob-instantiation of that one module while URL loading is
 * healthy, and latching on it would force every later evaluation in
 * the document onto the inline path's narrower semantics).
 */
let urlModuleLoadBlocked = false;

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

/**
 * Join a custom-property record into CSS declarations. Values were
 * validated injection-safe upstream (appTheme: write-side
 * `appThemeSchema` + the wire parser; hostPalette: the host-palette
 * bridge's sanitizer), so the string-join is safe — do NOT
 * re-sanitize here.
 */
function toCssDecls(vars: Readonly<Record<string, string>>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join('');
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
}

interface ErrorBoundaryState {
  readonly error: Error | null;
  readonly catchCount: number;
  readonly autoRetrying: boolean;
}

class RcrErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
    catchCount: 0,
    autoRetrying: false,
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
  }

  componentWillUnmount(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
  }

  render(): ReactNode {
    const { error, autoRetrying } = this.state;
    if (error === null) return this.props.children;

    // The two fallback UIs match the host-SDK error boundary
    // verbatim (same inline styles so operator-visible DOM is
    // identical between the host-SDK and iframe-renderer paths).
    // Colors inherit the themed body (`--ggui-color-onSurface`) with
    // opacity for hierarchy — hardcoded white-alpha text was
    // illegible on light shells (#481); the boundary must stay
    // readable on WHATEVER background the theme painted, including
    // when theme CSS itself failed to inject (browser-default white).
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
            color: 'var(--ggui-color-onSurface, inherit)',
            opacity: 0.6,
          },
        },
        createElement('div', {
          style: {
            width: 16,
            height: 16,
            border: '2px solid rgba(128,128,128,0.25)',
            borderTopColor: 'currentColor',
            borderRadius: '50%',
            animation: 'ggui-err-spin 0.6s linear infinite',
          },
        }),
        'Retrying...',
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
          color: 'var(--ggui-color-onSurface, inherit)',
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
            color: '#ef4444',
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
        { style: { fontSize: 14, fontWeight: 600, opacity: 0.9 } },
        'Something went wrong',
      ),
      createElement(
        'div',
        { style: { fontSize: 12, opacity: 0.6, maxWidth: 280, lineHeight: 1.4 } },
        'This component encountered an error. Try asking for a different view.',
      ),
      createElement(
        'button',
        {
          onClick: () => this.setState({ error: null, catchCount: 0 }),
          style: {
            marginTop: 4,
            padding: '8px 20px',
            borderRadius: 8,
            border: '1px solid currentColor',
            background: 'transparent',
            color: 'inherit',
            opacity: 0.75,
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          },
        },
        'Retry',
      ),
      // Diagnostic is ALWAYS reachable (#481 ruling: errors must be
      // visible) — collapsed by default, legible when opened.
      createElement(
        'details',
        {
          style: {
            marginTop: 8,
            maxWidth: 320,
            width: '100%',
            textAlign: 'left',
            opacity: 0.65,
          },
        },
        createElement(
          'summary',
          { style: { fontSize: 11, cursor: 'pointer' } },
          'Error details',
        ),
        createElement(
          'pre',
          {
            style: {
              fontSize: 11,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              margin: '6px 0 0',
              maxHeight: 140,
              overflow: 'auto',
            },
          },
          error.message,
        ),
      ),
    );
  }
}

// =============================================================================
// Public mount API
// =============================================================================

export interface ReactRootMountOptions {
  /**
   * GguiSession whose componentCode + props drive the mount. Only
   * `componentCode` + `props` are read here; the caller is
   * responsible for wrapping this with a `<GguiWireProvider>` at the
   * higher-level dispatcher (see `render-item.ts`).
   */
  readonly render: {
    readonly id?: string;
    readonly componentCode: string;
    readonly props?: Record<string, unknown>;
    /**
     * Strict-CSP module variant of `componentCode` (ggui#522 slice 2):
     * a server-side import-rewritten twin of the SAME bytes, directly
     * `import()`able (its imports resolve to static shim assets on an
     * allowed origin — no `data:`, no `blob:`, no eval). Tried FIRST;
     * any failure falls through to the blob/inline ladder on the raw
     * bytes. Callers MUST pass it only when it names exactly these
     * `componentCode` bytes — a stale variant would paint the WRONG
     * component, not fail (the runtime's dispatcher guards this by
     * attaching it to the inline seed only).
     */
    readonly codeModuleUrl?: string;
  };
  readonly themeId?: string;
  /**
   * Theme color mode resolved for this mount. Forwards to
   * `getScopedThemeCss` / `getThemeCss` so the dark variant of the
   * registered theme paints when the operator selected it.
   */
  readonly themeMode?: 'light' | 'dark';
  /**
   * Per-app theme overlay — a partial set of `--ggui-*` values; unset
   * vars keep their token defaults. Merged INTO the scoped in-body
   * token block after the base block (and after `hostPalette`), which
   * is the only placement that can recolor tree content: a `:root`-only
   * append is cascade-dead for components — the scoped block sits later
   * in document order and re-specifies every token (browser-verified,
   * see the scoped-merge comment in `renderTree`). The `:root` append
   * still happens, but for body chrome only. A structural subset of
   * protocol's `AppTheme` (`name` is display-only, not needed at
   * render). `mode` drives `color-scheme` so native controls /
   * scrollbars / canvas pick up dark vs light.
   *
   * Precedence (ggui#573 ruling): base tokens < `hostPalette` <
   * `appTheme` < `cssOverrides` — the slice's stamped theme always
   * wins; the host palette is the fallback layer beneath it.
   */
  readonly appTheme?: {
    readonly mode: 'light' | 'dark';
    readonly cssVariables: Record<string, string>;
    /**
     * The REGISTERED base ladder, delivered over the wire (ggui#598-C
     * runtime theme registration — see protocol's `appThemeSchema`).
     * BOTH modes' resolved variable sets ride the envelope; when
     * present, the mode-selected set REPLACES the compiled ladder
     * block (`getScopedThemeCss`/`getScopedCssTokens`) at the base
     * position of the #573 precedence above — delivery changes WHERE
     * the ladder's bytes come from, never WHICH layer wins. Mode
     * selection reuses the mount's already-resolved `themeMode` (one
     * projection — no second mode resolution here), and a mode switch
     * re-paints from the retained other set with no network activity.
     * Values are injection-safe by the wire schema — never
     * re-validated here; serialization is key-sorted for byte-stable
     * output. `documentHash` is the registration's identity (joins a
     * painted ladder to its registration record); the renderer
     * carries it but exposes no observability surface for it today.
     */
    readonly base?: {
      readonly documentHash: string;
      readonly light: Readonly<Record<string, string>>;
      readonly dark: Readonly<Record<string, string>>;
    };
  };
  /**
   * Host-announced palette, already translated onto `--ggui-*` tokens
   * (see `host-palette-bridge.ts` — the spec `--color-*` vocabulary
   * never reaches this layer). Merged into the scoped token block
   * after the base block and BEFORE `appTheme`, so it repaints only
   * the slots no operator theme re-specifies (ggui#572; precedence
   * per the ggui#573 ruling above). Values are sanitized by the
   * bridge before they get here — host input never reaches this
   * string-join raw.
   */
  readonly hostPalette?: Readonly<Record<string, string>>;
  readonly cssOverrides?: string;
  readonly onError?: (error: Error) => void;
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
    // 2. Hoist imports above var declarations. Load-bearing for BOTH
    //    execution paths: the inline transform places its bindings at
    //    the import statement's position, so a pre-import statement
    //    referencing an imported name needs the hoist exactly as the
    //    real module semantics do.
    const hoisted = hoistImports(cleaned);

    const pick = (mod: Record<string, unknown>): ComponentType<Record<string, unknown>> => {
      const Comp = (mod.default ??
        Object.values(mod).find(
          (v): v is ComponentType => typeof v === 'function',
        )) as ComponentType<Record<string, unknown>> | undefined;
      if (Comp === undefined) {
        throw new Error('Module does not export a default component');
      }
      return Comp;
    };

    const evaluateInline = (): ComponentType<Record<string, unknown>> =>
      pick(
        loadModuleInline(hoisted, {
          ...(currentOpts.gadgetPackages !== undefined
            ? { gadgetPackages: currentOpts.gadgetPackages }
            : {}),
        }),
      );

    // Asset-module path (ggui#522 slice 2) — FIRST when the mount
    // carries the strict-CSP variant URL: a plain https module import,
    // legal under `script-src` origins alone, no scheme sources, no
    // eval. Under a strict host CSP it is the ONLY path that works;
    // under a permissive one it costs a CDN round-trip on cold cache
    // and nothing on warm (the URL is immutable). Any failure — CSP
    // block, network fault, a 404 from a redeployed variant family —
    // falls through to the raw-bytes ladder below. No document latch
    // on failure: unlike the per-evaluation blob probe, this branch
    // runs only when componentCode changes (rare — usually once per
    // mount), so the retry cost is one fetch, and the failure classes
    // (transient network vs permanent CSP) are indistinguishable in
    // the import error anyway.
    const moduleUrl = currentOpts.render.codeModuleUrl;
    if (moduleUrl !== undefined) {
      try {
        const mod = (await import(
          /* webpackIgnore: true */ /* @vite-ignore */ moduleUrl
        )) as Record<string, unknown>;
        return pick(mod);
      } catch {
        // Fall through — the raw bytes are the authoritative carrier.
      }
    }

    // Once URL-scheme module loading has been proven blocked in this
    // document, go straight to inline execution — the CSP verdict
    // cannot change within the document's lifetime.
    if (urlModuleLoadBlocked) {
      return evaluateInline();
    }

    try {
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
      return pick(mod);
    } catch (urlError) {
      // A host CSP granting only 'unsafe-inline' rejects the blob:/
      // data: imports above. Attempt the inline classic-script path;
      // a buggy component fails on both paths, and the original error
      // is the honest one to surface.
      try {
        const Comp = evaluateInline();
        // Latch the inline path for the rest of the document ONLY on
        // proven CSP evidence: the known-good probe module must also
        // fail. A module-specific blob failure (import-shim allowlist
        // drift) leaves the latch off so the next evaluation gets real
        // module semantics again.
        if (!(await probeUrlModuleLoad())) {
          urlModuleLoadBlocked = true;
        }
        return Comp;
      } catch {
        throw urlError;
      }
    }
  }

  function renderTree(opts: ReactRootMountOptions): void {
    // Delivered base ladder (ggui#598-C): when the slice theme carries
    // `base`, the mode-selected set REPLACES the compiled ladder block
    // at the base position — same precedence slot, different byte
    // source. Mode selection reuses the already-resolved `themeMode`
    // (one projection; absent means light — the same default
    // `getScopedThemeCss` applies). Both sets stay retained on the
    // options, so a mode-switch re-render picks the other ladder from
    // memory — never the network.
    const deliveredBase = opts.appTheme?.base;
    let themeCss =
      deliveredBase !== undefined
        ? // Design-package assembler (ggui#598-C, injection-review flag 1):
          // the delivered ladder gets the SAME scaffolding the compiled
          // ladder gets — base inherits, derived gradient/effect tokens
          // (color-mix fallback split), box-sizing, font-inherit — from
          // ONE shared builder, so the two paths cannot drift.
          assembleDeliveredThemeCss(
            scopeClass,
            opts.themeMode === 'dark' ? deliveredBase.dark : deliveredBase.light,
          )
        : opts.themeId
          ? getScopedThemeCss(opts.themeId, scopeClass, opts.themeMode)
          : getScopedCssTokens(scopeClass, opts.themeMode);
    if (opts.hostPalette) {
      // Host palette = the fallback layer (ggui#572, #573 ruling):
      // after the base scoped block so it can repaint at all (the base
      // re-specifies every token), BEFORE the appTheme overlay so the
      // slice's stamped theme wins by document order. Keys + values
      // arrive pre-sanitized from the host-palette bridge.
      themeCss += `.${scopeClass}{${toCssDecls(opts.hostPalette)}}`;
    }
    if (opts.appTheme) {
      const decls = toCssDecls(opts.appTheme.cssVariables);
      // The overlay must be merged HERE, into the scoped style that
      // mounts INSIDE the scope div — the `:root` append below is
      // cascade-dead for tree content: the in-scope block sits later
      // in document order than anything in `<head>`, so at equal
      // specificity the base scoped tokens always win over a head-level
      // override (browser-verified in rnd/gen-ui/beauty/experiments/001,
      // the probe sequence that found this). Appended AFTER the base
      // block + host palette and BEFORE `cssOverrides`, so: base <
      // host palette < operator overlay < explicit overrides
      // (ggui#573: slice wins, host fallback). Values validated
      // injection-safe upstream (same guarantee the `:root` append
      // cites).
      themeCss += `.${scopeClass}{${decls}}`;
    }

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
      let rootCss = opts.themeId
        ? getThemeCss(opts.themeId, opts.themeMode)
        : getCssTokens(opts.themeMode);
      if (opts.hostPalette) {
        // BODY-CHROME ONLY, same as the appTheme `:root` append below —
        // and beneath it, mirroring the scoped-block order (#573:
        // slice wins, host fallback). Keeps the embedding shell's
        // body font/color/background coherent with the tree.
        rootCss += `:root{${toCssDecls(opts.hostPalette)}}`;
      }
      if (opts.appTheme) {
        const decls = toCssDecls(opts.appTheme.cssVariables);
        // BODY-CHROME ONLY. This `:root` append themes the embedding
        // shell's body styles (font/color/background outside the scope
        // div). It does NOT reach tree content — the scoped in-body
        // token block wins by document order (see the scoped merge in
        // `renderTree`, and rnd/gen-ui/beauty/experiments/001 for the
        // probe that falsified the old "inherits into the tree" claim).
        // Values were validated injection-safe upstream (write-side
        // `appThemeSchema` + the wire parser re-validates), so the
        // string-join here is safe — do NOT re-sanitize.
        rootCss += `:root{color-scheme:${opts.appTheme.mode};${decls}}`;
      }
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
      // not enough on its own — not every mount path wires one, so
      // without this log a mount with a broken component renders a
      // blank iframe and emits nothing.
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
