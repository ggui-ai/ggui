/**
 * Full-worker entry for `guuey dev --serve` (claude-agent-sdk needs worker
 * mode — graceful `agent.entry` is google-adk-only under dev-serve). One
 * Claude Agent SDK `query()` per invoke; every native SDKMessage streams to
 * the router over fd-3 via `emit.native`. Option spellings mirror
 * `@guuey/host`'s `buildOptions` and the `@guuey/create-agentic-app` claude
 * worker — the platform's own consumers of this exact snapshot shape.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { serveNative, listCredentials } from "@guuey/worker";

/** `GUUEY_AGENT_SNAPSHOT` (set by `guuey dev`, mcpServers lowered to external
 *  `{url, transport}` form) wins; the guuey.json beside this file is the
 *  fallback (e.g. the keyless `guuey worker verify` probe sets no snapshot). */
function loadAgent() {
  const env = process.env.GUUEY_AGENT_SNAPSHOT;
  if (env) return JSON.parse(env);
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, "guuey.json"), "utf8")).agent;
}

/** Endpoints = declared external entries ∪ broker credential files (credential
 *  wins per name; colocated/hosted are lowered to external before a worker runs). */
function mcpServers(invoke, agent) {
  const out = {};
  for (const [name, entry] of Object.entries(agent.mcpServers ?? {})) {
    if (entry === false || entry.kind !== "external") continue;
    // `alwaysLoad` — the declared servers ARE this agent's tool surface;
    // without it the CLI defers MCP tools behind its ToolSearch built-in
    // (absent here — `tools: []`), leaving the model tool-less.
    out[name] = { type: entry.transport ?? "http", url: entry.url, headers: entry.headers ?? {}, alwaysLoad: true };
  }
  for (const { name, cred } of listCredentials(invoke.fs)()) {
    out[name] = { type: cred.transport, url: cred.url, headers: cred.headers, alwaysLoad: true };
  }
  return out;
}

/** Fold prior turns into a prompt preamble (fresh-thread v1 history handling). */
function withHistory(invoke) {
  if (invoke.history.length === 0) return invoke.input;
  const lines = invoke.history.map((h) => `${h.role === "agent" ? "Assistant" : "User"}: ${h.text}`);
  return `<conversation_history>\n${lines.join("\n")}\n</conversation_history>\n\n${invoke.input}`;
}

await serveNative(
  async (invoke, emit) => {
    const agent = loadAgent();
    const servers = mcpServers(invoke, agent);
    let result = "";
    for await (const message of query({
      prompt: withHistory(invoke),
      options: {
        ...(agent.model ? { model: agent.model } : {}),
        ...(typeof agent.systemPrompt === "string" ? { systemPrompt: agent.systemPrompt } : {}),
        mcpServers: servers,
        // Same posture as `@guuey/host`: MCP tools allowlisted per server (the
        // SDK's interactive ask stage would silently deny them headless), no
        // built-ins, no machine settings, snapshot-declared servers only.
        allowedTools: agent.tools?.allowlist ?? Object.keys(servers).map((s) => `mcp__${s}`),
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        ...(agent.runtime?.maxTurns ? { maxTurns: agent.runtime.maxTurns } : {}),
      },
    })) {
      emit.native(JSON.parse(JSON.stringify(message)));
      if (message.type === "result" && message.subtype === "success") result = message.result;
    }
    return result;
  },
  { framework: "claude-agent-sdk", sdkName: "@anthropic-ai/claude-agent-sdk" }
);
