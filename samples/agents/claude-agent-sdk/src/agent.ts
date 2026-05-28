/**
 * Claude Agent SDK loop wired to a ggui MCP server.
 *
 * The agent has no built-in tools; the only tools it can call are
 * the ggui_* MCP tools exposed by the server it's pointed at. The
 * LLM decides when to call ggui_handshake / ggui_render / ggui_update /
 * ggui_consume on its own based on the tool descriptions returned by
 * `tools/list`.
 *
 * This is what "Zero Agent Code" looks like in practice — the only
 * ggui-specific thing here is the MCP server URL.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  query,
  type SDKMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { GGUI_AGENT_SYSTEM_PROMPT } from '@ggui-ai/protocol';
import type { GguiUserActionMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { synthesizeUserActionPrompt } from './user-action-bridge.js';

/**
 * Locate the Claude Agent SDK's bundled `cli.js`.
 *
 * The SDK ships a portable `#!/usr/bin/env node` `cli.js` AND optional
 * platform-native `claude` binaries (`@anthropic-ai/claude-agent-sdk-<plat>`).
 * Its default lookup prefers the native binary and hard-errors when the
 * matching optional package didn't install — which happens in CI / any
 * environment where the libc-specific variant isn't resolved. Pinning
 * `pathToClaudeCodeExecutable` at the bundled `cli.js` runs the agent
 * loop on plain Node everywhere, with no native-binary dependency.
 *
 * Two SDK versions coexist in this workspace — `0.2.76` (with bundled
 * `cli.js`) is pinned here; `0.2.123` (no bundled `cli.js`, uses
 * platform-native bins) is pulled in by `@ggui-ai/ui-gen`. pnpm in
 * hoisted mode places one at root, the other nested, and the choice
 * can flip between pnpm patch versions. So instead of trusting a
 * single resolved path, walk the `node_modules` chain upward and
 * accept the first SDK copy that actually contains `cli.js`.
 */
function resolveClaudeCliPath(): string {
  const tried: string[] = [];
  const startDir = dirname(fileURLToPath(import.meta.url));
  let dir = startDir;
  // Bounded walk — at most a handful of node_modules ancestors in practice.
  for (let depth = 0; depth < 20; depth++) {
    const candidates = [
      // Same dir as the SDK that `require.resolve` picks from this level.
      tryResolveSdkDir(dir),
      // Direct nested copy under this dir's node_modules (pnpm hoisted mode
      // sometimes places version-conflicted copies here even when the
      // resolver would walk up).
      join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'),
    ];
    for (const sdkDir of candidates) {
      if (!sdkDir) continue;
      const cli = join(sdkDir, 'cli.js');
      if (!tried.includes(cli)) tried.push(cli);
      if (existsSync(cli)) return cli;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate @anthropic-ai/claude-agent-sdk/cli.js. ` +
      `Checked ${tried.length} candidate path(s):\n  ${tried.join('\n  ')}`,
  );
}

function tryResolveSdkDir(fromDir: string): string | null {
  try {
    const req = createRequire(join(fromDir, 'noop.js'));
    return dirname(req.resolve('@anthropic-ai/claude-agent-sdk'));
  } catch {
    return null;
  }
}

const CLAUDE_CLI_PATH = resolveClaudeCliPath();

/**
 * Spawn the SDK's CLI subprocess using `process.execPath` (the absolute
 * path to the current Node binary) rather than letting the SDK do its
 * default `spawn('node', ...)`.
 *
 * The SDK's `executable: 'node'` option resolves to `spawn('node', ...)`,
 * which depends on `node` being on the child's `PATH`. In CI runs that
 * spawn through pnpm → vite → tsx, the child's PATH has been observed
 * to omit the setup-node toolcache dir, causing `ENOENT` at spawn time
 * with a misleading "Claude Code executable not found at <cli.js>"
 * error. Using `process.execPath` bypasses the PATH lookup — same
 * Node binary, absolute path, no environment dependency.
 *
 * Returns Node's `ChildProcess`, which structurally satisfies the
 * SDK's `SpawnedProcess` interface.
 */
function spawnClaudeCli(opts: SpawnOptions): SpawnedProcess {
  // Re-verify at spawn time so a missing cli.js surfaces with the
  // actual path checked, rather than as a misleading SDK ENOENT
  // (which can also fire on a missing `node` interpreter — different
  // root cause, same wording in the SDK's own error message).
  if (!existsSync(CLAUDE_CLI_PATH)) {
    throw new Error(
      `spawnClaudeCli: cli.js missing at spawn time — was present at module ` +
        `load but is gone now: ${CLAUDE_CLI_PATH}`,
    );
  }
  const child = spawn(process.execPath, [CLAUDE_CLI_PATH, ...opts.args], {
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Mirror the SDK's own stderr handling — the bundled CLI's startup
  // failures (missing dep, syntax error, MCP-connect crash) come out on
  // its stderr, and the caller wires `options.stderr` on the SDK side.
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[agent-cli] ${chunk.toString()}`);
  });
  const { stdin, stdout } = child;
  if (!stdin || !stdout) {
    // `stdio: ['pipe', 'pipe', 'pipe']` guarantees both at runtime —
    // narrow the nullable Node types into the SDK's non-null interface.
    throw new Error('spawnClaudeCli: child stdin/stdout missing despite pipe stdio');
  }
  return {
    stdin,
    stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    kill: child.kill.bind(child),
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
  };
}

