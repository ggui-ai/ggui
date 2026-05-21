// packages/ui-gen/src/adapters/index.ts
//
// Public API for the adapter module.
// Use getAdapter() to obtain adapter instances — it lazy-loads provider SDKs.
//
// NOTE: Importing concrete adapters (ClaudeRawAdapter, etc.) directly from
// this barrel file will statically pull in their provider SDKs. This is fine
// for benchmarks and tests, but Lambda entry points should use getAdapter()
// from './registry' to benefit from lazy loading and smaller bundles.

// ── Types ────────────────────────────────────────────────────────────
export type {
  ProviderName,
  AdapterMode,
  ToolDefinition,
  ToolResult,
  ToolResultContent,
  AdapterResult,
} from './types';

export { PROVIDER_DISPLAY_NAMES } from './types';

// ── Base class & config ──────────────────────────────────────────────
export { GeneratorAdapter } from './base';
export type { AdapterConfig, ClaudeSdkConfig, AnyAdapterConfig, GenerateParams } from './base';

// ── Registry (primary API) ───────────────────────────────────────────
export { getAdapter, listAdapters } from './registry';

// ── Tools ────────────────────────────────────────────────────────────
export { createGeneratorTools } from './tools';
export { zodToJsonSchema } from './tool-bridge';

// ── Concrete adapters (for benchmarks, tests, instanceof checks) ─────
// WARNING: These static imports pull in provider SDKs. Lambda entry
// points should NOT import from this barrel — use getAdapter() instead.
export { ClaudeRawAdapter } from './claude/raw';
export { ClaudeSdkAdapter } from './claude/sdk';
export { OpenAiRawAdapter } from './openai/raw';
export { OpenAiSdkAdapter } from './openai/sdk';
export { GoogleRawAdapter } from './google/raw';
export { GoogleSdkAdapter } from './google/sdk';
