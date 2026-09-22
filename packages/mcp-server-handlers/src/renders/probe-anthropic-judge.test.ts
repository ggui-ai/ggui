/**
 * ggui#1264 — the one Anthropic judge both live probes use
 * (`cache-reuse-probe.ts`, `match-precision/run-probe.ts`; they used to
 * carry byte-identical copies). Haiku-pinned by default; a model that
 * refuses a forced `tool_choice` (`@ggui-ai/protocol`
 * `anthropicRejectsForcedToolChoice`) gets auto + one call + the tool
 * named + thinking headroom, and a turn without the tool call THROWS
 * naming the stop reason — the copies returned `undefined` as the
 * judge's decision instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anthropicProbeJudge } from "./probe-anthropic-judge.js";

const TOOL = {
  name: "submit_rerank_decision",
  description: "Submit your decision.",
  input_schema: { type: "object", additionalProperties: false, properties: {} },
};

interface SentBody {
  readonly model: string;
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

const TOOL_USE = { type: "tool_use", id: "toolu_1", name: TOOL.name, input: { matchId: null } };

describe("anthropicProbeJudge", () => {
  it("defaults to Haiku 4.5 with the forced tool and the probes' 512-token budget", async () => {
    replyBody = { content: [TOOL_USE], stop_reason: "tool_use" };
    await expect(anthropicProbeJudge("sk").callStructured?.("sys", "u", TOOL)).resolves.toEqual({
      matchId: null,
    });
    expect(sent[0]?.model).toBe("claude-haiku-4-5");
    expect(sent[0]?.tool_choice).toEqual({ type: "tool", name: TOOL.name });
    expect(sent[0]?.max_tokens).toBe(512);
    expect(sent[0]?.system).toBe("sys");
  });

  it("a model that refuses a forced tool gets auto + one call + the tool named + thinking headroom", async () => {
    replyBody = { content: [TOOL_USE], stop_reason: "tool_use" };
    await anthropicProbeJudge("sk", "claude-fable-5-1").callStructured?.("sys", "u", TOOL);
    expect(sent[0]?.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(sent[0]?.max_tokens).toBe(512 + 16_000);
    expect(sent[0]?.system).toContain(TOOL.name);
  });

  it("a turn without the tool call throws naming the stop reason — never an undefined decision", async () => {
    replyBody = { content: [], stop_reason: "max_tokens" };
    await expect(
      anthropicProbeJudge("sk", "claude-fable-5-1").callStructured?.("sys", "u", TOOL)
    ).rejects.toThrow(/stop_reason=max_tokens/);
  });
});
