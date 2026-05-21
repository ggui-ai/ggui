// packages/ui-gen/src/llm.ts
//
// Narrow LLM-routing contract types shared between the harness runtime
// and everything that wires tools through it. This is NOT the LLM router
// itself — the abstract `LLMAgent` class and the four concrete provider
// agents (Anthropic, OpenAI, Google, OpenRouter) live in
// `./harness/llm-router.ts`. Keeping these tool-call shape types in a
// separate module lets harness legs + coding tools depend on the shape
// without dragging in the heavy provider SDKs (`@anthropic-ai/sdk`,
// `openai`, `@google/genai`, the OpenRouter adapter).
//
// `LLMToolDef` appears in `WhatLeg.codingTools`, `WhatLeg.scopedTools`,
// and `Task.tools`.

import type { JsonObject } from "@ggui-ai/protocol";

/**
 * Tool definition for single-turn function calling. Describes the shape
 * the LLM should emit — the caller (harness runtime) executes the tool
 * itself. Intentionally does NOT include a handler; that coupling lives
 * one layer up in the runtime's `LLMTool` type.
 *
 * `parameters` is a JSON Schema object. Providers each normalize it
 * into their native tool format (Anthropic `input_schema`, OpenAI
 * `function.parameters` under strict mode, Google `functionCall`
 * parameters, OpenRouter `function.parameters`).
 */
export interface LLMToolDef {
  name: string;
  description: string;
  parameters: JsonObject;
}
