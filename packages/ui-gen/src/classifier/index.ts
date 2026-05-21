// packages/ui-gen/src/classifier/index.ts
//
// Public barrel for the `@ggui-ai/ui-gen/classifier` subpath.
//
// Treat the exports here as the stable surface: `classifyAxes` + the axis
// type vocabulary. Re-exports from `./inspect` / `./risk-tier` / per-axis
// inference modules are available for advanced consumers but are not the
// recommended entry point.

export * from "./axes";
export { classifyAxes } from "./classifier";
export type { ClassifyInput } from "./classifier";
export {
  inspect,
  inferStreamKindFromSchema,
} from "./inspect";
export type {
  ClassifierInput,
  ContractSignals,
  EntityList,
  SingletonEntity,
  ActionEntryInfo,
  AgentToolInfo,
} from "./inspect";
export { deriveRiskTier } from "./risk-tier";
export { inferFetch } from "./infer-fetch";
export { inferLayout } from "./infer-layout";
export { inferRealtime } from "./infer-realtime";
export { inferRender } from "./infer-render";
export { inferState } from "./infer-state";
export { inferTooling } from "./infer-tooling";
export { inferWriteTrigger } from "./infer-trigger";
export { inferWrites } from "./infer-writes";
