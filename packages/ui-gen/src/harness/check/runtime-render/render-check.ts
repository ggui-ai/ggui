// packages/ui-gen/src/harness/check/runtime-render/render-check.ts
//
// Runtime render verification for compiled components.
//
// Pipeline:
//   1. Spin up happy-dom globals (window/document/etc.)
//   2. Eval compiled component → React component reference
//   3. Render it inside <GguiWireProvider config={probeWireConfig}>
//   4. Run 5 checks against probe + DOM
//   5. Tear down DOM
//
// Block (fail outcome): render-no-throw, action-wiring, wiredTool-wiring,
//                       clientTool-registration
// Warn outcome:         prop-coverage, stream-rerender
//
// All checks are best-effort: if a heuristic can't find an element, the
// check fails with a descriptive reason rather than throwing.

import type {
  DataContract,
  JsonObject,
  PropsSpec,
} from "@ggui-ai/protocol";
import { HOOK_NAME_RE, listContractGadgets } from "@ggui-ai/protocol";
import { createProbe, createProbeWireConfig, type Probe } from "./probe.js";
import { loadComponent } from "./load-component.js";
import { findWiring, type WiringDetection } from "./find-wiring.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal DOM types — declared locally so this module doesn't depend on the
// DOM lib (some downstream packages, e.g. cloud/amplify, exclude DOM from
// their tsconfig).
// ─────────────────────────────────────────────────────────────────────────────

interface MinimalElement {
  readonly tagName: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  querySelectorAll<T extends MinimalElement = MinimalElement>(selector: string): Iterable<T>;
}

/**
 * Module-namespace-shaped value injected into `loadComponent`'s
 * `moduleResolutions`. Structurally equivalent to
 * `@ggui-ai/iframe-runtime`'s `ModuleNamespace` (open record of
 * string keys → unknown) — declared locally so this module doesn't
 * take a dependency on the iframe-runtime package just for a type.
 */
type ProbeModuleNamespace = {
  readonly [key: string]: unknown;
};

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 3-state outcome. Internal to runtime-render.
 * The adapter maps this to existing EvalIssue shapes:
 *   verified   → no issue
 *   failed     → fail
 *   unverified → warn
 *   skipped    → no issue
 */
export type CheckOutcome = "verified" | "failed" | "unverified" | "skipped";

export interface RenderCheckIssue {
  readonly check:
    | "render-no-throw"
    | "action-wiring"
    | "wiredTool-wiring"
    | "clientTool-registration"
    | "prop-coverage"
    | "stream-rerender";
  readonly outcome: CheckOutcome;
  readonly subject?: string;
  readonly reason: string;
  /** Optional element description ("button[aria-label='Save']") for action-wiring failures. */
  readonly elementHint?: string;
  /**
   * Diagnostic context from probe + AST analysis. Populated for richer feedback
   * to the coding agent (which native props the callback flows into, what the
   * probe observed firing, etc.).
   */
  readonly diagnostics?: {
    readonly observedJsxElements?: readonly string[];
    readonly observedNativeProps?: readonly string[];
    readonly observedCustomProps?: readonly string[];
    /** For action-wiring: which actions DID fire from probe clicks (helps surface mis-wiring). */
    readonly actionsFiredFromClicks?: readonly string[];
    /** Resolved MCP tool name from `contract.actionSpec[name].dispatch.tool`
     *  when `dispatch.kind === 'tool'`, undefined otherwise. */
    readonly resolvedTool?: string;
    /** Surfaced to the agent: prop sourceTool hints from the contract (only if present). */
    readonly sourceToolHints?: Readonly<Record<string, string>>;
  };
}

export interface RenderCheckResult {
  readonly ok: boolean;
  readonly issues: readonly RenderCheckIssue[];
  readonly stats: {
    readonly actionsChecked: number;
    readonly wiredToolsChecked: number;
    readonly clientToolsChecked: number;
    readonly streamsChecked: number;
    readonly renderMs: number;
  };
}

