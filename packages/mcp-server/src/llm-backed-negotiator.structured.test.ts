/**
 * ggui#1255 (S5) — the negotiator's structured call on models that
 * REFUSE a forced tool.
 *
 * `buildLlmCaller(...).callStructured` used to send
 * `tool_choice: {type: 'tool', name}` for every Anthropic selection. The
 * models that always think (Claude Fable 5.1 today; Opus 5.5 once the
 * shared predicate names it) answer that with HTTP 400, the rerank judge
 * and the contract synthesizer collapse the throw to a null decision,
 * and a render that should have reused a blueprint pays for a cold
 * generation instead — silently.
 *
 * The fix, pinned here against the HTTP body the negotiator sends:
 *   - a model the shared predicate (`@ggui-ai/protocol`
 *     `anthropicRejectsForcedToolChoice`) names gets `tool_choice: auto`
 *     with one call at most, an instruction naming the tool, and a
 *     thinking budget ADDED to the caller's answer budget (the rerank
 *     judge asks for 512 — all of it would go to thinking);
 *   - every other model keeps the forced tool and the caller's budget;
 *   - a turn that ends without the tool call is a NAMED failure — a
 *     `max_tokens` stop, a model that answered in text, a refusal, an
 *     HTTP error — never an anonymous "missing tool_use block".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rerankCandidates } from "@ggui-ai/negotiator";
import { buildLlmCaller } from "./llm-backed-negotiator.js";

const TOOL = {
  name: "submit_rerank_decision",
  description: "Submit your decision.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: { matchId: { type: ["string", "null"] } },
    required: ["matchId"],
  },
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
let reply: { status: number; body: object } = { status: 200, body: {} };

function anthropicReply(content: object[], stopReason: string): { status: number; body: object } {
  return {
    status: 200,
    body: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "m",
      content,
      stop_reason: stopReason,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

const TOOL_USE = { type: "tool_use", id: "toolu_1", name: TOOL.name, input: { matchId: "bp-1" } };
const THINKING = { type: "thinking", thinking: "", signature: "sig" };

beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as SentBody);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function caller(model: "claude-fable-5-1" | "claude-haiku-4-5-20251001") {
  const llm = buildLlmCaller(
    { provider: "anthropic", model },
    { provider: "anthropic", key: "sk-ant-test" }
  );
  if (!llm.callStructured) throw new Error("the anthropic caller must expose callStructured");
  return { llm, callStructured: llm.callStructured.bind(llm) };
}

describe("a model that refuses a forced tool (Claude Fable 5.1)", () => {
  it("sends tool_choice auto with at most one call — never the forced tool the model 400s on", async () => {
    reply = anthropicReply([THINKING, TOOL_USE], "tool_use");
    await caller("claude-fable-5-1").callStructured("sys", "user", TOOL, 512);
    expect(sent[0]?.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("names the tool in the system prompt, since auto no longer compels the call", async () => {
    reply = anthropicReply([TOOL_USE], "tool_use");
    await caller("claude-fable-5-1").callStructured("sys", "user", TOOL, 512);
    expect(sent[0]?.system.startsWith("sys")).toBe(true);
    expect(sent[0]?.system).toContain(TOOL.name);
  });

  it("adds a thinking budget ON TOP of the caller's answer budget (512 would all go to thinking)", async () => {
    reply = anthropicReply([TOOL_USE], "tool_use");
    await caller("claude-fable-5-1").callStructured("sys", "user", TOOL, 512);
    expect(sent[0]?.max_tokens).toBe(512 + 16_000);
  });

  it("returns the tool input — a decision, not a null — when the thinking turn ends in the tool call", async () => {
    reply = anthropicReply([THINKING, TOOL_USE], "tool_use");
    await expect(
      caller("claude-fable-5-1").callStructured("sys", "user", TOOL, 512)
    ).resolves.toEqual({ matchId: "bp-1" });
  });
});

describe("a model that accepts a forced tool (Claude Haiku 4.5) — unchanged", () => {
  it("keeps the forced tool, the caller's budget and the caller's system prompt", async () => {
    reply = anthropicReply([TOOL_USE], "tool_use");
    await caller("claude-haiku-4-5-20251001").callStructured("sys", "user", TOOL, 512);
    expect(sent[0]?.tool_choice).toEqual({ type: "tool", name: TOOL.name });
    expect(sent[0]?.max_tokens).toBe(512);
    expect(sent[0]?.system).toBe("sys");
  });
});

describe("a turn without the tool call is a NAMED failure", () => {
  it("max_tokens stop before the tool_use block → kind 'max_tokens', distinct from every other failure", async () => {
    reply = anthropicReply([THINKING], "max_tokens");
    await expect(
      caller("claude-fable-5-1").callStructured("sys", "user", TOOL, 512)
    ).rejects.toMatchObject({
      kind: "max_tokens",
      message: expect.stringContaining("[max_tokens]"),
    });
  });

  it("the model answered in text (end_turn, no tool_use) → kind 'no_tool_call'", async () => {
    reply = anthropicReply([{ type: "text", text: "I think bp-1 matches." }], "end_turn");
    await expect(
      caller("claude-fable-5-1").callStructured("sys", "user", TOOL, 512)
    ).rejects.toMatchObject({
      kind: "no_tool_call",
    });
  });

  it("a refusal → kind 'refusal'", async () => {
    reply = anthropicReply([], "refusal");
    await expect(
      caller("claude-fable-5-1").callStructured("sys", "user", TOOL, 512)
    ).rejects.toMatchObject({
      kind: "refusal",
    });
  });

  it("a non-2xx → kind 'http' carrying the status", async () => {
    reply = {
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error", message: "bad" } },
    };
    await expect(
      caller("claude-haiku-4-5-20251001").callStructured("sys", "user", TOOL, 512)
    ).rejects.toMatchObject({
      kind: "http",
      status: 400,
    });
  });

  it("surfaces through the real rerank judge: the null decision SAYS it was the budget", async () => {
    reply = anthropicReply([THINKING], "max_tokens");
    const { llm } = caller("claude-fable-5-1");
    const decision = await rerankCandidates(
      { llm },
      { intent: "a weather card", contractSummary: "props: city" },
      [{ id: "bp-1", cachedIntent: "a weather card", cachedContractSummary: "props: city" }]
    );
    expect(decision.matchId).toBeNull();
    expect(decision.reason).toContain("[max_tokens]");
  });
});

describe("the Anthropic caller meters its structured call (ggui#1418)", () => {
  const DECISION = { type: "tool_use", id: "toolu_2", name: TOOL.name, input: { matchId: "bp-1", confidence: 0.9, reason: "same card" } };

  it("callStructuredMetered returns the tool input with the response's usage", async () => {
    reply = anthropicReply([TOOL_USE], "tool_use");
    const { llm } = caller("claude-haiku-4-5-20251001");
    if (!llm.callStructuredMetered) throw new Error("the anthropic caller must expose callStructuredMetered");
    await expect(llm.callStructuredMetered("sys", "user", TOOL, 512)).resolves.toEqual({
      value: { matchId: "bp-1" },
      usage: { input: 10, output: 5 },
    });
  });

  it("a response without a readable usage block reports no usage, never zeros", async () => {
    const { llm } = caller("claude-haiku-4-5-20251001");
    if (!llm.callStructuredMetered) throw new Error("the anthropic caller must expose callStructuredMetered");
    for (const usage of [undefined, { input_tokens: "10", output_tokens: 5 }, { input_tokens: 10 }]) {
      const base = anthropicReply([TOOL_USE], "tool_use");
      const { usage: _drop, ...rest } = base.body as { usage: object };
      reply = { status: 200, body: usage === undefined ? rest : { ...rest, usage } };
      const result = await llm.callStructuredMetered("sys", "user", TOOL, 512);
      expect(result.value).toEqual({ matchId: "bp-1" });
      expect("usage" in result).toBe(false);
    }
  });

  it("callStructured still returns the bare tool input (every existing consumer)", async () => {
    reply = anthropicReply([TOOL_USE], "tool_use");
    await expect(caller("claude-haiku-4-5-20251001").callStructured("sys", "user", TOOL, 512)).resolves.toEqual({ matchId: "bp-1" });
  });

  it("through the real rerank judge, the decision's tokenCost is the response's usage", async () => {
    reply = anthropicReply([DECISION], "tool_use");
    const { llm } = caller("claude-haiku-4-5-20251001");
    const decision = await rerankCandidates(
      { llm },
      { intent: "a weather card", contractSummary: "props: city" },
      [{ id: "bp-1", cachedIntent: "a weather card", cachedContractSummary: "props: city" }]
    );
    expect(decision.matchId).toBe("bp-1");
    expect(decision.tokenCost).toEqual({ input: 10, output: 5 });
  });

  it("a provider other than Anthropic has no structured method, metered or not", () => {
    const llm = buildLlmCaller({ provider: "openai", model: "gpt-5.6" }, { provider: "openai", key: "sk-test" });
    expect(llm.callStructured).toBeUndefined();
    expect(llm.callStructuredMetered).toBeUndefined();
  });
});
