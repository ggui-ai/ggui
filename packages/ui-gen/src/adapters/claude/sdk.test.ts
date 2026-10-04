/**
 * ggui#1185 — when the adapter runs on the machine's Claude Code login it must
 * hand the SDK exactly the options that keep the run honest: an env with no
 * provider key or endpoint override, no built-in tools, no ~/.claude settings,
 * the non-bare path pinned, and the caller's model. Asserted on the options
 * the SDK receives — the process is never spawned.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

const seen = vi.hoisted(() => ({ options: [] as Options[], before: [] as object[] }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { options: Options }) => {
    seen.options.push(args.options);
    // One final message with no compiled code: the adapter may fail AFTER the
    // call; the assertions below are on what it sent, not on what came back.
    return (async function* () {
      yield* seen.before;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        duration_ms: 1,
        total_cost_usd: 0,
        usage: {},
      };
    })();
  },
}));

import { ClaudeSdkAdapter } from "./sdk.js";

const PARAMS = {
  userPrompt: "u",
  systemPrompt: "s",
  model: "claude-haiku-4-5-20251001",
  maxTurns: 1,
  tools: [],
};

describe("ClaudeSdkAdapter — claude-code-login path (ggui#1185)", () => {
  afterEach(() => {
    seen.options.length = 0;
    seen.before.length = 0;
  });

  it("strips every provider key from the spawned env, pins tools/settings (no --no-bare: the bundled binary rejects it), keeps the model", async () => {
    const adapter = new ClaudeSdkAdapter({
      claudeCodeLogin: true,
      env: {
        ANTHROPIC_API_KEY: "sk-ant-stale",
        CLAUDE_API_KEY: "stale",
        ANTHROPIC_AUTH_TOKEN: "stale",
        ANTHROPIC_BASE_URL: "http://localhost:4000",
        PATH: "/usr/bin",
        // ggui#1278 — the rest of a loaded `.env`, and a switch that would re-route the binary.
        OPENAI_API_KEY: "sk-openai",
        GITHUB_TOKEN: "ghp",
        CLAUDE_CODE_USE_BEDROCK: "1",
      },
    });
    await adapter.generate(PARAMS).catch(() => undefined);
    expect(seen.options).toHaveLength(1);
    const o = seen.options[0]!;
    const env = o.env as Record<string, string>;
    for (const k of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
    ])
      expect(k in env, `${k} must not reach the binary`).toBe(false);
    // ggui#1278 — an allowlist, not a denylist: nothing else the parent held gets through.
    for (const k of ["OPENAI_API_KEY", "GITHUB_TOKEN", "CLAUDE_CODE_USE_BEDROCK"])
      expect(k in env, `${k} must not reach the binary`).toBe(false);
    expect(env.PATH).toBe("/usr/bin");
    expect(o.tools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    // `--no-bare` is NOT passed: the SDK's bundled binary (2.1.229) rejects it (measured 2026-09-21).
    expect(o.extraArgs).toBeUndefined();
    expect(o.model).toBe("claude-haiku-4-5-20251001");
  });

  it("reports itself available on the login path even with no key anywhere", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    try {
      expect(
        new ClaudeSdkAdapter({ env: {} }).isAvailable(),
        "control: no key, no login → unavailable"
      ).toBe(false);
      expect(new ClaudeSdkAdapter({ claudeCodeLogin: true, env: {} }).isAvailable()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("off the login path the env is passed as configured, and the tool surface is still pinned: no built-ins, no host settings, no bypass (ggui#1714)", async () => {
    const adapter = new ClaudeSdkAdapter({
      env: { ANTHROPIC_API_KEY: "sk-ant-real", PATH: "/usr/bin" },
    });
    await adapter.generate(PARAMS).catch(() => undefined);
    const o = seen.options[0]!;
    expect((o.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("sk-ant-real");
    expect(o.tools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.permissionMode).toBeUndefined();
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
    expect(o.extraArgs).toBeUndefined();
  });

  it("a caller's own MCP servers are approved server-wide; built-ins come only by opt-in, and are approved with them (ggui#1714)", async () => {
    const server = { type: "stdio" as const, command: "node" };
    await new ClaudeSdkAdapter({ env: {}, mcpServers: { app: server } }).generate(PARAMS).catch(() => undefined);
    await new ClaudeSdkAdapter({ env: {}, mcpServers: { app: server }, builtinTools: ["Write"] }).generate(PARAMS).catch(() => undefined);
    const [plain, optedIn] = seen.options;
    expect(plain!.allowedTools).toEqual(["mcp__app"]);
    expect(plain!.tools).toEqual([]);
    expect(optedIn!.tools).toEqual(["Write"]);
    expect(optedIn!.allowedTools).toEqual(["mcp__app", "Write"]);
  });

  it("with no built-in Write, the source comes from the bridged compile_component call (ggui#1714)", async () => {
    seen.before.push({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "mcp__ggui__compile_component", input: { code: "export default () => null;" } }] },
    }, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ success: true, compiledCode: "compiled" }) }] },
    });
    const result = await new ClaudeSdkAdapter({ env: {} }).generate(PARAMS);
    expect(result.sourceCode).toBe("export default () => null;");
  });
});
