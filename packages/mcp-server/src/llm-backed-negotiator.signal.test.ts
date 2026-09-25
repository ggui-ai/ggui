/**
 * ggui#1235 Cut 1b: the negotiator's Anthropic caller takes an optional
 * abort signal, and the package exports it.
 *
 * A deployment that bounds the handshake's LLM (the rerank judge and the
 * contract synthesizer) needs the bound to reach the HTTP request itself:
 * a bound that only races the promise leaves the request running. So the
 * signal given to `buildLlmCaller` must reach `fetch` on both the structured
 * path (`callStructured`) and the text path (`call`, via the provider
 * adapter), and an aborted signal must reject the call rather than resolve it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as serverIndex from "./index.js";
import { buildLlmCaller } from "./llm-backed-negotiator.js";

const TOOL = {
  name: "submit_rerank_decision",
  description: "Submit your decision.",
  input_schema: { type: "object", properties: { matchId: { type: ["string", "null"] } }, required: ["matchId"] },
};

let seenSignals: (AbortSignal | null | undefined)[] = [];

beforeEach(() => {
  seenSignals = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    seenSignals.push(init.signal);
    if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const isStructured = String(init.body).includes('"tools"');
    const content = isStructured
      ? [{ type: "tool_use", id: "t1", name: TOOL.name, input: { matchId: "bp-1" } }]
      : [{ type: "text", text: "hello" }];
    return new Response(
      JSON.stringify({
        id: "m",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5-20251001",
        content,
        stop_reason: isStructured ? "tool_use" : "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200 }
    );
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const SELECTION = { provider: "anthropic", model: "claude-haiku-4-5-20251001" } as const;
const KEY = { provider: "anthropic", key: "sk-ant-test" } as const;

describe("buildLlmCaller's signal (ggui#1235 Cut 1b)", () => {
  it("callStructured hands the caller's signal to fetch", async () => {
    const signal = new AbortController().signal;
    const llm = buildLlmCaller(SELECTION, KEY, { signal });
    await expect(llm.callStructured?.("sys", "user", TOOL, 512)).resolves.toEqual({ matchId: "bp-1" });
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]).toBe(signal);
  });

  it("call (the text path, via the provider adapter) hands the caller's signal to fetch", async () => {
    const signal = new AbortController().signal;
    const llm = buildLlmCaller(SELECTION, KEY, { signal });
    await llm.call("sys", "user", 64);
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]).toBe(signal);
  });

  it("an already-aborted signal rejects the structured call instead of resolving it", async () => {
    const llm = buildLlmCaller(SELECTION, KEY, { signal: AbortSignal.abort() });
    await expect(llm.callStructured?.("sys", "user", TOOL, 512)).rejects.toThrow();
  });

  it("an already-aborted signal rejects the text call too (the adapter path)", async () => {
    const llm = buildLlmCaller(SELECTION, KEY, { signal: AbortSignal.abort() });
    await expect(llm.call("sys", "user", 64)).rejects.toThrow();
  });

  it("control: no signal given → fetch sees none, as before", async () => {
    const llm = buildLlmCaller(SELECTION, KEY);
    await llm.callStructured?.("sys", "user", TOOL, 512);
    expect(seenSignals).toEqual([undefined]);
  });
});

describe("the package exports the caller (ggui#1235 Cut 1b)", () => {
  it("buildLlmCaller and AnthropicStructuredCallError are on the package index", () => {
    expect(serverIndex.buildLlmCaller).toBe(buildLlmCaller);
    expect(typeof serverIndex.AnthropicStructuredCallError).toBe("function");
  });
});
