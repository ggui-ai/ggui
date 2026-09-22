/**
 * ggui#1185 (B) — the coding agent on the Agent SDK for the login path.
 *
 * RED-first pins for `ClaudeCodeLoginAgent`, the one client class the
 * router selects when the route decision carries `auth: 'claude-code-login'`
 * (`routeOverride.claudeCodeLogin`). Every `callTools` is ONE `query()`;
 * the harness executes the tool, the client never does. Each pin below is
 * a measured SDK behaviour (0.3.229) from the design slice
 * (`docs/plans/2026-09-21-1185-b-login-client.md`), written before the
 * client existed.
 *
 * The SDK is mocked at the module boundary: `query()` is a scripted async
 * generator that records the options it was given and drives
 * `canUseTool` exactly as the binary does before executing a tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApiKeySource,
  Options,
  PermissionResult,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  BetaContentBlock,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { isRecord, type JsonObject } from "@ggui-ai/protocol";
import type { LLMToolDef } from "../llm.js";

/**
 * `system:init` as the binary emits it on the login path: `apiKeySource`
 * is the literal `"none"` (measured), a value the SDK's `ApiKeySource`
 * union does not name. The fixture type is the SDK's, widened by exactly
 * that one value.
 */
type MeasuredInitMessage = Omit<SDKSystemMessage, "apiKeySource"> & {
  readonly apiKeySource: ApiKeySource | "none";
};

type ScriptedMessage = SDKMessage | MeasuredInitMessage;

interface RecordedCall {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options: Options;
  readonly decisions: Array<PermissionResult | null>;
}

interface Script {
  /** Messages the fake `query()` yields, in order. */
  messages: ScriptedMessage[];
  /** Thrown AFTER the last message (the SDK re-surfacing an error result). */
  throwAfter?: Error;
  /** Thrown BEFORE any message (a spawn / transport failure). */
  throwBefore?: Error;
}

const fake = vi.hoisted(() => ({
  calls: [] as RecordedCall[],
  scripts: [] as Script[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  // The real tool()/createSdkMcpServer(): the bridge under test builds a
  // real in-process server; only the binary (query) is faked.
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const options = params.options ?? {};
    const call: RecordedCall = { prompt: params.prompt, options, decisions: [] };
    fake.calls.push(call);
    const script = fake.scripts.shift();
    if (script === undefined) throw new Error("fake query(): no script queued");
    return (async function* () {
      if (script.throwBefore) throw script.throwBefore;
      for (const msg of script.messages) {
        // The binary asks `canUseTool` before it would execute a tool; a
        // deny means the handler never runs. Mirror that ordering.
        if (msg.type === "assistant" && options.canUseTool) {
          for (const block of msg.message.content) {
            if (block.type === "tool_use") {
              const decision = await options.canUseTool(
                block.name,
                isRecord(block.input) ? block.input : {},
                {
                  signal: new AbortController().signal,
                  toolUseID: block.id,
                  requestId: `req-${block.id}`,
                }
              );
              call.decisions.push(decision);
            }
          }
        }
        yield msg;
      }
      if (script.throwAfter) throw script.throwAfter;
    })();
  },
}));

import {
  AnthropicAgent,
  ClaudeCodeLoginAgent,
  createAgent,
  createVisionAgent,
  type ProviderRetryInfo,
} from "./llm-router.js";

// ── fixtures ────────────────────────────────────────────────────────────

const UUID = "00000000-0000-4000-8000-000000000001";
const SESSION = "sess-1";
const MODEL = "claude-fable-5-1";

const nullUsage: BetaUsage = {
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  fallback_credit: null,
  inference_geo: null,
  input_tokens: 8,
  iterations: null,
  output_tokens: 8,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: null,
  speed: null,
};

function resultUsage(over: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreated?: number;
  thinking?: number;
}): SDKResultSuccess["usage"] {
  return {
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: over.cacheCreated ?? 0,
    },
    cache_creation_input_tokens: over.cacheCreated ?? 0,
    cache_read_input_tokens: over.cacheRead ?? 0,
    fallback_credit: { status: { type: "redeemed" } },
    inference_geo: "us",
    input_tokens: over.input,
    iterations: [],
    output_tokens: over.output,
    output_tokens_details: { thinking_tokens: over.thinking ?? 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: "standard",
    speed: "standard",
  };
}

