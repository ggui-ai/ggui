/**
 * The Anthropic judge both live probes drive (`cache-reuse-probe.ts`,
 * `match-precision/run-probe.ts`).
 *
 * Haiku-pinned by default, like the probes' reported numbers, with the
 * probes' 512-token answer budget. The request shape and the failure
 * names are the shared structured call's (`anthropicToolCall` in
 * `@ggui-ai/ui-gen/providers`, ggui#1271): a model that refuses a
 * forced `tool_choice` gets `auto` with at most one call and thinking
 * headroom, and a turn that ends without the tool call throws an
 * `AnthropicStructuredCallError` naming why — never an `undefined`
 * decision a probe would score as a no-match.
 */
import type { LLMCaller, ToolSchema } from "@ggui-ai/negotiator";
import { anthropicToolCall } from "@ggui-ai/ui-gen/providers";

export const DEFAULT_PROBE_JUDGE_MODEL = "claude-haiku-5-5";
const PROBE_ANSWER_BUDGET = 512;

export function anthropicProbeJudge(
  apiKey: string,
  model: string = DEFAULT_PROBE_JUDGE_MODEL
): LLMCaller {
  return {
    async call(): Promise<string> {
      throw new Error("probe judge: text mode unused — the probes use callStructured");
    },
    async callStructured(system: string, user: string, tool: ToolSchema): Promise<unknown> {
      const result = await anthropicToolCall({
        apiKey,
        model,
        systemPrompt: system,
        userPrompt: user,
        tool,
        maxTokens: PROBE_ANSWER_BUDGET,
      });
      return result.input;
    },
  };
}