/**
 * One MCP endpoint the agent's LLM is allowed to call into. Sample-only —
 * `transport` is omitted because every ggui MCP server speaks Streamable
 * HTTP and every supported SDK's MCP client defaults to it for `http(s)://`
 * URLs. Production code with mixed transports should grow a `transport`
 * field here.
 */
export interface McpServerConfig {
  readonly url: string;
}

export interface RunAgentOptions {
  /** The user prompt to feed the agent. */
  readonly prompt: string;
  /**
   * MCP endpoints the LLM can discover + call. Keys are user-chosen names
   * (`ggui`, `todo`, …); the SDK auto-namespaces tools as
   * `mcp__<key>__<tool>`. `ggui` is the conventional name for the primary
   * ggui MCP server; additional keys add domain MCPs alongside it.
   *
   * The `allowedTools` allowlist below recognises the conventional keys
   * (`ggui`, `todo`). To add a third MCP that the LLM should be allowed to
   * call, add its key here AND extend the allowlist mapping.
   */
  readonly mcpServers: Record<string, McpServerConfig>;
  /** Default `claude-haiku-4-5`. */
  readonly model?: string;
  /** Default `process.env.ANTHROPIC_API_KEY`. */
  readonly apiKey?: string;
  /** Default 20. Caps the tool-use loop so a misbehaving agent can't infinite-loop. */
  readonly maxTurns?: number;
  /**
   * Bearer token sent on every MCP request as `Authorization: Bearer <token>`.
   * Defaults to `process.env.GGUI_MCP_BEARER ?? 'dev'`. The default value
   * pairs with `ggui serve --dev-allow-all`, which accepts any non-empty
   * bearer. For strict-auth servers, supply a real pair-minted token.
   */
  readonly bearer?: string;
  /**
   * System prompt nudging the model to always reach for ggui_* tools
   * instead of plain-text replies. Without this, the default Claude
   * Code persona answers conversationally and never renders UIs.
   * Pass an explicit string to override, or `null` to disable entirely
   * (leaves the SDK's built-in default in place).
   */
  readonly systemPrompt?: string | null;
  /**
   * Cancellation surface. When the controller's signal aborts, the
   * SDK stops the in-flight `query` and tears down its subprocess.
   * The chat server creates one per /chat request and aborts on
   * client disconnect so a closed browser tab doesn't leak an agent
   * loop that keeps spending tokens.
   */
  readonly abortController?: AbortController;
  /**
   * Per-tab chat identifier from the browser's
   * `X-Chat-Id` header (auto-minted server-side when absent).
   * Keys per-chat agent state — conversation history, resume tokens,
   * ggui renderId continuity — so multi-turn flows preserve context
   * across `/chat` POSTs. Threaded through today; consumed by the
   * multi-turn-resume slice that passes Claude Agent SDK's
   * `options.resume` keyed by this id.
   */
  readonly chatId?: string;
  /**
   * Spec-canonical `_meta["ai.ggui/userAction"]` slice forwarded by
   * the frontend when a user gesture inside a rehydrated iframe
   * reached the host via `ui/message` (no active `ggui_consume`
   * long-poll to drain the pipe). See `synthesizeUserActionPrompt`
   * for the bridge that drains the pipe (when `kind: 'queued'`) and
   * synthesizes a structured prompt that delivers the action as
   * machine-extractable fields rather than LLM-parsed prose.
   *
   * Absent for ordinary user-typed chat messages — those go straight
   * through as `opts.prompt` unmodified.
   */
  readonly userAction?: GguiUserActionMeta;
}