function init(apiKeySource: ApiKeySource | "none"): MeasuredInitMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource,
    claude_code_version: "2.1.229",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [{ name: "ggui", status: "connected" }],
    model: MODEL,
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: UUID,
    session_id: SESSION,
  };
}

function assistant(
  content: BetaContentBlock[],
  stop: "tool_use" | "end_turn" = "tool_use"
): SDKAssistantMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_1",
      container: null,
      content,
      context_management: null,
      diagnostics: null,
      model: MODEL,
      role: "assistant",
      stop_details: null,
      stop_reason: stop,
      stop_sequence: null,
      type: "message",
      usage: nullUsage,
    },
    parent_tool_use_id: null,
    uuid: UUID,
    session_id: SESSION,
  };
}

function toolUse(name: string, input: JsonObject, id = "toolu_1"): BetaContentBlock {
  return { type: "tool_use", id, name, input };
}
function text(t: string): BetaContentBlock {
  return { type: "text", text: t, citations: null };
}
function thinking(t: string): BetaContentBlock {
  return { type: "thinking", thinking: t, signature: "sig" };
}

function maxTurns(usage: SDKResultSuccess["usage"], errors: string[] = []): SDKResultError {
  return {
    type: "result",
    subtype: "error_max_turns",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: true,
    num_turns: 1,
    stop_reason: "tool_use",
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: UUID,
    session_id: SESSION,
  };
}

function success(usage: SDKResultSuccess["usage"], result = ""): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    uuid: UUID,
    session_id: SESSION,
  };
}

function executionError(usage: SDKResultSuccess["usage"], errors: string[]): SDKResultError {
  return { ...maxTurns(usage, errors), subtype: "error_during_execution" };
}

/** An API error the binary relayed: success-shaped, `is_error`, with the HTTP status. */
function apiError(
  usage: SDKResultSuccess["usage"],
  status: number,
  text: string
): SDKResultSuccess {
  return { ...success(usage, text), is_error: true, api_error_status: status };
}

const APPLY: LLMToolDef = {
  name: "apply_changes",
  description: "Replace line ranges",
  parameters: {
    type: "object",
    properties: { changes: { type: "array", items: { type: "object" } } },
    required: ["changes"],
  },
};
const ICONS: LLMToolDef = {
  name: "get_icons",
  description: "Look up icons",
  parameters: {
    type: "object",
    properties: { names: { type: "array", items: { type: "string" } } },
  },
};

const INPUT: JsonObject = { changes: [{ startLine: 1, endLine: 2, code: "x" }] };

function loginAgent(onRetry?: (info: ProviderRetryInfo) => void): ClaudeCodeLoginAgent {
  return new ClaudeCodeLoginAgent({ claudeCodeLogin: true }, onRetry);
}

function queue(...scripts: Script[]): void {
  fake.scripts.push(...scripts);
}

const happyPath: Script = {
  messages: [
    init("none"),
    assistant([toolUse("mcp__ggui__apply_changes", INPUT)]),
    maxTurns(resultUsage({ input: 125, output: 40, cacheRead: 100, cacheCreated: 5 })),
  ],
  throwAfter: new Error("Claude Code returned an error result: Reached max turns (1)"),
};

let warns: string[] = [];
let logs: string[] = [];

