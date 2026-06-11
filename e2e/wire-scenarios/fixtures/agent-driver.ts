/**
 * Browserless driver for the `@ggui-ai/agent-server` sample backends.
 *
 * Since c711a9236 the sample agents are pure JSON backends — there is
 * NO chat textbox at `/` to type into. The drive path is the library's
 * own wire surface:
 *
 *   POST /auth/guest                  → mint {guestToken}
 *   POST /agent {kind:'chat', prompt} → SSE stream of normalized SDK
 *                                       messages (first event is
 *                                       `chat-allocated`)
 *
 * This fixture owns the three concerns the agent-integration scenarios
 * (06/07) share:
 *
 *   1. Spawning a sample agent (`pnpm --filter <pkg> start`) with its
 *      ports + env, and tearing down the whole process GROUP
 *      (SIGTERM → grace → SIGKILL). A bare SIGTERM lets the `pnpm`
 *      wrapper die while the `tsx` child keeps squatting the agent +
 *      sandbox-proxy ports, which EADDRINUSE-poisons the next spec's
 *      boot AND can latch a later run onto a stale half-dead agent.
 *   2. Minting a guest token and opening the `/agent` SSE stream.
 *   3. Narrowing the untrusted SSE frames into the normalized-message
 *      subset the tests assert on (tool-use tape + per-call MCP tool
 *      results). The SSE body is a trust boundary — every frame is
 *      validated structurally before it lands on the tape.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cleanEnv } from './clean-env.js';
import { OUTERMOST_WORKSPACE_ROOT } from './workspace-root.js';

// ── Sample-agent process management ──────────────────────────────────

export interface SpawnSampleAgentOptions {
  /** Workspace package name spawned via `pnpm --filter`. */
  readonly pkg: string;
  /** HTTP port the agent backend listens on (its `PORT` env). */
  readonly port: number;
  /**
   * Second-origin sandbox-proxy port (`SANDBOX_PROXY_PORT` env).
   * MUST be unique per spawned agent in the run: the samples ship
   * FIXED defaults (7790/7791/7792), so two agents booted with the
   * same default — or one booted while a stale predecessor still
   * holds the port — die with EADDRINUSE.
   */
  readonly sandboxProxyPort: number;
  /** ggui MCP endpoint the agent calls into (`GGUI_MCP_URL`). */
  readonly gguiMcpUrl: string;
  /** Optional todo MCP endpoint (`GGUI_TODO_MCP_URL`). */
  readonly todoMcpUrl?: string;
  /**
   * Expected `adapter.name` on the backend's `GET /` manifest
   * (`claude-agent-sdk` / `openai-agents-sdk` / `google-adk`).
   * Readiness-probe identity check: a STALE agent from a prior run
   * squatting the port answers the probe just like the fresh one —
   * our own child then dies with EADDRINUSE and the test silently
   * drives the stale process (observed live 2026-06-11: a leftover
   * claude agent on :6791 answered the openai row). Checking the
   * manifest name catches every cross-SDK latch; the same-SDK case
   * is caught by the child-exit race below.
   */
  readonly adapterName: string;
  /** Prefix for piped stdout/stderr lines. */
  readonly logLabel: string;
}

