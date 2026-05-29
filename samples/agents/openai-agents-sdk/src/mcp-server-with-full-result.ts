/**
 * Subclass of `MCPServerStreamableHttp` that preserves the FULL MCP
 * `CallToolResult` (including `structuredContent` and `_meta`) on a
 * per-instance FIFO queue, alongside returning the SDK's expected
 * content-only shape.
 *
 * Why this exists: the OpenAI Agents SDK's MCP integration (see
 * `@openai/agents-core/dist/shims/mcp-server/node.js` →
 * `callTool`) extracts only `parsed.content` from the upstream MCP
 * response — `structuredContent` + `_meta` are dropped at the SDK
 * boundary. That hides the spec-canonical MCP-Apps extension fields
 * (`_meta.ui.resourceUri`, `_meta.ui.displayMode`) the frontend hook
 * needs to mount iframes.
 *
 * Implementation: override `callTool` to issue our own JSON-RPC
 * `tools/call` via `fetch()` (no second round-trip — we REPLACE the
 * SDK's call, not add to it), capture the full result, enqueue it for
 * the normalizer in `agent.ts` to lift onto the `tool_use_result`
 * sibling field, then return only `result.content` to the SDK so its
 * downstream contract (`CallToolResultContent`) is unchanged.
 *
 * Correlation: `callTool` ⇄ `mcp_tool_output` is FIFO per-server (the
 * Agents SDK awaits each `callTool` before emitting the matching
 * output event). The normalizer dequeues in arrival order.
 *
 * Upstream tracking: OpenAI Agents SDK PR #1360 adds
 * `MCPServer.customDataExtractor` — a per-call hook that receives the
 * raw `CallToolResult` (`{resultMeta, structuredContent, isError,
 * toolOutput}`) and attaches the result to
 * `RunToolCallOutputItem.customData`. When that PR lands + ships,
 * this entire file (~220 LOC) + the dequeue logic in `agent.ts` can
 * be replaced by a small `customDataExtractor` callback.
 *
 *   PR: https://github.com/openai/openai-agents-js/pull/1360
 *
 * Earlier attempts to expose `structuredContent` were reverted
 * (PR #471 → PR #553) citing user-reported breakage; the strip is
 * the SDK's intentional contract today. See research at
 * `/workspaces/ggui-workspace/...` (Phase 2 — OpenAI SDK deep
 * research) for the full audit. Subclass-and-override of
 * `MCPServerStreamableHttp` IS the sanctioned extension point
 * (`MCPServer` is a public exported interface; `BaseMCPServer*` are
 * abstract).
 */
import { MCPServerStreamableHttp } from '@openai/agents';

export interface McpCallToolResult {
  readonly content?: ReadonlyArray<unknown>;
  readonly structuredContent?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

/**
 * Per-server FIFO queue of full MCP CallToolResult objects. The
 * subclass writes to this queue from `callTool`; the agent
 * normalizer drains it in arrival order when emitting `tool_output`
 * events. Map key = the SDK's server `name`.
 *
 * Module-scope (not per-instance) so the normalizer can look up by
 * server name without having to thread the subclass instance through
 * the event-stream loop.
 */
const fullResultQueues = new Map<string, McpCallToolResult[]>();

/**
 * Dequeue the next full MCP CallToolResult for the given server name.
 * Used by the agent normalizer to overlay the spec-canonical
 * extension fields (`structuredContent`, `_meta.ui.*`) onto the
 * outgoing `tool_use_result` slice on each tool_output event.
 *
 * Returns `undefined` when the queue is empty — typically means the
 * tool_output event came from a tool we didn't see called (impossible
 * in normal flow but defensive against SDK changes).
 */
export function dequeueFullResult(
  serverName: string,
): McpCallToolResult | undefined {
  return fullResultQueues.get(serverName)?.shift();
}

/**
 * Per-instance fetch parameters captured at construction so the
 * subclass's own `tools/call` can use the same URL + bearer auth the
 * SDK's underlying client uses. Required because the SDK doesn't
 * expose its raw transport.
 */
export interface FullResultServerOptions {
  readonly url: string;
  readonly name: string;
  readonly bearer: string;
}

/**
 * Drop-in replacement for `MCPServerStreamableHttp` that publishes
 * full results onto `fullResultQueues`. Pass the resulting instance
 * to `new Agent({ mcpServers: [...] })` like the unwrapped class.
 */
export class FullResultMcpServerStreamableHttp extends MCPServerStreamableHttp {
  private readonly fetchUrl: string;
  private readonly serverName: string;
  private readonly authHeader: string;
  /**
   * Monotonically-increasing JSON-RPC id per instance. Started at a
   * large arbitrary offset so collisions with the SDK's own
   * connect-time `initialize` / `tools/list` ids on this connection
   * are impossible. (We use a separate fetch, not the SDK's session,
   * so collisions wouldn't actually break anything — kept distinct
   * for clean log diffing.)
   */
  private nextRpcId: number = 1_000_000;