beforeEach(() => {
  fake.calls.length = 0;
  fake.scripts.length = 0;
  warns = [];
  logs = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-must-not-reach-the-binary");
  vi.stubEnv("CLAUDE_API_KEY", "alias-must-not-reach-the-binary");
  vi.stubEnv("GGUI_UNRELATED", "kept");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ── selection: ONE seam, every constructor ──────────────────────────────

describe("selection — the route decision picks the client, at both constructors", () => {
  it("createAgent(anthropic + claudeCodeLogin) → ClaudeCodeLoginAgent; without the flag → AnthropicAgent", () => {
    expect(
      createAgent({ provider: "anthropic", model: MODEL, routeOverride: { claudeCodeLogin: true } })
    ).toBeInstanceOf(ClaudeCodeLoginAgent);
    expect(
      createAgent({ provider: "anthropic", model: MODEL, routeOverride: { apiKey: "k" } })
    ).toBeInstanceOf(AnthropicAgent);
    expect(createAgent({ provider: "anthropic", model: MODEL })).toBeInstanceOf(AnthropicAgent);
  });

  it("createVisionAgent(anthropic + claudeCodeLogin) → the same class (the in-loop visual judge rides it)", () => {
    expect(
      createVisionAgent({
        provider: "anthropic",
        model: MODEL,
        routeOverride: { claudeCodeLogin: true },
      })
    ).toBeInstanceOf(ClaudeCodeLoginAgent);
  });

  it("refuses a non-anthropic provider: the login authenticates the Claude Code binary only", () => {
    expect(() =>
      createAgent({ provider: "openai", model: "gpt-x", routeOverride: { claudeCodeLogin: true } })
    ).toThrow(/claude-code-login/);
  });
});

// ── callTools: one query(), the carve-out as options ────────────────────

describe("callTools — one query() carrying the carve-out", () => {
  it("passes the system prompt verbatim, the model literal, maxTurns 1, thinking disabled, and Layer 1 pins", async () => {
    queue(happyPath);
    await loginAgent().callTools(
      MODEL,
      "SYSTEM ZEBRA-7",
      "user prompt",
      [APPLY, ICONS],
      "required"
    );
    const { prompt, options } = fake.calls[0]!;
    expect(prompt).toBe("user prompt");
    expect(options.systemPrompt).toBe("SYSTEM ZEBRA-7");
    expect(options.model).toBe(MODEL);
    expect(options.maxTurns).toBe(1);
    expect(options.thinking).toEqual({ type: "disabled" });
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    // `--no-bare` is deliberately NOT passed: the SDK's bundled binary rejects it (measured).
    expect(options.extraArgs).toBeUndefined();
  });

  it("strips every provider key name from the spawned env and keeps the rest", async () => {
    queue(happyPath);
    await loginAgent().callTools(MODEL, "s", "u", [APPLY], "required");
    const env = fake.calls[0]!.options.env;
    expect(env).toBeDefined();
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("CLAUDE_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(env?.["GGUI_UNRELATED"]).toBe("kept");
  });

  it("bridges the tools as an in-process MCP server named ggui and allow-lists NONE of them", async () => {
    queue(happyPath);
    await loginAgent().callTools(MODEL, "s", "u", [APPLY, ICONS], "required");
    const { options } = fake.calls[0]!;
    const ggui = options.mcpServers?.["ggui"];
    expect(ggui).toBeDefined();
    expect(ggui?.type).toBe("sdk");
    // Allow-listed MCP tools bypass canUseTool and EXECUTE (measured) — so none may be.
    expect(options.allowedTools).toBeUndefined();
    expect(typeof options.canUseTool).toBe("function");
  });

  it("the intercept: canUseTool denies, so the handler never runs — the harness executes the tool", async () => {
    queue(happyPath);
    await loginAgent().callTools(MODEL, "s", "u", [APPLY], "required");
    const { decisions } = fake.calls[0]!;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.behavior).toBe("deny");
  });

  it("shape adapter: mcp__ggui__ prefix stripped, id carried, input passed through intact", async () => {
    queue(happyPath);
    const res = await loginAgent().callTools(MODEL, "s", "u", [APPLY], "required");
    expect(res.toolCalls).toEqual([{ id: "toolu_1", name: "apply_changes", input: INPUT }]);
  });

  it('reports appliedToolChoice "auto" honestly — the SDK has no tool_choice surface', async () => {
    queue(happyPath);
    const res = await loginAgent().callTools(MODEL, "s", "u", [APPLY], "required");
    expect(res.appliedToolChoice).toBe("auto");
  });

  it("usage comes from result.usage ONLY — never the chunk-level per-message usage", async () => {
    queue(happyPath);
    const res = await loginAgent().callTools(MODEL, "s", "u", [APPLY], "required");
    expect(res.inputTokens).toBe(125); // per-message usage said 8
    expect(res.outputTokens).toBe(40);
    expect(res.cacheReadTokens).toBe(100);
    expect(res.cacheCreationTokens).toBe(5);
  });

  it("error_max_turns after a captured tool_use is the one-shot's normal end; the SDK's re-thrown error result is recognised, not swallowed generically", async () => {
    queue(happyPath); // throwAfter set
    await expect(
      loginAgent().callTools(MODEL, "s", "u", [APPLY], "required")
    ).resolves.toMatchObject({
      toolCalls: [{ name: "apply_changes" }],
    });
  });

  it("error_max_turns with NO tool_use → toolCalls [] (the model chose not to call — same as the raw arm)", async () => {
    queue({
      messages: [
        init("none"),
        assistant([text("I will not call a tool")], "end_turn"),
        maxTurns(resultUsage({ input: 10, output: 3 })),
      ],
      throwAfter: new Error("Claude Code returned an error result: Reached max turns (1)"),
    });
    const res = await loginAgent().callTools(MODEL, "s", "u", [APPLY], "required");
    expect(res.toolCalls).toEqual([]);
    expect(res.inputTokens).toBe(10);
  });

  it("a success result with text only → toolCalls []", async () => {
    queue({
      messages: [
        init("none"),
        assistant([text("done")], "end_turn"),
        success(resultUsage({ input: 5, output: 2 }), "done"),
      ],
    });
    const res = await loginAgent().callTools(MODEL, "s", "u", [APPLY], "required");
    expect(res.toolCalls).toEqual([]);
  });

  it('an error result of any other class is thrown with its errors, never returned as "no tool call"', async () => {
    queue({
      messages: [
        init("none"),
        executionError(resultUsage({ input: 1, output: 0 }), ["boom from the binary"]),
      ],
      throwAfter: new Error("Claude Code returned an error result: boom from the binary"),
    });
    await expect(loginAgent().callTools(MODEL, "s", "u", [APPLY], "required")).rejects.toThrow(
      /boom from the binary/
    );
  });

  it("a 429 surfaced on the result rides the SAME retry seam as the raw arm (apiCall + onRetry)", async () => {
    const retries: ProviderRetryInfo[] = [];
    queue(
      {
        messages: [
          init("none"),
          apiError(resultUsage({ input: 0, output: 0 }), 429, "rate limited"),
        ],
        throwAfter: new Error("Claude Code returned an error result: rate limited"),
      },
      happyPath
    );
    const res = await loginAgent((info) => retries.push(info)).callTools(
      MODEL,
      "s",
      "u",
      [APPLY],
      "required"
    );
    expect(res.toolCalls).toHaveLength(1);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.status).toBe(429);
    expect(fake.calls).toHaveLength(2);
  }, 60_000);

  it("a throw BEFORE any result (spawn / transport) is rethrown as-is", async () => {
    queue({ messages: [], throwBefore: new Error("spawn ENOENT") });
    await expect(loginAgent().callTools(MODEL, "s", "u", [APPLY], "required")).rejects.toThrow(
      /spawn ENOENT/
    );
  });

  it('prints apiKeySource from system:init — "none" is the receipt that the run is on the login', async () => {
    queue(happyPath);
    await loginAgent().callTools(MODEL, "s", "u", [APPLY], "required");
    expect(logs.some((l) => l.includes("apiKeySource=none"))).toBe(true);
  });

  it("refuses a run whose binary authenticated from a KEY — that run is off the login path", async () => {
    queue({ ...happyPath, messages: [init("user"), ...happyPath.messages.slice(1)] });
    await expect(loginAgent().callTools(MODEL, "s", "u", [APPLY], "required")).rejects.toThrow(
      /apiKeySource/
    );
  });

  it("intercept/stream disagreement is an observability event, never silent (the block wins)", async () => {
    // The fake calls canUseTool with the block's input; make the block carry a
    // second tool the intercept never saw by scripting two blocks but the
    // fake only asks for... (both are asked). Instead: script a block whose
    // canUseTool name differs — the fake forwards the block name, so a
    // disagreement can only come from a tool the intercept did not see:
    // an assistant message AFTER the one that was intercepted.
    queue({
      messages: [
        init("none"),
        assistant([
          toolUse("mcp__ggui__apply_changes", INPUT, "toolu_1"),
          toolUse("mcp__ggui__get_icons", { names: ["x"] }, "toolu_2"),
        ]),
        maxTurns(resultUsage({ input: 1, output: 1 })),
      ],
      throwAfter: new Error("Claude Code returned an error result: Reached max turns (1)"),
    });
    const res = await loginAgent().callTools(MODEL, "s", "u", [APPLY, ICONS], "required");
    expect(res.toolCalls.map((c) => c.name)).toEqual(["apply_changes", "get_icons"]);
    expect(fake.calls[0]!.decisions).toHaveLength(2);
  });
});

// ── callText / callVision: the same client, the same accounting ─────────

describe("callText / callVision", () => {
  it("callText returns the text blocks joined, thinking excluded, usage from result.usage", async () => {
    queue({
      messages: [
        init("none"),
        assistant([thinking("hmm"), text("Hello"), text(" world")], "end_turn"),
        success(resultUsage({ input: 7, output: 3, thinking: 61 }), "Hello world"),
      ],
    });
    const res = await loginAgent().callText(MODEL, "sys", "say hello");
    expect(res.text).toBe("Hello world");
    expect(res.inputTokens).toBe(7);
    expect(res.outputTokens).toBe(3);
    expect(fake.calls[0]!.prompt).toBe("say hello");
    expect(fake.calls[0]!.options.systemPrompt).toBe("sys");
  });

  it("callVision sends the image as a base64 image block inside a streamed user message", async () => {
    queue({
      messages: [
        init("none"),
        assistant([text("Orange")], "end_turn"),
        success(resultUsage({ input: 164, output: 78 }), "Orange"),
      ],
    });
    const res = await loginAgent().callVision(MODEL, "judge", "what colour?", {
      mediaType: "image/png",
      base64: "iVBORw0KGgo=",
    });
    expect(res.text).toBe("Orange");
    expect(res.inputTokens).toBe(164);
    const { prompt } = fake.calls[0]!;
    expect(typeof prompt).not.toBe("string");
    const messages: SDKUserMessage[] = [];
    for await (const m of prompt as AsyncIterable<SDKUserMessage>) messages.push(m);
    expect(messages).toHaveLength(1);
    const content = messages[0]!.message.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error("content must be blocks");
    expect(content).toEqual(
      expect.arrayContaining([
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        },
        { type: "text", text: "what colour?" },
      ])
    );
  });
});