export interface RunRenderCheckInput {
  readonly sourceCode: string;
  readonly mockupProps: JsonObject;
  readonly contract?: DataContract;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────────────

export async function runRenderCheck(
  input: RunRenderCheckInput,
): Promise<RenderCheckResult> {
  const t0 = Date.now();
  const issues: RenderCheckIssue[] = [];

  // ── Stand up happy-dom ────────────────────────────────────────────────
  const teardown = await setupHappyDom();
  // Probe-spy uninstaller — set when the postMessage spy is installed
  // (after probe + happy-dom are both ready). Cleared in the outer
  // finally so early-return paths from probe-pre or probe-post don't
  // leak the spy into the next runRenderCheck invocation.
  let uninstallSpy: (() => void) | undefined;
  // Gadget stub-registry uninstaller — `globalThis.__ggui__` is a
  // process global, so it MUST be torn down in the outer finally.
  let uninstallGadgetRegistry: (() => void) | undefined;

  try {
    // ── Pre-resolve modules ONCE so the sandbox + test share one realm ──
    // (React contexts + dispatchers are per-instance — passing the same
    // instances into the sandbox is what makes useContext lookups work.)
    // The @ggui-ai/design package is ESM-only — must use dynamic import
    // (createRequire's CJS require fails on ESM-only packages).
    const React = await import("react");
    const ReactJsxRuntime = await import("react/jsx-runtime");
    const Wire = await import("@ggui-ai/wire");
    const { GguiWireProvider } = Wire;

    const moduleResolutions: Record<string, unknown> = {
      "react": React,
      "react/jsx-runtime": ReactJsxRuntime,
      "@ggui-ai/wire": Wire,
    };

    // Pre-load the @ggui-ai/design specifiers the boilerplate may import.
    // Post-D1, generated code imports the single bare `@ggui-ai/design`
    // barrel — that MUST be pre-resolved here: the package is ESM-only
    // with no `require` export condition, so `loadComponent`'s
    // `createRequire` fallback cannot load it (it would crash:fail the
    // render check). The subpaths stay for any legacy/first-party code.
    // Per-specifier failures are swallowed — the sandbox throws its own
    // clear error if the component actually needs a missing one.
    const designSpecifiers = [
      "@ggui-ai/design",
      "@ggui-ai/design/primitives",
      "@ggui-ai/design/components",
      "@ggui-ai/design/compositions",
      "@ggui-ai/design/interact",
    ];
    for (const id of designSpecifiers) {
      try {
        moduleResolutions[id] = await import(id);
      } catch {
        /* skip — sandbox will report a clear error if the component imports it */
      }
    }

    // Pre-load `@ggui-ai/gadgets` for components that declare
    // `clientCapabilities.gadgets`. The standard-library hooks
    // (useGeolocation, useCamera, …) live in this package; without it
    // pre-resolved here, the sandbox falls back to `require()` which
    // fails when the caller package doesn't have `@ggui-ai/gadgets` as
    // a direct dep. Swallow on miss —
    // same posture as design subpaths above.
    try {
      moduleResolutions["@ggui-ai/gadgets"] = await import(
        "@ggui-ai/gadgets"
      );
    } catch {
      /* skip — sandbox will report a clear error if the component imports it */
    }

    // Install a stub per-package `globalThis.__ggui__.gadgets`
    // registry so direct gadget imports resolve at component-render
    // time. Without it, every gadget-bearing component false-fails
    // `render-no-throw`. `loadGadgets()` is retired —
    // component code direct-imports each gadget export.
    uninstallGadgetRegistry = installGadgetStubRegistry(input.contract);

    // Register a CJS shim module for each third-party gadget package
    // the contract declares. The probe re-compiles the
    // component to CJS, so a direct `import { useLeafletMap } from
    // '@ggui-samples/gadget-leaflet'` becomes `require('@ggui-samples/
    // gadget-leaflet')`. The wrapper package itself is not installed
    // in the probe's node_modules — without a shim, `loadComponent`'s
    // sandboxRequire throws "Import not allowed". Each shim is a
    // module namespace whose hook exports read the stub registry's
    // per-package slot LAZILY at call time (the slot is populated by
    // `installGadgetStubRegistry` above). `@ggui-ai/gadgets` (STDLIB)
    // is excluded — its real hooks are pre-loaded above and run
    // standalone (they don't read the registry).
    for (const pkg of collectThirdPartyGadgetPackages(input.contract)) {
      if (pkg in moduleResolutions) continue;
      moduleResolutions[pkg] = buildGadgetPackageProbeShim(pkg);
    }

    // ── Eval compiled component ─────────────────────────────────────────
    let Component: Awaited<ReturnType<typeof loadComponent>>["Component"];
    try {
      const loaded = await loadComponent({
        sourceCode: input.sourceCode,
        moduleResolutions,
      });
      Component = loaded.Component;
    } catch (e) {
      issues.push({
        check: "render-no-throw",
        outcome: "failed",
        reason: `Failed to load component: ${e instanceof Error ? e.message : String(e)}`,
      });
      return finalize(issues, t0, 0, 0, 0, 0);
    }

    // ── Build probe + wire config ───────────────────────────────────────
    const probe = createProbe();
    const wireConfig = createProbeWireConfig(probe);

    // Install the postMessage spy AFTER happy-dom is up so window.parent
    // exists. The spy observes envelopes emitted by the iframe-runtime
    // interceptors (anchor → ui/open-link, requestFullscreen →
    // ui/request-display-mode, Pattern α direct tool fires → tools/call).
    // WireConfig-layer events (dispatch, callWiredTool) continue to flow
    // through the closure-shared probe internals.
    uninstallSpy = probe.installPostMessageSpy();

    const { render, cleanup } = await import("@testing-library/react");
    // user-event v14 default export — see https://testing-library.com/docs/user-event/intro/
    const userEventModule = await import("@testing-library/user-event");
    const userEvent = userEventModule.default ?? userEventModule;

    // ── Install console.error spy to break infinite render loops ─────────
    // React logs "Maximum update depth exceeded" when setState-in-effect
    // loops (>~25-50 re-renders). Without a break, happy-dom keeps looping
    // until something else stops the process. We hook console.error and
    // throw from within the spy so the render() call's catch-block runs.
    //
    // This catches the dominant hang class (useEffect-dep loop) upstream
    // of the probe wall-clock guard. Also catches "Too many re-renders"
    // (React's alternate message) and "Each child in a list" (not a
    // hang, but a clear generation bug) — any of these classify as a
    // runtime-loop failure instead of a 12-minute CPU spin.
    const originalConsoleError = console.error;
    let loopSignature: string | null = null;
    // Capture React's component-stack frames when a render error occurs.
    // React 19 logs them via console.error in the form:
    //   "%s\n\nThe above error occurred in the <%s> component:\n%s\n..."
    // The 4th argument is the component-stack string ("    at SurveyForm
    // (...) \n    at FormProvider (...) \n..."). We capture it so the
    // probe's "Render threw" diagnostic can name the offending component.
    let capturedComponentStack: string | null = null;
    const loopPatterns: ReadonlyArray<readonly [RegExp, string]> = [
      [/Maximum update depth exceeded/i, "max-update-depth"],
      [/Too many re-renders/i, "too-many-renders"],
      [/Rendered more hooks than during the previous render/i, "hook-count-drift"],
    ];
    console.error = (...args: unknown[]) => {
      const text = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
      // Capture component-stack FIRST (independent of throw decision).
      // Loop-class messages from React 18/19 often include the component
      // stack as a separate arg even on the same call ("Maximum update
      // depth exceeded\n    at Component (...)"). If we throw before
      // capture, the loop-class diagnostic is left without component
      // localization (the dominant pre-fix gap).
      if (!capturedComponentStack) {
        // Try to find any arg that looks like a "    at X (...)" stack.
        for (const arg of args) {
          if (
            typeof arg === "string" &&
            /^\s*at\s+\S/m.test(arg) &&
            arg.length > 20
          ) {
            capturedComponentStack = arg;
            break;
          }
        }
        // Fallback: extract embedded "    at" lines from the joined text.
        if (!capturedComponentStack) {
          const stackMatch = text.match(/(?:^|\n)((?:\s*at\s+\S[^\n]*\n?){2,})/);
          if (stackMatch) {
            capturedComponentStack = stackMatch[1].trim();
          }
        }
      }
      for (const [pattern, tag] of loopPatterns) {
        if (pattern.test(text)) {
          loopSignature = tag;
          // Throw synchronously — React's render stack unwinds, our
          // try/catch below catches the error, we classify cleanly.
          throw new Error(`[runtime-render] infinite render loop detected (${tag})`);
        }
      }
      // Forward non-matching errors to real console so they're visible.
      originalConsoleError.apply(console, args);
    };

    // Error boundary fallback for React's componentStack on synchronous
    // throws (e.g. "Too many re-renders"). React 19 throws this directly
    // without going through console.error, so the spy never sees it.
    // The boundary's getDerivedStateFromError + componentDidCatch fire
    // for every render error, sync or async, and componentDidCatch's
    // errorInfo.componentStack is the canonical React-named-component
    // chain. Stored in a closure variable read in the catch block below.
    // Use object container so TS narrowing follows property access (not
    // closure flow analysis, which can't see the componentDidCatch
    // mutation and would narrow these to `null` at the use site).
    const boundaryRef: { stack: string | null; error: Error | null } = {
      stack: null,
      error: null,
    };
    class ProbeErrorBoundary extends React.Component<
      { children: React.ReactNode },
      { caught: boolean }
    > {
      state = { caught: false };
      static getDerivedStateFromError(): { caught: boolean } {
        return { caught: true };
      }
      componentDidCatch(error: Error, errorInfo: { componentStack?: string }): void {
        if (errorInfo.componentStack && !boundaryRef.stack) {
          boundaryRef.stack = errorInfo.componentStack;
        }
        if (!boundaryRef.error) {
          boundaryRef.error = error;
        }
      }
      render(): React.ReactNode {
        if (this.state.caught) return null;
        return this.props.children;
      }
    }

    let renderResult: Awaited<ReturnType<typeof render>>;
    const RENDER_TIMEOUT_MS = 5000;
    try {
      // Promise.race safety net for async hangs (effect flushes, timers).
      // Synchronous hangs would block the event loop and the timer never
      // fires, but happy-dom effects are mostly microtask-scheduled so the
      // timeout is actually effective for ~95% of the hang cases.
      const renderPromise = Promise.resolve().then(() =>
        render(
          React.createElement(GguiWireProvider, {
            config: wireConfig,
            children: React.createElement(ProbeErrorBoundary, {
              children: React.createElement(Component, input.mockupProps),
            }),
          }),
        ),
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`[runtime-render] render exceeded ${RENDER_TIMEOUT_MS}ms — classified as runtime-hang`)), RENDER_TIMEOUT_MS).unref?.();
      });
      renderResult = await Promise.race([renderPromise, timeoutPromise]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const errStack = e instanceof Error ? (e.stack ?? "") : "";
      const baseReason = loopSignature
        ? `Infinite render loop (${loopSignature}) — likely setState/dispatch inside useEffect with missing or unstable dependency`
        : /runtime-hang/.test(msg)
          ? `Render wall-clock exceeded ${RENDER_TIMEOUT_MS}ms — likely async effect loop or unresolved promise`
          : `Render threw: ${msg}`;
      // Localization context for the LLM. Two complementary signals:
      //   1. JS error.stack — top frames from the throw site. Filter to
      //      user-code lines (drop happy-dom / RTL / React internals)
      //      so the most relevant frame is on top. The bundled output is
      //      minified but esbuild keeps line numbers (`keepNames: true`),
      //      so frames usually pinpoint a region of the source the LLM
      //      can patch.
      //   2. React componentStack — captured via console.error spy when
      //      React logs "above error occurred in the X component". Names
      //      the failing component; on multi-component renders this is
      //      the difference between "find the bad iteration" and "look in
      //      <SurveyStep>". Cap to keep prompt budget bounded.
      const userFrames = errStack
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("at "))
        .filter((l) => !/(node_modules|happy-dom|@testing-library|react-dom|node:internal|node:async)/.test(l))
        .slice(0, 5);
      // Prefer the ErrorBoundary-captured stack (richer + names component
      // wrappers like memo/forwardRef), fall back to the spy-captured one.
      const stackSource = boundaryRef.stack ?? capturedComponentStack ?? "";
      const componentFrames = stackSource
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("at "))
        .slice(0, 4);
      const stackBlock = userFrames.length
        ? `\n  Stack (user frames): ${userFrames.join(" | ")}`
        : "";
      const componentBlock = componentFrames.length
        ? `\n  Component stack: ${componentFrames.join(" > ")}`
        : "";
      const loopReason = `${baseReason}${stackBlock}${componentBlock}`;
      issues.push({
        check: "render-no-throw",
        outcome: "failed",
        reason: loopReason,
      });
      console.error = originalConsoleError;
      return finalize(issues, t0, 0, 0, 0, 0);
    }
    console.error = originalConsoleError;

    // ErrorBoundary caught a crash even though render() didn't throw.
    // This happens when the synchronous error happens during the commit
    // phase of a child component — the boundary swallows it and renders
    // null, but the page is still broken. Treat as render-no-throw fail.
    if (boundaryRef.stack || boundaryRef.error) {
      const componentFrames = (boundaryRef.stack ?? "")
        .split("\n")
        .map((l: string) => l.trim())
        .filter((l: string) => l.startsWith("at "))
        .slice(0, 4);
      const compBlock = componentFrames.length
        ? `\n  Component stack: ${componentFrames.join(" > ")}`
        : "";
      const errMsg = boundaryRef.error
        ? boundaryRef.error.message
        : "(no error message)";
      issues.push({
        check: "render-no-throw",
        outcome: "failed",
        reason: `Render threw: ${errMsg}${compBlock}`,
      });
      cleanup();
      return finalize(issues, t0, 0, 0, 0, 0);
    }

    // RTL types `container` as HTMLElement; we use a structural MinimalElement
    // to keep this module DOM-lib-free (some downstream tsconfigs exclude DOM).
    const container = renderResult.container as unknown as MinimalElement;
    const userEventModuleAny = userEvent as unknown as { setup?: () => { click: (el: unknown) => Promise<void> }; click?: (el: unknown) => Promise<void> };
    const userInstance = userEventModuleAny.setup
      ? userEventModuleAny.setup()
      : (userEventModuleAny as { click: (el: unknown) => Promise<void> });
    const user: { click: (el: MinimalElement) => Promise<void> } = {
      click: (el: MinimalElement) => userInstance.click(el as unknown),
    };

    let actionsChecked = 0;
    // `wiredToolsChecked` / `clientToolsChecked` are retired — the
    // `wiredTool-wiring` check is gone and clientCapabilities use a
    // different verification path. Kept as 0 in the finalize signature
    // to preserve the report shape.
    const wiredToolsChecked = 0;
    const clientToolsChecked = 0;
    let streamsChecked = 0;

    try {
      // ── Check 2: Action wiring (BLOCK / unverified-as-warn) ───────────
      if (input.contract?.actionSpec) {
        const actionSpec = input.contract.actionSpec;
        for (const [name, entry] of Object.entries(actionSpec)) {
          actionsChecked++;
          const wiring = findWiring({
            sourceCode: input.sourceCode,
            hookName: "useAction",
            hookArg: name,
          });
          const resolvedTool = entry.nextStep;
          const issue = await checkActionWiring({
            container,
            actionName: name,
            actionLabel: entry.label,
            wiring,
            resolvedTool,
            probe,
            user: user as { click: (el: MinimalElement) => Promise<void> },
          });
          if (issue) issues.push(issue);
        }
      }

      // ── Check 3: Agent-tool wiring — RETIRED ──────────────────────────
      // `useWiredTool` is retired. The contract's `agentTools` is a
      // catalog of tools the AGENT invokes — there is no component hook
      // surface. Cross-refs from actionSpec[*].nextStep /
      // streamSpec[*].source.tool ride through checks 2 (action wiring)
      // and 6 (stream re-render); the catalog itself has no
      // component-side requirement to verify here.

      // ── Check 4: Client-capability hook usage (WARN) ──────────────────
      // `clientTools` is retired. Capability hooks are imported from
      // `@ggui-ai/gadgets` (or vendor packages) and own their own
      // lifecycle — the runtime-render probe doesn't intercept them.
      // The tier-0 substring check in `run-tier0.ts` is the gate that
      // detects un-called capability bindings at gen time.

      // ── Check 5: Prop coverage (WARN) ─────────────────────────────────
      if (input.contract?.propsSpec) {
        for (const issue of checkPropCoverage({
          container,
          propsSpec: input.contract.propsSpec as PropsSpec,
          mockupProps: input.mockupProps,
        })) {
          issues.push(issue);
        }
      }

      // ── Check 6: Stream re-render (WARN) ──────────────────────────────
      if (input.contract?.streamSpec) {
        const streamSpec = input.contract.streamSpec;
        for (const [name] of Object.entries(streamSpec)) {
          streamsChecked++;
          const issue = await checkStreamRerender({
            container,
            eventName: name,
            probe,
            React,
          });
          if (issue) issues.push(issue);
        }
      }
    } finally {
      cleanup();
    }

    return finalize(issues, t0, actionsChecked, wiredToolsChecked, clientToolsChecked, streamsChecked);
  } finally {
    try { uninstallSpy?.(); } catch { /* ignore */ }
    try { uninstallGadgetRegistry?.(); } catch { /* ignore */ }
    teardown();
  }
}