  constructor(opts: FullResultServerOptions) {
    super({
      url: opts.url,
      name: opts.name,
      requestInit: { headers: { Authorization: `Bearer ${opts.bearer}` } },
    });
    this.fetchUrl = opts.url;
    this.serverName = opts.name;
    this.authHeader = `Bearer ${opts.bearer}`;
  }

  /**
   * Replace the base `callTool` entirely. We don't call the SDK's
   * underlying transport at all — the SDK's `callTool` would just
   * strip the response to `parsed.content` and we lose `_meta`.
   * Issue our own JSON-RPC `tools/call`, keep the full result
   * (queued for the normalizer), return content only to the SDK.
   *
   * MCP `meta` parameter is forwarded verbatim onto the request's
   * `params._meta` slice — preserves any `_meta` slices the SDK
   * builds (e.g. `ai.ggui/host-session` request-side meta when wired).
   */
  override async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
  ): Promise<Array<{ readonly type: string; readonly text: string }>> {
    const rpcId = this.nextRpcId++;
    const params: {
      name: string;
      arguments: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    } = {
      name: toolName,
      arguments: args ?? {},
    };
    if (meta != null) params._meta = meta;

    const response = await fetch(this.fetchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: this.authHeader,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        method: 'tools/call',
        params,
      }),
    });
    const text = await response.text();
    const rpc = parseMcpResponse(text);

    // JSON-RPC error envelope. Throw so the SDK's `errorFunction`
    // path triggers — matches the contract of the base class's
    // `callTool`, which throws on transport / parse errors.
    if (
      rpc !== null &&
      typeof rpc === 'object' &&
      'error' in rpc &&
      (rpc as { error?: { message?: string } }).error
    ) {
      const errMsg = String(
        (rpc as { error?: { message?: string } }).error?.message ??
          'MCP tools/call returned error envelope',
      );
      throw new Error(`MCP tools/call ${toolName} failed: ${errMsg}`);
    }
    const result = (rpc as { result?: McpCallToolResult }).result;
    if (!result || typeof result !== 'object') {
      throw new Error(
        `MCP tools/call ${toolName} returned no result envelope (got ${typeof result})`,
      );
    }

    // Enqueue the full result for the agent normalizer. FIFO order
    // matches the Agents SDK's `callTool` ⇄ `mcp_tool_output` event
    // ordering (each call awaited before the next).
    const queue = fullResultQueues.get(this.serverName) ?? [];
    queue.push(result);
    fullResultQueues.set(this.serverName, queue);

    // The Agents SDK only consumes `.content` from `callTool` —
    // narrow to that contract. (The base shim does
    // `return content.length === 1 ? content[0] : content`, but the
    // public `BaseMCPServerStreamableHttp.callTool` interface is
    // `Promise<CallToolResultContent>` — i.e. the array — so we
    // return the array; the public wrapper preserves it.)
    const content = Array.isArray(result.content) ? result.content : [];
    return content as Array<{ readonly type: string; readonly text: string }>;
  }
}

/**
 * The ggui MCP server speaks streamable-HTTP — depending on the
 * negotiated Accept header, the response is either:
 *   - `application/json` — a single JSON-RPC envelope; just parse it.
 *   - `text/event-stream` — one or more `event: message\ndata: <JSON>`
 *     frames; we expect exactly one for a tools/call.
 *
 * Lifted from `server.ts`'s `parseMcpResponse` (the relay handler does
 * the same parse for iframe-issued tools/call). Returns a synthetic
 * error envelope on parse failure so the caller's error path stays
 * uniform.
 */
function parseMcpResponse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { jsonrpc: '2.0', error: { message: 'empty MCP response' } };
  }
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const dataLine = trimmed
      .split('\n')
      .find((line) => line.startsWith('data:'));
    if (dataLine === undefined) {
      return { jsonrpc: '2.0', error: { message: 'SSE without data frame' } };
    }
    try {
      return JSON.parse(dataLine.slice('data:'.length).trim());
    } catch (err) {
      return {
        jsonrpc: '2.0',
        error: { message: `SSE JSON parse failed: ${(err as Error).message}` },
      };
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    return {
      jsonrpc: '2.0',
      error: { message: `JSON parse failed: ${(err as Error).message}` },
    };
  }
}
