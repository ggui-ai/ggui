/**
 * ggui#1264 — the negotiator's dev caller (`buildAnthropicLlmCaller`,
 * shared by the synth benches and the rerank probe CLI) must not send a
 * forced `tool_choice` to a model that refuses one. It is Haiku-pinned
 * by default, but every CLI takes `--model`, and the always-thinking
 * models (Claude Fable 5.1 today; the list is `@ggui-ai/protocol`'s
 * `anthropicRejectsForcedToolChoice`) answer a forced tool with HTTP 400.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicLlmCaller } from "./cli-llm.js";

const TOOL = {
  name: "submit_contract",
  description: "Submit the contract.",
  input_schema: { type: "object", additionalProperties: false, properties: {} },
};

interface SentBody {
  readonly max_tokens: number;
  readonly system: string;
  readonly tool_choice: {
    readonly type: string;
    readonly name?: string;
    readonly disable_parallel_tool_use?: boolean;
  };
}

let sent: SentBody[] = [];
let replyBody: object = {};

beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as SentBody);
    return new Response(JSON.stringify(replyBody), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const TOOL_USE = { type: "tool_use", id: "toolu_1", name: TOOL.name, input: { ok: true } };

describe("buildAnthropicLlmCaller — forced tool only where the model accepts it", () => {
  it("Haiku 4.5 keeps the forced tool, the caller budget and the system prompt", async () => {
    replyBody = { content: [TOOL_USE], stop_reason: "tool_use" };
    await buildAnthropicLlmCaller("sk", "claude-haiku-4-5").callStructured?.("sys", "u", TOOL, 512);
    expect(sent[0]?.tool_choice).toEqual({ type: "tool", name: TOOL.name });
    expect(sent[0]?.max_tokens).toBe(512);
    expect(sent[0]?.system).toBe("sys");
  });

  it("a model that refuses a forced tool gets auto + one call + the tool named + thinking headroom", async () => {
    replyBody = { content: [TOOL_USE], stop_reason: "tool_use" };
    await expect(
      buildAnthropicLlmCaller("sk", "claude-fable-5-1").callStructured?.("sys", "u", TOOL, 512)
    ).resolves.toEqual({ ok: true });
    expect(sent[0]?.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(sent[0]?.max_tokens).toBe(512 + 16_000);
    expect(sent[0]?.system.startsWith("sys")).toBe(true);
    expect(sent[0]?.system).toContain(TOOL.name);
  });

  it("a turn without the tool call throws with the stop reason named", async () => {
    replyBody = {
      content: [{ type: "thinking", thinking: "", signature: "s" }],
      stop_reason: "max_tokens",
    };
    await expect(
      buildAnthropicLlmCaller("sk", "claude-fable-5-1").callStructured?.("sys", "u", TOOL, 512)
    ).rejects.toThrow(/stop_reason=max_tokens/);
  });
});