/**
 * Per-process record of which chat ids have already produced
 * at least one Claude Agent SDK turn. Used to choose between
 * `options.sessionId` (first turn — create a new session under our
 * id) and `options.resume` (subsequent turn — load the persisted
 * conversation from `~/.claude/projects/`). Persistence note: the
 * Claude SDK saves sessions to disk, so after a process restart the
 * SET is empty but the on-disk session still exists. We accept that
 * one edge case — a tab's first POST after a server restart starts
 * a new session id collision with the on-disk one. The fall-back is
 * a fresh, isolated turn, never an error.
 */
const knownChats = new Set<string>();

/**
 * Default system prompt — re-exported from `@ggui-ai/protocol`.
 *
 * The canonical posture-only prompt for ggui-aware agents on raw SDK
 * hosts (Claude Agent SDK, OpenAI Assistants, etc.) where the host
 * lacks a built-in tool-use baseline. Posture-only by design: the
 * wire flow (handshake → render → consume → react, with nextStep
 * routing, etc.) is taught by the protocol's own self-teaching
 * surfaces:
 *
 *   - Per-tool `description` strings on every `ggui_*` MCP tool.
 *   - The server's `instructions` field on `InitializeResult` (set
 *     via `mcpInstructions` operator option in `@ggui-ai/mcp-server`).
 *
 * If an agent isn't calling the right sequence, the bug lives in
 * those surfaces — patching the agent-side system prompt is patching
 * the wrong layer.
 */
export const DEFAULT_SYSTEM_PROMPT = GGUI_AGENT_SYSTEM_PROMPT;

/**
 * Per-MCP-server allowlists, keyed by the `mcpServers` map key.
 * MCP tools are auto-namespaced by the SDK as `mcp__<server>__<tool>`.
 * To allow a new server, drop another entry here keyed by its `mcpServers`
 * map key.
 */
const ALLOWED_TOOLS_BY_SERVER: Record<string, ReadonlyArray<string>> = {
  ggui: [
    'mcp__ggui__ggui_handshake',
    'mcp__ggui__ggui_render',
    'mcp__ggui__ggui_update',
    'mcp__ggui__ggui_emit',
    'mcp__ggui__ggui_consume',
  ],
  todo: [
    'mcp__todo__todo_list',
    'mcp__todo__todo_add',
    'mcp__todo__todo_toggle',
    'mcp__todo__todo_delete',
  ],
};

