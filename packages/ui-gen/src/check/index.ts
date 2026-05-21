// packages/ui-gen/src/check/index.ts
//
// Public entrypoint for the `@ggui-ai/ui-gen/check` subpath — the
// deterministic tier-0 CHECK surface that every generation path runs
// against produced componentCode.
//
// Exposes the wire call-site extractor, the wire preservation +
// import gates, contract conformance validation, the TypeScript
// type-checker, the React-hooks linter, and the `runTier0` /
// `runTier0Checks` orchestrator. `createUiGenerator` consumes the
// orchestrator through this barrel — one pipeline, one set of gates.

export {
  checkWireImports,
  checkWirePreservation,
  collectExpectedWires,
  extractWireCallSites,
  extractWireImports,
  type WireCallSite,
  type WireImportReport,
  type WireImportSite,
  type WireKind,
  type WirePreservationReport,
} from "./extract-wire-calls.js";

// contract-validation
export {
  extractPropsInterface,
  inferPropsSpecFromSampleData,
  jsonSchemaTypeToTs,
  propsSpecToTypeScript,
  validateActionSpecConformance,
  validateAllContracts,
  validatePropsAgainstSchema,
  validateStreamSpecConformance,
  type ContractIssue,
} from "./contract-validation.js";

// type-checker
export {
  typecheck,
  type TypeCheckDiagnostic,
  type TypeCheckResult,
} from "./type-checker.js";

// react-linter
export {
  lintReactHooks,
  type ReactLintDiagnostic,
} from "./react-linter.js";

// runTier0 orchestrator
export { runTier0, runTier0Checks } from "./run-tier0.js";