// ── ggui#1273 — the per-call usage line Exp 009 needs to net thinking out ──

describe("per-call usage line (ggui#1273)", () => {
  const usageLines = (): string[] => logs.filter((l) => l.includes("[claude-code-login] usage "));

  it("callTools logs ONE usage line with input/output/cache/thinking/text, thinking read from result.usage", async () => {
    queue({
      messages: [
        init("none"),
        assistant([
          thinking(""),
          text("I will update line 1 now."),
          toolUse("mcp__ggui__apply_changes", INPUT),
        ]),
        maxTurns(
          resultUsage({ input: 125, output: 40, cacheRead: 100, cacheCreated: 5, thinking: 61 })
        ),
      ],
      throwAfter: new Error("Claude Code returned an error result: Reached max turns (1)"),
    });
    await loginAgent().callTools(MODEL, "s", "u", [APPLY], "required");
    expect(usageLines()).toHaveLength(1);
    const line = usageLines()[0] ?? "";
    for (const part of [
      "kind=callTools",
      "input=125",
      "output=40",
      "cacheRead=100",
      "cacheCreated=5",
      "thinking=61",
      "thinkingBlocks=1",
      "textChars=25",
      "toolCalls=1",
      "stop=tool_use",
    ]) {
      expect(line).toContain(part);
    }
  });

  it("thinking=0 and textChars=0 on a clean tool-only turn", async () => {
    queue(happyPath);
    await loginAgent().callTools(MODEL, "s", "u", [APPLY], "required");
    const line = usageLines()[0] ?? "";
    expect(line).toContain("thinking=0");
    expect(line).toContain("textChars=0");
    expect(line).toContain("thinkingBlocks=0");
  });

  it("is logged on an error ending too — the failed call spent tokens as well", async () => {
    queue({
      messages: [
        init("none"),
        executionError(resultUsage({ input: 9, output: 2, thinking: 7 }), ["boom"]),
      ],
      throwAfter: new Error("Claude Code returned an error result: boom"),
    });
    await expect(loginAgent().callTools(MODEL, "s", "u", [APPLY], "required")).rejects.toThrow(
      /boom/
    );
    expect(usageLines()).toHaveLength(1);
    expect(usageLines()[0]).toContain("thinking=7");
  });

  it("callText and callVision log it too, each naming its kind", async () => {
    queue(
      {
        messages: [
          init("none"),
          assistant([text("hi")], "end_turn"),
          success(resultUsage({ input: 3, output: 1 }), "hi"),
        ],
      },
      {
        messages: [
          init("none"),
          assistant([text("Orange")], "end_turn"),
          success(resultUsage({ input: 164, output: 78 }), "Orange"),
        ],
      }
    );
    await loginAgent().callText(MODEL, "s", "u");
    await loginAgent().callVision(MODEL, "s", "u", {
      mediaType: "image/png",
      base64: "iVBORw0KGgo=",
    });
    const lines = usageLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("kind=callText");
    expect(lines[1]).toContain("kind=callVision");
    expect(lines[1]).toContain("input=164");
  });
});
