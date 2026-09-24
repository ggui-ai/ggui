/**
 * The Anthropic judge both live probes drive (`cache-reuse-probe.ts`,
 * `match-precision/run-probe.ts`) — one implementation instead of the
 * byte-identical copy each used to carry (ggui#1264).
 *
 * Haiku-pinned by default, like the probes' reported numbers. A model
 * that refuses a forced `tool_choice` (`@ggui-ai/protocol`
 * `anthropicRejectsForcedToolChoice` — the always-thinking family) gets
 * `tool_choice: auto` with at most one call, the tool named in the
 * system prompt, and thinking headroom on top of the 512-token answer
 * budget, because its thinking counts against `max_tokens` and comes
 * before the tool call. A turn that ends without the tool call THROWS
 * naming the stop reason; the copies returned `undefined` as the judge's
 * decision, which a probe then scored as a no-match.
 */
import type { LLMCaller, ToolSchema } from "@ggui-ai/negotiator";
import { anthropicRejectsForcedToolChoice, isRecord } from "@ggui-ai/protocol";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const DEFAULT_PROBE_JUDGE_MODEL = "claude-haiku-4-5";
const PROBE_ANSWER_BUDGET = 512;

/**
 * Thinking budget added for a model that refuses a forced tool. Same
 * value and reason as the negotiator's production caller in
 * `@ggui-ai/mcp-server`; the three
 * copies are consolidated under ggui#1271.
 */
const ALWAYS_THINKING_HEADROOM_TOKENS = 16_000;

export function anthropicProbeJudge(
  apiKey: string,
  model: string = DEFAULT_PROBE_JUDGE_MODEL
): LLMCaller {
  return {
    async call(): Promise<string> {
      throw new Error("probe judge: text mode unused — the probes use callStructured");
    },
    async callStructured(system: string, user: string, tool: ToolSchema): Promise<unknown> {
      const refusesForcedTool = anthropicRejectsForcedToolChoice(model);
      const res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: refusesForcedTool
            ? PROBE_ANSWER_BUDGET + ALWAYS_THINKING_HEADROOM_TOKENS
            : PROBE_ANSWER_BUDGET,
          system: refusesForcedTool
            ? `${system}\n\nAnswer by calling the \`${tool.name}\` tool exactly once. Do not answer in text.`
            : system,
          messages: [{ role: "user", content: user }],
          tools: [
            {
              name: tool.name,
              description: tool.description,
              input_schema: tool.input_schema,
            },
          ],
          tool_choice: refusesForcedTool
            ? { type: "auto", disable_parallel_tool_use: true }
            : { type: "tool", name: tool.name },
        }),
      });
      const json: unknown = await res.json();
      if (!res.ok) {
        const message =
          isRecord(json) && isRecord(json["error"]) && typeof json["error"]["message"] === "string"
            ? json["error"]["message"]
            : `HTTP ${res.status}`;
        throw new Error(`anthropic: ${message}`);
      }
      const content = isRecord(json) && Array.isArray(json["content"]) ? json["content"] : [];
      const block = content.find(
        (b): b is Record<string, unknown> =>
          isRecord(b) && b["type"] === "tool_use" && b["name"] === tool.name
      );
      if (block === undefined || block["input"] === undefined) {
        const stopReason =
          isRecord(json) && typeof json["stop_reason"] === "string"
            ? json["stop_reason"]
            : "absent";
        throw new Error(
          `anthropic: no "${tool.name}" tool_use block in the response (stop_reason=${stopReason})`
        );
      }
      return block["input"];
    },
  };
}