/**
 * Install a stub `globalThis.__ggui__` gadget registry so direct
 * gadget imports resolve at component-render time.
 *
 * Generated component code direct-imports gadget exports — there is no
 * runtime `loadGadgets()` registry call. For example, `import { useGeolocation } from
 * '@ggui-ai/gadgets'`, `import { useLeafletMap } from
 * '@ggui-samples/gadget-leaflet'`. The renderer's import rewriter
 * substitutes each gadget package specifier with a per-package
 * data-URL shim (`buildGadgetPackageShim`) whose named exports read
 * `globalThis.__ggui__.gadgets[<package>][<export>]` lazily at
 * call/render time.
 *
 * The runtime-render probe does not boot an iframe runtime, so that
 * `__ggui__.gadgets` slot is absent — without this stub, every
 * gadget-bearing component false-fails `render-no-throw` with
 * "[gadget] export '…' is not loaded".
 *
 * The registry installed here is **per-package** (`GadgetPackageRegistry`):
 * `{ '<package>': { '<export>': fn, … }, … }`. The shim resolves
 * `gadgets[package][export]`, so a flat hook-name keying would miss.
 *
 * The probe cannot run a real third-party gadget (Leaflet, Mapbox) in
 * happy-dom, so each export the contract declares is stubbed by kind,
 * discriminated by the export-name grammar:
 *   - a HOOK export (`use`-prefixed) is stubbed with the uniform gadget
 *     result contract the boilerplate teaches — `{ status, value,
 *     start }`: `status` is a real string (safe as a React child and in
 *     comparisons), `value`'s fields are no-op functions (safe as
 *     callback refs + imperative calls like `panTo`), `start` is a no-op.
 *   - a COMPONENT export (PascalCase) is stubbed with a function
 *     component that renders nothing (`() => null`) — React invokes it
 *     when the host renders `<X … />`.
 * The probe thus verifies the COMPONENT's own render tree while
 * treating the gadget as a well-behaved black box.
 *
 * Returns an uninstaller; the caller MUST invoke it — `globalThis` is
 * a process global and a leaked slot taints the next check.
 */