export async function* runAgent(
  opts: RunAgentOptions,
): AsyncIterable<SDKMessage> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'runAgent: ANTHROPIC_API_KEY required (env var or apiKey option).',
    );
  }

  const systemPrompt =
    opts.systemPrompt === null
      ? undefined
      : (opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);

  // Host-session metadata (the `ai.ggui/host-session` slice on each
  // tools/call's request `_meta`) is the spec-canonical channel for
  // chat-grouping continuity — the Claude Agent SDK's MCP client
  // doesn't currently expose a per-call `_meta` hook for it. The
  // sample's GET /chat resume endpoint sidesteps the gap by keying
  // its own server-side per-chat snapshot off the X-Chat-Id header,
  // so the LLM never needs to thread the host-session itself.

  const bearer = opts.bearer ?? process.env.GGUI_MCP_BEARER ?? 'dev';

  // Translate the brand-agnostic `mcpServers` map into the Claude Agent
  // SDK's native shape (`{type:'http', url, headers}`). Bearer is applied
  // uniformly across every configured server — every ggui-served MCP in
  // this sample uses the same dev-mode auth.
  const sdkMcpServers: Record<
    string,
    { type: 'http'; url: string; headers?: Record<string, string> }
  > = {};
  for (const [name, cfg] of Object.entries(opts.mcpServers)) {
    sdkMcpServers[name] = {
      type: 'http',
      url: cfg.url,
      headers: { Authorization: `Bearer ${bearer}` },
    };
  }

  // Derive allowedTools from the configured server keys — adding a new
  // MCP only needs ALLOWED_TOOLS_BY_SERVER updated, not this loop.
  const allowedTools: string[] = [];
  for (const name of Object.keys(opts.mcpServers)) {
    const tools = ALLOWED_TOOLS_BY_SERVER[name];
    if (tools) allowedTools.push(...tools);
  }

  // Multi-turn session continuity. The Claude Agent SDK persists every
  // session to `~/.claude/projects/` and exposes two complementary
  // entry points on `options`:
  //
  //   - `sessionId: <UUID>` — start a new session with our id.
  //   - `resume: <UUID>`    — load the persisted history for that id.
  //
  // We use our caller's chat id (the per-tab UUID minted by
  // `useChat.ts` and forwarded as `X-Chat-Id`) as the SDK
  // session id, so the SDK's filesystem store is keyed by the same
  // identifier the browser uses. First call → sessionId; remembered in
  // a module-scope Set so subsequent calls → resume. Without a chat
  // id (raw curl callers) we let the SDK mint its own id; that
  // call won't be resumable from this server, but it still works.
  const chatId = opts.chatId;
  const sessionOptions: { resume?: string; sessionId?: string } = {};
  if (chatId) {
    if (knownChats.has(chatId)) {
      sessionOptions.resume = chatId;
    } else {
      sessionOptions.sessionId = chatId;
      knownChats.add(chatId);
    }
  }

  // When the frontend forwarded a `_meta["ai.ggui/userAction"]` slice
  // (rehydrated-iframe click without an active consume long-poll),
  // rewrite the user-facing prompt into a synthetic `ggui_consume`
  // return envelope. The LLM sees a familiar consume-shaped payload
  // — its existing `consume → domain-tool → ggui_update` loop takes
  // over without needing to natural-language-parse a renderId out of
  // prose. See `user-action-bridge.ts`.
  const gguiServerForBridge = opts.mcpServers.ggui;
  const promptForLlm =
    opts.userAction !== undefined && gguiServerForBridge !== undefined
      ? await synthesizeUserActionPrompt({
          originalPrompt: opts.prompt,
          userAction: opts.userAction,
          gguiMcpUrl: gguiServerForBridge.url,
          bearer,
        })
      : opts.prompt;

  const response = query({
    prompt: promptForLlm,
    options: {
      model: opts.model ?? 'claude-haiku-4-5',
      mcpServers: sdkMcpServers,
      allowedTools,
      ...sessionOptions,
      tools: [], // disable built-in tools — purely MCP
      // Isolation mode. The SDK's default is already "no filesystem
      // settings loaded" when `settingSources` is omitted, but we set
      // it explicitly to an empty array so a future SDK change can't
      // silently re-enable auto-discovery from `~/.claude/settings.json`
      // / `.claude/settings.json` / `.claude/settings.local.json`.
      // Together with `strictMcpConfig` this guarantees the sample
      // agent's tool catalog is exactly `mcpServers` above — no
      // claude.ai-hosted MCPs (Figma/Gmail/etc.) leaking in from the
      // operator's logged-in Claude Code account.
      settingSources: [],
      // Hard-fail if any `mcpServers` entry is malformed instead of
      // silently dropping it. Catches typos in URLs / headers early.
      strictMcpConfig: true,
      // 50 covers a handful of multi-turn user interactions per chat.
      // Each render+consume+react cycle is roughly 3-5 SDK turns
      // (handshake + render + consume + handshake + render…).
      maxTurns: opts.maxTurns ?? 50,
      env: { ANTHROPIC_API_KEY: apiKey },
      // Run the agent loop via the SDK's bundled portable `cli.js` — see
      // CLAUDE_CLI_PATH. Avoids the native-binary lookup that hard-errors
      // when the platform-specific optional package isn't installed.
      // The actual subprocess spawn goes through `spawnClaudeCodeProcess`
      // below — `pathToClaudeCodeExecutable` stays set so SDK internals
      // that read the path (logging, telemetry) still see the right value.
      pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
      // Custom-spawn the CLI through `process.execPath` so we don't
      // depend on `node` being on the child's `PATH`. The default
      // `spawn('node', ...)` has been observed to `ENOENT` in CI under
      // pnpm-script → vite → tsx execution chains, surfacing as a
      // misleading "Claude Code executable not found at <cli.js>" error.
      spawnClaudeCodeProcess: spawnClaudeCli,
      ...(systemPrompt ? { systemPrompt } : {}),
      // Cancellation. When the caller aborts (e.g. the chat server's
      // SSE listener detects the browser tab closed), the SDK stops
      // its in-flight query and tears down the subprocess. Without
      // this, a closed tab leaks the agent loop until maxTurns.
      ...(opts.abortController
        ? { abortController: opts.abortController }
        : {}),
    },
  });

  for await (const msg of response) {
    yield msg;
  }
}
