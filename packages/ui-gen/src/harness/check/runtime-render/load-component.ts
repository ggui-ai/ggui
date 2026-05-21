// packages/ui-gen/src/harness/check/runtime-render/load-component.ts
//
// Eval a compiled component source string into a real React component reference.
//
// Pattern (lifted from src/tools/render-check.ts::tryRender):
//   1. Re-compile sourceCode → CJS with esbuild.transform
//   2. Wrap in (function(require, exports, module) { ... })
//   3. Run in vm.Script with a sandboxed require() that resolves:
//        - react / react/jsx-runtime → real react
//        - react-dom/* → real react-dom
//        - @ggui-ai/wire → REAL wire package (we want real useAction etc.,
//                         the probe is injected via WireConfig at provider level)
//        - @ggui-ai/design/* → real design package
//   4. Pluck `module.exports.default` as the Component
//
// Why we evaluate sourceCode (not the pre-compiled bundle): the test runner
// already has sourceCode handy, and re-compiling guarantees a CJS shape
// the vm sandbox can run without ESM module-record juggling.

import type { ComponentType } from "react";

export interface LoadComponentInput {
  /** The TSX source the agent emitted. We re-transform it to CJS. */
  readonly sourceCode: string;
  /**
   * Pre-resolved module instances to inject into the sandbox. CRITICAL:
   * the caller must pass the SAME React + wire instances they use outside
   * the sandbox — otherwise React context lookups fail (different React
   * realms have different dispatchers and contexts).
   *
   * Required keys: 'react', 'react/jsx-runtime', '@ggui-ai/wire'.
   * Optional: 'react-dom', '@ggui-ai/design/*'.
   */
  readonly moduleResolutions?: Readonly<Record<string, unknown>>;
}

export interface LoadComponentResult {
  readonly Component: ComponentType<Record<string, unknown>>;
}

export async function loadComponent(input: LoadComponentInput): Promise<LoadComponentResult> {
  const { sourceCode, moduleResolutions = {} } = input;
  const { createRequire } = await import("module");
  const { Script } = await import("vm");
  const esbuild = await import("esbuild");

  const cjsResult = await esbuild.transform(sourceCode, {
    loader: "tsx",
    target: "es2020",
    format: "cjs",
    jsx: "automatic",
    jsxImportSource: "react",
    sourcefile: "Component.tsx",
  });

  const require_ = createRequire(import.meta.url);

  const sandboxRequire = (id: string): unknown => {
    // 1. Caller-injected resolutions win — these guarantee single-realm
    //    React + wire so context lookups work.
    if (id in moduleResolutions) return moduleResolutions[id];

    // 2. Fall back to Node require for the remaining standard externals.
    if (id === "react/jsx-runtime" || id === "react/jsx-dev-runtime") {
      return require_("react/jsx-runtime");
    }
    if (id === "react") return require_("react");
    if (id === "react-dom" || id.startsWith("react-dom/")) {
      return require_(id);
    }
    if (id === "@ggui-ai/wire") return require_("@ggui-ai/wire");
    if (id.startsWith("@ggui-ai/design")) {
      try {
        return require_(id);
      } catch {
        throw new Error(
          `Required dependency not available in render-check sandbox: ${id}. ` +
            `Install @ggui-ai/design or run render-check from an environment that has it.`,
        );
      }
    }
    // `@ggui-ai/gadgets` is a first-class dependency for any component
    // that uses `clientCapabilities.gadgets`. The probe needs a real
    // implementation so the LLM's `useGeolocation()` call actually
    // resolves (Node's happy-dom doesn't carry the wrapper hooks
    // itself; this require pulls the npm package).
    if (id === "@ggui-ai/gadgets") {
      try {
        return require_("@ggui-ai/gadgets");
      } catch {
        throw new Error(
          `Required dependency not available in render-check sandbox: ${id}. ` +
            `Install @ggui-ai/gadgets or pass it through moduleResolutions.`,
        );
      }
    }
    // Operator-registered wrapper packages — caller injects via
    // `moduleResolutions` (the (specifier, hooks) pairs the bench
    // commit declares in `commit.appGadgets`). If a wrapper is
    // referenced by source but not injected, fall through to the
    // standard "import not allowed" message — the upstream push gate
    // would have rejected this contract before generation, so reaching
    // here is a test-fixture misconfiguration.
    throw new Error(`Import not allowed in render-check sandbox: ${id}`);
  };

  const moduleExports: Record<string, unknown> = {};
  const sandboxModule = { exports: moduleExports };

  const wrappedCode = `(function(require, exports, module) {\n${cjsResult.code}\n})`;
  const script = new Script(wrappedCode, { filename: "Component.cjs" });
  const fn = script.runInThisContext() as (
    require: typeof sandboxRequire,
    exports: Record<string, unknown>,
    module: { exports: Record<string, unknown> },
  ) => void;

  fn(sandboxRequire, sandboxModule.exports, sandboxModule);

  const Component = sandboxModule.exports.default as ComponentType<Record<string, unknown>> | undefined;
  if (typeof Component !== "function") {
    throw new Error("Compiled component has no default-exported function");
  }

  return { Component };
}