export interface SampleAgentHandle {
  /** Base URL of the agent backend (`http://localhost:<port>`). */
  readonly baseUrl: string;
  /** SIGTERM the process group, wait a grace period, then SIGKILL. */
  stop(): Promise<void>;
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/**
 * Spawn a sample agent backend and wait for its `GET /` manifest to
 * answer. Spawned from the OUTERMOST workspace root — `oss/` carries a
 * nested `pnpm-workspace.yaml`, so a `pnpm` run with CWD inside `oss/`
 * resolves the empty `oss/node_modules` and can't find the hoisted
 * `tsx` bin (see fixtures/workspace-root.ts).
 */
export async function spawnSampleAgent(
  opts: SpawnSampleAgentOptions,
): Promise<SampleAgentHandle> {
  const child: ChildProcess = spawn('pnpm', ['--filter', opts.pkg, 'start'], {
    cwd: OUTERMOST_WORKSPACE_ROOT,
    env: {
      ...cleanEnv(),
      PORT: String(opts.port),
      SANDBOX_PROXY_PORT: String(opts.sandboxProxyPort),
      GGUI_MCP_URL: opts.gguiMcpUrl,
      ...(opts.todoMcpUrl !== undefined
        ? { GGUI_TODO_MCP_URL: opts.todoMcpUrl }
        : {}),
    },
    stdio: 'pipe',
    // Own process group so stop() can signal the whole tree (the
    // `pnpm` wrapper + its `tsx`/node child).
    detached: true,
  });
  // Pipe both streams through. stderr surfaces boot failures; stdout
  // surfaces the agent's turn-by-turn activity — without it a stalled
  // round-trip is just a bare poll timeout with no clue whether the
  // agent called its tools.
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[${opts.logLabel}] ${chunk.toString()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[${opts.logLabel}] ${chunk.toString()}`);
  });

  let exited = false;
  let exitDescription = '';
  const exitPromise = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code, signal) => {
      exited = true;
      exitDescription = `code=${code} signal=${signal}`;
      reject(
        new Error(
          `${opts.pkg} exited (${exitDescription}) before becoming ready — ` +
            `is :${opts.port} or :${opts.sandboxProxyPort} already held by a ` +
            `stale agent from a prior run?`,
        ),
      );
    });
  });
  // Keep the rejection observed even after boot succeeds (the child
  // exiting LATER — teardown — must not surface as an unhandled
  // rejection).
  exitPromise.catch(() => undefined);

  const baseUrl = `http://localhost:${opts.port}`;
  // Race readiness against child death: when the port is squatted, the
  // probe gets answered by the SQUATTER while our child crashes with
  // EADDRINUSE — without the race that's a silent latch onto a stale
  // process.
  await Promise.race([waitForUrl(`${baseUrl}/`, 30_000), exitPromise]);

  // Identity check — the manifest's `name` is the adapter name.
  const manifestResp = await fetch(`${baseUrl}/`);
  const manifest: unknown = await manifestResp.json();
  const manifestName =
    isRecord(manifest) && typeof manifest.name === 'string'
      ? manifest.name
      : '<missing>';
  if (manifestName !== opts.adapterName) {
    throw new Error(
      `agent on :${opts.port} reports adapter '${manifestName}', expected ` +
        `'${opts.adapterName}' — a stale agent from a prior run is squatting ` +
        `the port.`,
    );
  }
  if (exited) {
    throw new Error(
      `${opts.pkg} exited (${exitDescription}) right after the readiness ` +
        `probe — a stale agent on :${opts.port} answered it instead.`,
    );
  }

  return {
    baseUrl,
    async stop() {
      const pid = child.pid;
      if (pid === undefined || exited) return;
      // SIGTERM the whole process group (negative pid) so the `pnpm`
      // wrapper AND its `tsx`/node child both die. Fall back to a
      // direct kill if the group signal fails.
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      const deadline = Date.now() + 2_000;
      while (!exited && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!exited) {
        // Hard-kill survivors — a SIGTERM-eating wrapper otherwise
        // leaves its child squatting the agent + sandbox ports.
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* whole group already exited between the check and the kill */
        }
      }
    },
  };
}

// ── Auth ─────────────────────────────────────────────────────────────

/**
 * Mint a guest token via the agent backend's guest-token auth adapter
 * (`POST /auth/guest`). Every `/agent` call requires a bearer.
 */
export async function mintGuestToken(baseUrl: string): Promise<string> {
  const resp = await fetch(`${baseUrl}/auth/guest`, { method: 'POST' });
  if (!resp.ok) {
    throw new Error(
      `POST /auth/guest failed: HTTP ${resp.status} ${resp.statusText}`,
    );
  }
  const body: unknown = await resp.json();
  if (
    body === null ||
    typeof body !== 'object' ||
    typeof (body as { guestToken?: unknown }).guestToken !== 'string'
  ) {
    throw new Error(
      `POST /auth/guest: response missing string guestToken: ${JSON.stringify(body)}`,
    );
  }
  return (body as { guestToken: string }).guestToken;
}

// ── Normalized SSE message tape ──────────────────────────────────────

/**
 * Validated subset of the agent-server's NormalizedMessage content
 * blocks that the scenarios assert on. Re-declared here (rather than
 * imported from `@ggui-ai/agent-server`) because the SSE body is this
 * suite's untrusted wire boundary — the parser below narrows each
 * frame structurally instead of trusting a compile-time import.
 */
export type AgentContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | { readonly type: 'tool_result'; readonly tool_use_id: string };

/**
 * Full MCP `CallToolResult` the adapter attached as `tool_use_result`
 * on a user/tool_result message (same generic-envelope style as
 * `JsonRpcResponse` in fixtures/mcp-client.ts).
 */
export interface AgentToolUseResult {
  readonly structuredContent?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
  readonly isError?: boolean;
}

export interface AgentSseMessage {
  /** `assistant` | `user` | `result` (others pass through verbatim). */
  readonly type: string;
  readonly content: ReadonlyArray<AgentContentBlock>;
  /** Present on user/tool_result messages when the adapter forwarded
   *  the full MCP CallToolResult. */
  readonly toolUseResult?: AgentToolUseResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseContentBlock(raw: unknown): AgentContentBlock | null {
  if (!isRecord(raw)) return null;
  if (raw.type === 'text' && typeof raw.text === 'string') {
    return { type: 'text', text: raw.text };
  }
  if (
    raw.type === 'tool_use' &&
    typeof raw.id === 'string' &&
    typeof raw.name === 'string'
  ) {
    return {
      type: 'tool_use',
      id: raw.id,
      name: raw.name,
      input: isRecord(raw.input) ? raw.input : {},
    };
  }
  if (raw.type === 'tool_result' && typeof raw.tool_use_id === 'string') {
    return { type: 'tool_result', tool_use_id: raw.tool_use_id };
  }
  return null;
}

function parseToolUseResult(raw: unknown): AgentToolUseResult | undefined {
  if (!isRecord(raw)) return undefined;
  const out: {
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
    isError?: boolean;
  } = {};
  if (isRecord(raw.structuredContent)) {
    out.structuredContent = raw.structuredContent;
  }
  if (isRecord(raw._meta)) out._meta = raw._meta;
  if (typeof raw.isError === 'boolean') out.isError = raw.isError;
  return out;
}

/**
 * Narrow one parsed SSE `message` event into the tape shape. Returns
 * `null` for frames that don't carry any block the tests read (e.g.
 * `result` end-markers without content) — they stay off the tape.
 */
function parseAgentSseMessage(raw: unknown): AgentSseMessage | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  const message = isRecord(raw.message) ? raw.message : undefined;
  const rawContent = message !== undefined ? message.content : undefined;
  const content: AgentContentBlock[] = [];
  if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      const parsed = parseContentBlock(block);
      if (parsed) content.push(parsed);
    }
  }
  const toolUseResult = parseToolUseResult(raw.tool_use_result);
  if (content.length === 0 && toolUseResult === undefined) return null;
  return {
    type: raw.type,
    content,
    ...(toolUseResult !== undefined ? { toolUseResult } : {}),
  };
}

