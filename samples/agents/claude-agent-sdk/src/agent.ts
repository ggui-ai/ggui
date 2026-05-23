/**
 * Claude Agent SDK loop wired to a ggui MCP server.
 *
 * The agent has no built-in tools; the only tools it can call are
 * the ggui_* MCP tools exposed by the server it's pointed at. The
 * LLM decides when to call ggui_new_session / ggui_handshake /
 * ggui_push / ggui_update / ggui_consume on its own based on the
 * tool descriptions returned by `tools/list`.
 *
 * This is what "Zero Agent Code" looks like in practice — the only
 * ggui-specific thing here is the MCP server URL.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { GGUI_AGENT_SYSTEM_PROMPT } from '@ggui-ai/protocol';

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

export interface RunAgentOptions {
  /** The user prompt to feed the agent. */
  readonly prompt: string;
  /** ggui MCP endpoint, e.g. `http://localhost:6781/mcp`. */
  readonly mcpUrl: string;
  /**
   * Optional secondary MCP endpoint exposing domain tools (e.g. a todo
   * server). When set, the agent registers it alongside the ggui MCP and
   * its tools are added to `allowedTools` so the LLM can call them.
   */
  readonly todoMcpUrl?: string;
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
}

/**
 * Default system prompt — re-exported from `@ggui-ai/protocol`.
 *
 * The canonical posture-only prompt for ggui-aware agents on raw SDK
 * hosts (Claude Agent SDK, OpenAI Assistants, etc.) where the host
 * lacks a built-in tool-use baseline. Posture-only by design: the
 * wire flow (new_session → handshake → push → consume → react, with
 * nextStep routing, etc.) is taught by the protocol's own
 * self-teaching surfaces:
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
 * The ggui MCP tools the LLM is allowed to invoke autonomously.
 * MCP tools are auto-namespaced by the SDK as `mcp__<server>__<tool>`.
 */
const GGUI_ALLOWED_TOOLS = [
  'mcp__ggui__ggui_new_session',
  'mcp__ggui__ggui_handshake',
  'mcp__ggui__ggui_push',
  'mcp__ggui__ggui_update',
  'mcp__ggui__ggui_emit',
  'mcp__ggui__ggui_consume',
  'mcp__ggui__ggui_close',
  'mcp__ggui__ggui_get_session',
  'mcp__ggui__ggui_get_stack',
];

/**
 * Domain tools on the optional todo MCP (sample-only).
 */
const TODO_ALLOWED_TOOLS = [
  'mcp__todo__todo_list',
  'mcp__todo__todo_add',
  'mcp__todo__todo_toggle',
  'mcp__todo__todo_delete',
];

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

  const bearer = opts.bearer ?? process.env.GGUI_MCP_BEARER ?? 'dev';

  const mcpServers: Record<
    string,
    { type: 'http'; url: string; headers?: Record<string, string> }
  > = {
    ggui: {
      type: 'http',
      url: opts.mcpUrl,
      headers: { Authorization: `Bearer ${bearer}` },
    },
  };
  if (opts.todoMcpUrl) {
    mcpServers.todo = { type: 'http', url: opts.todoMcpUrl };
  }

  const allowedTools = opts.todoMcpUrl
    ? [...GGUI_ALLOWED_TOOLS, ...TODO_ALLOWED_TOOLS]
    : GGUI_ALLOWED_TOOLS;

  const response = query({
    prompt: opts.prompt,
    options: {
      model: opts.model ?? 'claude-haiku-4-5',
      mcpServers,
      allowedTools,
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
      // (handshake + push + consume + handshake + push…).
      maxTurns: opts.maxTurns ?? 50,
      env: { ANTHROPIC_API_KEY: apiKey },
      // Run the agent loop via the SDK's bundled portable `cli.js` — see
      // CLAUDE_CLI_PATH. Avoids the native-binary lookup that hard-errors
      // when the platform-specific optional package isn't installed.
      pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
      executable: 'node',
      // Surface the bundled `claude` CLI subprocess's own stderr. The
      // agent loop runs inside that child process; without this a CLI
      // boot / MCP-connect / auth failure is an invisible hang on the
      // caller side.
      stderr: (data: string) => {
        process.stderr.write(`[agent-cli] ${data}`);
      },
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