export function installGadgetStubRegistry(
  contract: DataContract | undefined,
): () => void {
  const declared = contract?.clientCapabilities?.gadgets;
  if (!declared || Object.keys(declared).length === 0) {
    return () => {};
  }

  const noop = (): void => {};
  // A gadget `value` carries an imperative surface (`containerRef`
  // callback ref, `panTo`, `setView`, …) — every field resolves to a
  // no-op so refs attach and imperative calls stay safe.
  const valueStub = new Proxy(
    {},
    {
      get: (_t, key) =>
        key === "then" || typeof key === "symbol" ? undefined : noop,
    },
  );
  const result = { status: "idle", value: valueStub, start: noop };
  // Unknown top-level keys resolve to a no-op (covers `map.foo()`);
  // `then` + symbol keys pass through so `await` / coercion stay safe.
  const resultStub = new Proxy(result, {
    get: (t, key) => {
      if (key === "status" || key === "value" || key === "start") {
        return t[key];
      }
      return key === "then" || typeof key === "symbol" ? undefined : noop;
    },
  });

  // Per-package registry — `{ '<package>': { '<export>': fn } }`.
  // Mirrors the runtime `GadgetPackageRegistry` shape that
  // `buildGadgetPackageShim` reads (`gadgets[package][export]`).
  // Iterate the flattened `GadgetUse[]`; kind is discriminated
  // by the export-name grammar.
  const gadgets: Record<string, Record<string, unknown>> = {};
  for (const use of contract ? listContractGadgets(contract) : []) {
    const pkgSlot = (gadgets[use.package] ??= {});
    if (HOOK_NAME_RE.test(use.name)) {
      // Hook export — the component CALLS it; return the uniform
      // `{ status, value, start }` gadget result stub.
      pkgSlot[use.name] = () => resultStub;
    } else {
      // Component export (PascalCase) — React invokes it as a
      // function component. Render nothing: the gadget stays a
      // well-behaved black box while the host component's own render
      // tree is the thing under verification.
      pkgSlot[use.name] = () => null;
    }
  }

  const root = globalThis as { __ggui__?: unknown };
  const prior = root.__ggui__;
  root.__ggui__ = { gadgets, publicEnv: {} };
  return () => {
    if (prior === undefined) {
      delete root.__ggui__;
    } else {
      root.__ggui__ = prior;
    }
  };
}