// ── Chat stream ──────────────────────────────────────────────────────

export interface AgentChatStream {
  /** Live append-only tape of validated `message` SSE events. */
  readonly messages: ReadonlyArray<AgentSseMessage>;
  /** Resolves when the SSE stream closes (turn over or aborted). */
  readonly done: Promise<void>;
  /** Last `error` SSE event the server emitted, if any. */
  streamError(): string | undefined;
  /** Abort the HTTP stream — the server aborts the in-flight turn. */
  abort(): void;
  /**
   * Poll the tape until `pick` returns a value. Rejects with `label` +
   * a tool-name dump after `timeoutMs` so a stalled agent turn fails
   * with an actionable message instead of a bare timeout.
   */
  waitFor<T>(
    pick: (messages: ReadonlyArray<AgentSseMessage>) => T | undefined,
    timeoutMs: number,
    label: string,
  ): Promise<T>;
}

export interface StartChatOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly prompt: string;
  readonly chatId?: string;
}

/**
 * Open a `POST /agent {kind:'chat'}` SSE stream and parse it into a
 * live message tape. The fetch promise resolves once response headers
 * arrive; body frames accumulate in the background until `done`.
 */
export async function startChat(
  opts: StartChatOptions,
): Promise<AgentChatStream> {
  const controller = new AbortController();
  const resp = await fetch(`${opts.baseUrl}/agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify({
      kind: 'chat',
      prompt: opts.prompt,
      ...(opts.chatId !== undefined ? { chatId: opts.chatId } : {}),
    }),
    signal: controller.signal,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `POST /agent failed: HTTP ${resp.status} ${resp.statusText}: ${text}`,
    );
  }
  const body = resp.body;
  if (!body) {
    throw new Error('POST /agent: response has no body stream');
  }

  const messages: AgentSseMessage[] = [];
  let lastError: string | undefined;

  const done = (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          handleFrame(frame);
          split = buffer.indexOf('\n\n');
        }
      }
    } catch (err) {
      // An abort tears the reader down mid-read — expected on
      // `stream.abort()`. Anything else is a transport failure the
      // assertions should surface via streamError().
      if (!controller.signal.aborted) {
        lastError =
          err instanceof Error ? err.message : String(err);
      }
    }
  })();

  function handleFrame(frame: string): void {
    const lines = frame.split('\n');
    const eventName =
      lines
        .find((l) => l.startsWith('event:'))
        ?.slice('event:'.length)
        .trim() ?? 'message';
    const dataLine = lines.find((l) => l.startsWith('data:'));
    if (dataLine === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLine.slice('data:'.length).trim());
    } catch {
      // Malformed frame — record it; assertions read streamError().
      lastError = `malformed SSE data frame: ${dataLine.slice(0, 200)}`;
      return;
    }
    if (eventName === 'error') {
      lastError = JSON.stringify(parsed);
      return;
    }
    if (eventName !== 'message') return; // chat-allocated etc.
    const msg = parseAgentSseMessage(parsed);
    if (msg) messages.push(msg);
  }

  return {
    messages,
    done,
    streamError: () => lastError,
    abort: () => controller.abort(),
    async waitFor<T>(
      pick: (msgs: ReadonlyArray<AgentSseMessage>) => T | undefined,
      timeoutMs: number,
      label: string,
    ): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = pick(messages);
        if (found !== undefined) return found;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(
        `waitFor(${label}) timed out after ${timeoutMs}ms; ` +
          `tape tool calls: [${toolNames(messages).join(', ')}]` +
          (lastError !== undefined ? `; streamError: ${lastError}` : ''),
      );
    },
  };
}

// ── Tape readers ─────────────────────────────────────────────────────

export interface AgentToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** Every tool_use block on the tape, in arrival order. */
export function toolUses(
  messages: ReadonlyArray<AgentSseMessage>,
): ReadonlyArray<AgentToolUse> {
  const out: AgentToolUse[] = [];
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === 'tool_use') {
        out.push({ id: block.id, name: block.name, input: block.input });
      }
    }
  }
  return out;
}

/** Names of every tool_use on the tape, in arrival order. */
export function toolNames(
  messages: ReadonlyArray<AgentSseMessage>,
): ReadonlyArray<string> {
  return toolUses(messages).map((u) => u.name);
}

/**
 * The full MCP CallToolResult paired with a given tool_use id. Each
 * normalized user message carries one tool_result block plus the
 * sibling `tool_use_result` for that same call (the adapters forward
 * SDK tool results one per message), so matching the block's
 * `tool_use_id` identifies the sibling unambiguously.
 */
export function toolResultFor(
  messages: ReadonlyArray<AgentSseMessage>,
  toolUseId: string,
): AgentToolUseResult | undefined {
  for (const m of messages) {
    if (m.type !== 'user') continue;
    const matches = m.content.some(
      (block) =>
        block.type === 'tool_result' && block.tool_use_id === toolUseId,
    );
    if (matches) return m.toolUseResult;
  }
  return undefined;
}
