// packages/ui-gen/src/internal/evaluate-component-source.ts
//
// The ONE compile-and-evaluate helper for component source: esbuild
// TSX→CJS transform + vm.Script in-context execution behind a
// caller-supplied `require`. Consumed by:
//
//   - `tools/render-check-worker.ts` — the subprocess render smoke
//     test (host isolation lives at the spawn layer, in the parent's
//     `tryRender` via `@ggui-ai/sandbox`).
//   - `harness/check/runtime-render/load-component.ts` — the in-loop
//     probe (single-realm React; caller injects module resolutions).
//
// The module-resolution POLICY is deliberately not shared — each
// caller owns its own `require` shim (allowed specifiers, fallbacks,
// error wording). What is shared is the mechanical eval pipeline:
//
//   1. esbuild.transform(source) → CJS
//   2. wrap in `(function(require, exports, module) { ... })`
//   3. vm.Script(...).runInThisContext()
//   4. call with the caller's require + a fresh module object
//   5. return `module.exports` read AFTER execution — esbuild's CJS
//      output REPLACES `module.exports` (`module.exports =
//      __toCommonJS(...)`), so the initial reference can't be trusted.

export async function evaluateComponentSource(
  sourceCode: string,
  sandboxRequire: (id: string) => unknown,
): Promise<Record<string, unknown>> {
  const esbuild = await import("esbuild");
  const { Script } = await import("node:vm");

  const cjsResult = await esbuild.transform(sourceCode, {
    loader: "tsx",
    target: "es2020",
    format: "cjs",
    jsx: "automatic",
    jsxImportSource: "react",
    sourcefile: "Component.tsx",
  });

  const sandboxModule: { exports: Record<string, unknown> } = { exports: {} };

  const wrappedCode = `(function(require, exports, module) {\n${cjsResult.code}\n})`;
  const script = new Script(wrappedCode, { filename: "Component.cjs" });
  const fn = script.runInThisContext() as (
    require: (id: string) => unknown,
    exports: Record<string, unknown>,
    module: { exports: Record<string, unknown> },
  ) => void;

  fn(sandboxRequire, sandboxModule.exports, sandboxModule);

  return sandboxModule.exports;
}