/**
 * Collect the distinct third-party gadget package names a contract
 * declares. The STDLIB package `@ggui-ai/gadgets` is
 * EXCLUDED — its real hooks are pre-loaded into the probe sandbox and
 * run standalone (they implement browser APIs directly, not via the
 * `__ggui__.gadgets` registry). Only operator-registered wrapper
 * packages need a sandbox shim.
 */
function collectThirdPartyGadgetPackages(
  contract: DataContract | undefined,
): string[] {
  if (!contract) return [];
  const packages = new Set<string>();
  for (const use of listContractGadgets(contract)) {
    if (use.package !== "@ggui-ai/gadgets") packages.add(use.package);
  }
  return [...packages];
}

/**
 * Build a CJS module-namespace shim for one third-party gadget
 * package, for injection into `loadComponent`'s
 * `moduleResolutions`.
 *
 * The probe re-compiles the component to CJS, so a direct
 * `import { useX } from '<package>'` becomes `require('<package>')`
 * and pulls `module.exports.<X>`. This shim is a Proxy whose every
 * property is a lazy thunk forwarding to the stub registry's
 * per-package slot — `globalThis.__ggui__.gadgets[<package>][<export>]`
 * — at CALL time. Lazy resolution matches the runtime rewriter's
 * `buildGadgetPackageShim` read pattern and is robust to the registry
 * being installed after the shim is built.
 *
 * The probe cannot run a real third-party gadget in happy-dom; the
 * registry slot holds the stub `installGadgetStubRegistry` plants —
 * the uniform `{ status, value, start }` result for a hook export, or
 * a render-nothing component for a PascalCase component export — so the
 * host COMPONENT's own render tree is verified while the gadget stays a
 * well-behaved black box.
 */
function buildGadgetPackageProbeShim(packageName: string): ProbeModuleNamespace {
  const resolveExport = (name: string): unknown => {
    const root = globalThis as {
      __ggui__?: { gadgets?: Record<string, Record<string, unknown>> };
    };
    return root.__ggui__?.gadgets?.[packageName]?.[name];
  };
  // Lazy thunk — forwards to the registry slot at call/render time.
  // Covers both hooks (`useX()`) and gadget components (`<X />`, which
  // React invokes as a function).
  const makeThunk =
    (name: string) =>
    (...args: unknown[]): unknown => {
      const impl = resolveExport(name);
      if (typeof impl !== "function") {
        throw new Error(
          `[gadget] export '${name}' from '${packageName}' is not loaded in the render-check probe — the component imports it but the contract's clientCapabilities.gadgets never declared it, so installGadgetStubRegistry planted no stub.`,
        );
      }
      return (impl as (...a: unknown[]) => unknown)(...args);
    };
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        if (typeof key === "symbol" || key === "default" || key === "then") {
          return undefined;
        }
        return makeThunk(key);
      },
      // `key in ns` checks (esbuild interop may probe) report true so
      // the named import binds to the thunk rather than `undefined`.
      has: (_t, key) =>
        typeof key !== "symbol" && key !== "then" && key !== "default",
    },
  ) as ProbeModuleNamespace;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────────────

async function setupHappyDom(): Promise<() => void> {
  const g = globalThis as unknown as Record<string, unknown>;

  // ── Async-teardown safety ───────────────────────────────────────────────
  // Generated components may call setTimeout/setInterval for polling,
  // delayed renders, debouncing, etc. If a timer fires AFTER we delete
  // window/document, its callback's setState lookup will read
  // `window.event` (React dev path) and throw an unhandled exception
  // that crashes the whole process (observed: run3 of post-probe-guard).
  //
  // Mitigations:
  //   1. Wrap setTimeout/setInterval to track pending IDs; clear them all
  //      on teardown.
  //   2. Install a process-level uncaughtException/unhandledRejection
  //      handler during the probe's lifetime that swallows DOM-teardown-
  //      class errors and forwards anything else.
  const pendingTimeouts = new Set<NodeJS.Timeout>();
  const pendingIntervals = new Set<NodeJS.Timeout>();
  const origSetTimeout = globalThis.setTimeout;
  const origSetInterval = globalThis.setInterval;
  const origClearTimeout = globalThis.clearTimeout;
  const origClearInterval = globalThis.clearInterval;
  // @ts-expect-error — wrapping global timer typings for tracked variant
  globalThis.setTimeout = (...args: Parameters<typeof origSetTimeout>) => {
    const id = origSetTimeout(...args);
    pendingTimeouts.add(id);
    return id;
  };
  globalThis.setInterval = ((...args: Parameters<typeof origSetInterval>) => {
    const id = origSetInterval(...args);
    pendingIntervals.add(id);
    return id;
  }) as typeof globalThis.setInterval;
  globalThis.clearTimeout = (id?: string | number | NodeJS.Timeout) => {
    if (id !== undefined) pendingTimeouts.delete(id as NodeJS.Timeout);
    return origClearTimeout(id);
  };
  globalThis.clearInterval = (id?: string | number | NodeJS.Timeout) => {
    if (id !== undefined) pendingIntervals.delete(id as NodeJS.Timeout);
    return origClearInterval(id);
  };

  const isTeardownArtifact = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      /window is not defined/i.test(msg) ||
      /document is not defined/i.test(msg) ||
      /Cannot read propert(?:y|ies) of undefined \(reading 'event'\)/i.test(msg) ||
      /requestAnimationFrame is not defined/i.test(msg)
    );
  };
  const uncaughtHandler = (err: Error): void => {
    if (isTeardownArtifact(err)) {
      // Expected — a generated component's late timer fired after teardown.
      // Swallow silently; the probe already recorded its outcome.
      return;
    }
    // Not ours — re-throw on next tick so the default handler runs.
    process.nextTick(() => { throw err; });
  };
  const unhandledHandler = (reason: unknown): void => {
    if (isTeardownArtifact(reason)) return;
    const err = reason instanceof Error ? reason : new Error(String(reason));
    process.nextTick(() => { throw err; });
  };
  process.on("uncaughtException", uncaughtHandler);
  process.on("unhandledRejection", unhandledHandler);

  const cleanupAsyncInfra = (): void => {
    for (const id of pendingTimeouts) origClearTimeout(id);
    for (const id of pendingIntervals) origClearInterval(id);
    pendingTimeouts.clear();
    pendingIntervals.clear();
    globalThis.setTimeout = origSetTimeout;
    globalThis.setInterval = origSetInterval;
    globalThis.clearTimeout = origClearTimeout;
    globalThis.clearInterval = origClearInterval;
    // Keep uncaughtException/unhandledRejection handlers registered for a
    // brief grace period. React 19's concurrent scheduler can defer state
    // updates via microtasks / setImmediate — those flush AFTER the probe
    // returns, and if our handlers are gone they'll crash the process.
    // Observed on exp47-control-run2: `useWiredTool.call → dispatchSetState`
    // fired post-teardown, ReferenceError: window is not defined, full
    // process crash. 100ms is long enough for React's scheduler to drain
    // without meaningfully delaying the next cell's setup.
    origSetTimeout(() => {
      process.off("uncaughtException", uncaughtHandler);
      process.off("unhandledRejection", unhandledHandler);
    }, 100).unref?.();
  };

  // If window/document already exist (e.g., Vitest happy-dom environment), trust them.
  // Just toggle the React act flag and return a teardown that restores timer state.
  if ("window" in g && "document" in g) {
    const priorActFlag = g.IS_REACT_ACT_ENVIRONMENT;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    return () => {
      cleanupAsyncInfra();
      if (priorActFlag === undefined) delete g.IS_REACT_ACT_ENVIRONMENT;
      else g.IS_REACT_ACT_ENVIRONMENT = priorActFlag;
    };
  }

  const { Window } = await import("happy-dom");
  const window = new Window({ url: "https://render-check.local" });
  const windowAny = window as unknown as Record<string, unknown>;

  const keys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "Element",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ];
  const prior: Record<string, { value: unknown; existed: boolean }> = {};
  for (const k of keys) {
    prior[k] = { value: g[k], existed: k in g };
    try {
      // Use defineProperty to bypass any getter-only restrictions on the host.
      Object.defineProperty(g, k, {
        value: windowAny[k],
        writable: true,
        configurable: true,
      });
    } catch {
      // Skip globals we can't override (e.g., locked-down host runtimes).
    }
  }

  g.IS_REACT_ACT_ENVIRONMENT = true;

  return () => {
    cleanupAsyncInfra();
    for (const k of keys) {
      try {
        if (prior[k]!.existed) {
          Object.defineProperty(g, k, {
            value: prior[k]!.value,
            writable: true,
            configurable: true,
          });
        } else {
          delete g[k];
        }
      } catch {
        /* ignore */
      }
    }
    delete g.IS_REACT_ACT_ENVIRONMENT;
  };
}

function finalize(
  issues: RenderCheckIssue[],
  t0: number,
  actionsChecked: number,
  wiredToolsChecked: number,
  clientToolsChecked: number,
  streamsChecked: number,
): RenderCheckResult {
  const ok = !issues.some(i => i.outcome === "failed");
  return {
    ok,
    issues,
    stats: {
      actionsChecked,
      wiredToolsChecked,
      clientToolsChecked,
      streamsChecked,
      renderMs: Date.now() - t0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check implementations
// ─────────────────────────────────────────────────────────────────────────────

interface CheckActionInput {
  container: MinimalElement;
  actionName: string;
  actionLabel: string;
  wiring: WiringDetection;
  resolvedTool?: string;
  probe: Probe;
  user: { click: (el: MinimalElement) => Promise<void> };
}

async function checkActionWiring(input: CheckActionInput): Promise<RenderCheckIssue | null> {
  const { container, actionName, actionLabel, wiring, resolvedTool, probe, user } = input;

  const baseDiagnostics = {
    observedJsxElements: wiring.observedJsxElements,
    observedNativeProps: wiring.observedNativeProps,
    observedCustomProps: wiring.observedCustomProps,
    resolvedTool,
  };

  // Source says the hook is destructured but never referenced anywhere → fail.
  if (wiring.kind === "missing") {
    return {
      check: "action-wiring",
      outcome: "failed",
      subject: actionName,
      reason: wiring.reason ?? `Action '${actionName}' is declared in contract but useAction('${actionName}') is not wired to any UI element`,
      diagnostics: baseDiagnostics,
    };
  }

  // Source says wired via custom-component prop / non-deterministic trigger → unverified.
  if (wiring.kind === "unverified") {
    return {
      check: "action-wiring",
      outcome: "unverified",
      subject: actionName,
      reason: wiring.reason ?? "Source indicates non-click or non-native wiring; static probe did not verify execution deterministically.",
      diagnostics: baseDiagnostics,
    };
  }

  // Source-detected deterministic wiring → simulate the matching trigger.
  const fired = await simulateAndCheck({
    container,
    user,
    probe,
    wiringKind: wiring.kind,
    actionName,
    actionLabel,
    eventKind: "action.fired",
  });

  if (fired.fired) return null; // verified — no issue

  // The AST already confirmed the wiring exists in source. The
  // simulator couldn't trigger it — most likely a conditional-render or
  // required-form-fill case. Be conservative: downgrade to unverified
  // rather than reporting a fake failure.
  return {
    check: "action-wiring",
    outcome: "unverified",
    subject: actionName,
    reason: `Source confirms ${wiring.kind} wiring exists for action '${actionName}', but synthetic ${wiring.kind} did not dispatch it. Likely cause: conditional rendering, required input/form fill, or a multi-step interaction the static probe cannot complete.`,
    elementHint: fired.attemptedHint,
    diagnostics: {
      ...baseDiagnostics,
      actionsFiredFromClicks: fired.otherActionsFired,
    },
  };
}

// `checkWiredToolWiring` is retired — `useWiredTool` was removed; the
// contract's `agentTools` is a catalog the AGENT invokes (no component
// hook to verify). Cross-refs from `actionSpec[*].nextStep` and
// `streamSpec[*].source.tool` ride through the action / stream check
// arms in `runRenderCheck` instead.

// ─────────────────────────────────────────────────────────────────────────────
// Trigger simulators — narrow set, deterministic only
// ─────────────────────────────────────────────────────────────────────────────

interface SimulateAndCheckInput {
  container: MinimalElement;
  user: { click: (el: MinimalElement) => Promise<void> };
  probe: Probe;
  wiringKind: "click" | "submit" | "change" | "keyboard-enter";
  actionName: string;
  actionLabel: string;
  eventKind: "action.fired" | "wiredTool.called";
}

interface SimulateResult {
  fired: boolean;
  attemptedHint?: string;
  otherActionsFired?: string[];
}

async function simulateAndCheck(input: SimulateAndCheckInput): Promise<SimulateResult> {
  const { container, user, probe, wiringKind, actionName, actionLabel, eventKind } = input;

  const candidates = findCandidateElements(container, wiringKind, actionName, actionLabel);
  if (candidates.length === 0) {
    return { fired: false, attemptedHint: `No ${wiringKind}-eligible element found in DOM` };
  }

  for (const el of candidates) {
    const before = probe.getFireLog().length;
    try {
      await dispatchTrigger(el, wiringKind, user);
    } catch {
      continue;
    }
    await flushPromises();
    const newEvents = probe.getFireLog().slice(before);
    const matched = newEvents.some(e => e.kind === eventKind && e.name === actionName);
    if (matched) return { fired: true };
  }

  // Capture what DID fire — useful diagnostic.
  const allFired = probe
    .getFireLog()
    .filter(e => e.kind === "action.fired")
    .map(e => e.name);
  const otherActionsFired = Array.from(new Set(allFired)).filter(n => n !== actionName);

  return {
    fired: false,
    attemptedHint: candidates.length ? describeElement(candidates[0]!) : undefined,
    otherActionsFired,
  };
}

async function dispatchTrigger(
  el: MinimalElement,
  kind: "click" | "submit" | "change" | "keyboard-enter",
  user: { click: (el: MinimalElement) => Promise<void> },
): Promise<void> {
  switch (kind) {
    case "click":
      await user.click(el);
      return;
    case "submit": {
      // Find the enclosing form (or the element itself if it IS a form) and
      // dispatch a 'submit' event on it. happy-dom respects this.
      const form = closestForm(el);
      if (!form) return;
      const ev = new (globalThis as { Event: typeof Event }).Event("submit", { bubbles: true, cancelable: true });
      (form as unknown as { dispatchEvent: (e: Event) => boolean }).dispatchEvent(ev);
      return;
    }
    case "change": {
      // Set a value before dispatching change — onChange handlers typically
      // read e.target.value, and a no-op change (same value) often won't
      // trigger downstream wiring. We only reach here when source-AST said
      // wiring is on a native element (input/select/textarea).
      setSyntheticValue(el);
      const ev = new (globalThis as { Event: typeof Event }).Event("change", { bubbles: true });
      (el as unknown as { dispatchEvent: (e: Event) => boolean }).dispatchEvent(ev);
      return;
    }
    case "keyboard-enter": {
      // Click first to focus, then dispatch an Enter keydown.
      try { await user.click(el); } catch { /* ignore */ }
      const KeyboardEventCtor = (globalThis as { KeyboardEvent?: new (type: string, init: object) => Event }).KeyboardEvent;
      if (KeyboardEventCtor) {
        const ev = new KeyboardEventCtor("keydown", { key: "Enter", bubbles: true });
        (el as unknown as { dispatchEvent: (e: Event) => boolean }).dispatchEvent(ev);
      }
      return;
    }
  }
}

/**
 * Mutate a native input/select/textarea to carry a non-empty, distinct value
 * just before firing 'change'. Without this, onChange handlers that branch on
 * e.target.value see whatever the component initialized (often empty / the
 * default), and the wiring under test never observes a real edit.
 *
 * Strategy:
 *   <select> — pick the first option whose value differs from the current one
 *   <input type=checkbox|radio> — flip checked
 *   <input type=number|range> — increment by 1 (or set to min+1 / "1")
 *   everything else (text/email/search/textarea/...) — append "x" if non-empty,
 *                                                       else set to "test"
 *
 * Best-effort: if any access throws (sealed mocks, unexpected shape), we leave
 * the element untouched and let the bare 'change' event fire.
 */
function setSyntheticValue(el: MinimalElement): void {
  try {
    const tag = el.tagName.toLowerCase();
    const node = el as unknown as {
      value?: string;
      checked?: boolean;
      type?: string;
      options?: ArrayLike<{ value: string }>;
    };

    if (tag === "select") {
      const opts = node.options;
      if (opts && opts.length > 0) {
        const current = node.value ?? "";
        let pick = opts[0]!.value;
        for (let i = 0; i < opts.length; i++) {
          if (opts[i]!.value !== current) { pick = opts[i]!.value; break; }
        }
        node.value = pick;
      }
      return;
    }

    if (tag === "input") {
      const type = (node.type ?? "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        node.checked = !node.checked;
        return;
      }
      if (type === "number" || type === "range") {
        const cur = Number(node.value ?? "");
        node.value = String(Number.isFinite(cur) ? cur + 1 : 1);
        return;
      }
      // text / email / search / url / password / tel / date / etc.
      node.value = node.value && node.value.length > 0 ? `${node.value}x` : "test";
      return;
    }

    if (tag === "textarea") {
      node.value = node.value && node.value.length > 0 ? `${node.value}x` : "test";
      return;
    }
  } catch {
    // Untouched element is fine — the bare change event still fires.
  }
}

function closestForm(el: MinimalElement): MinimalElement | null {
  // Climb via parentNode (happy-dom + native both expose this on Element).
  let cur: { tagName?: string; parentNode?: unknown } | null = el as unknown as {
    tagName?: string;
    parentNode?: unknown;
  };
  while (cur) {
    if (cur.tagName && cur.tagName.toLowerCase() === "form") {
      return cur as unknown as MinimalElement;
    }
    cur = cur.parentNode as { tagName?: string; parentNode?: unknown } | null;
  }
  return null;
}

function findCandidateElements(
  container: MinimalElement,
  kind: "click" | "submit" | "change" | "keyboard-enter",
  name: string,
  label: string,
): MinimalElement[] {
  switch (kind) {
    case "click":
      return findActionElements(container, name, label);
    case "submit": {
      // submit-eligible: <form>, button[type=submit], input[type=submit]
      const all = container.querySelectorAll<MinimalElement>(
        'form, button[type="submit"], input[type="submit"]',
      );
      return Array.from(all);
    }
    case "change": {
      const all = container.querySelectorAll<MinimalElement>("select, input, textarea");
      return Array.from(all);
    }
    case "keyboard-enter":
      return findActionElements(container, name, label);
  }
}

interface CheckPropCoverageInput {
  container: MinimalElement;
  propsSpec: PropsSpec;
  mockupProps: JsonObject;
}

function checkPropCoverage(input: CheckPropCoverageInput): RenderCheckIssue[] {
  const { container, propsSpec, mockupProps } = input;
  const issues: RenderCheckIssue[] = [];
  const text = container.textContent ?? "";

  for (const [propName, entry] of Object.entries(propsSpec.properties)) {
    if (!entry.required) continue;
    const value = mockupProps[propName];
    if (value === undefined || value === null) continue;

    // Pick a unique scalar marker we can search for in the DOM.
    const marker = pickScalarMarker(value);
    if (marker === null) continue;

    if (!text.includes(marker)) {
      issues.push({
        check: "prop-coverage",
        outcome: "unverified",
        subject: propName,
        reason: `Required prop '${propName}' value (${JSON.stringify(marker).slice(0, 60)}) not visible in rendered DOM`,
      });
    }
  }

  return issues;
}

interface CheckStreamRerenderInput {
  container: MinimalElement;
  eventName: string;
  probe: Probe;
  React: typeof import("react");
}

async function checkStreamRerender(input: CheckStreamRerenderInput): Promise<RenderCheckIssue | null> {
  const { container, eventName, probe } = input;

  if (!probe.getRegistered().streams.includes(eventName)) {
    return {
      check: "stream-rerender",
      outcome: "unverified",
      subject: eventName,
      reason: `useStream('${eventName}') was never called — the stream event is declared in the contract but the component does not subscribe to it`,
    };
  }

  const before = container.textContent ?? "";
  const marker = `__probe_marker_${Date.now()}__`;
  // Emit a synthetic payload with a unique marker we can search for.
  // For payloads where the schema is unknown, push an object containing the marker
  // in multiple common field names so downstream consumers find it.
  const payload = { id: marker, text: marker, value: marker, message: marker, name: marker };

  await new Promise<void>(resolve => {
    setTimeout(() => {
      probe.emitStream(eventName, payload);
      resolve();
    }, 0);
  });
  await flushPromises();

  const after = container.textContent ?? "";
  if (after === before) {
    return {
      check: "stream-rerender",
      outcome: "unverified",
      subject: eventName,
      reason: `useStream('${eventName}') is subscribed but emitting a payload did not change the DOM`,
    };
  }
  if (!after.includes(marker)) {
    // DOM changed but our marker isn't visible — possible the consumer renders
    // a derived value. Soft-pass.
    return null;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function findActionElements(container: MinimalElement, name: string, label: string): MinimalElement[] {
  const candidates: MinimalElement[] = [];
  const seen = new Set<MinimalElement>();

  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const nameKey = norm(name);
  const labelKey = norm(label);

  const allClickable = container.querySelectorAll<MinimalElement>(
    'button, [role="button"], input[type="submit"], input[type="button"], a[href]',
  );

  // Pass 1: text/aria-label/data-action match
  for (const el of allClickable) {
    const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
    const txt = (el.textContent ?? "").toLowerCase();
    const dataAction = (el.getAttribute("data-action") ?? "").toLowerCase();
    if (
      aria.includes(label.toLowerCase()) ||
      txt.includes(label.toLowerCase()) ||
      norm(aria).includes(nameKey) ||
      norm(txt).includes(nameKey) ||
      dataAction === name.toLowerCase() ||
      norm(txt).includes(labelKey)
    ) {
      if (!seen.has(el)) {
        seen.add(el);
        candidates.push(el);
      }
    }
  }

  // Pass 2: any clickable as fallback (we'll click them all)
  for (const el of allClickable) {
    if (!seen.has(el)) {
      seen.add(el);
      candidates.push(el);
    }
  }

  return candidates;
}

function describeElement(el: MinimalElement): string {
  const tag = el.tagName.toLowerCase();
  const aria = el.getAttribute("aria-label");
  const txt = (el.textContent ?? "").trim().slice(0, 30);
  if (aria) return `<${tag} aria-label="${aria}">`;
  if (txt) return `<${tag}>${txt}</${tag}>`;
  return `<${tag}>`;
}

function pickScalarMarker(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const m = pickScalarMarker(item);
      if (m) return m;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      const m = pickScalarMarker(v);
      if (m) return m;
    }
  }
  return null;
}

function flushPromises(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
