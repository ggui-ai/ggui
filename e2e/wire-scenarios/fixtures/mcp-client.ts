/**
 * Minimal JSON-RPC `tools/call` helper for the streamable-HTTP MCP
 * transport. Handles both the `application/json` direct response and
 * the `text/event-stream` framed response the SDK emits depending on
 * the negotiated Accept header.
 *
 * Returns the parsed JSON-RPC envelope verbatim (`{result, error,
 * jsonrpc, id}`). Tests then read `result.structuredContent` or
 * `error` as needed.
 *
 * No retries, no auth, no pooling — the e2e harness runs against
 * local `--dev-allow-all` servers and trades robustness for clarity.
 */

let nextRpcId = 1;

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: {
    readonly structuredContent?: Record<string, unknown>;
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    /** `resources/read` body. Each entry carries the resource's
     *  `uri`, optional `mimeType`, and either `text` or `blob`. */
    readonly contents?: ReadonlyArray<{
      readonly uri: string;
      readonly mimeType?: string;
      readonly text?: string;
      readonly blob?: string;
    }>;
    readonly isError?: boolean;
    readonly _meta?: Record<string, unknown>;
  };
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

/**
 * Call a tool via JSON-RPC `tools/call` against an MCP endpoint.
 *
 * @param mcpUrl - Full URL to the MCP endpoint (e.g. `http://localhost:6781/mcp`).
 * @param toolName - The tool's wire name.
 * @param args - Tool arguments, validated server-side against the tool's input schema.
 */
export async function callTool(
  mcpUrl: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<JsonRpcResponse> {
  const id = nextRpcId++;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });
  const resp = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body,
  });
  if (!resp.ok) {
    throw new Error(
      `callTool ${toolName}: HTTP ${resp.status} ${resp.statusText}`,
    );
  }
  const text = await resp.text();
  return parseMcpResponse(text);
}

/**
 * `tools/list` against an MCP endpoint — the host-side discovery a spec
 * MCP-Apps host performs, where the DECLARATION-level `_meta.ui.
 * resourceUri` (the static shell) is announced.
 */
export async function listTools(mcpUrl: string): Promise<JsonRpcResponse> {
  const id = nextRpcId++;
  const resp = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }),
  });
  if (!resp.ok) {
    throw new Error(`listTools: HTTP ${resp.status} ${resp.statusText}`);
  }
  return parseMcpResponse(await resp.text());
}

/**
 * Parse the MCP server's response body. Handles two shapes:
 *
 *   - `application/json` → JSON-RPC envelope as a flat object.
 *   - `text/event-stream` → SSE-framed (`event: message\ndata: …`)
 *     with the JSON-RPC envelope in the first event's `data`. The
 *     server emits this when the Accept header advertises both, and
 *     may put a `: keepalive` comment ahead of the frame on a long
 *     generation — comments and non-data fields are skipped.
 */
export function parseMcpResponse(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('MCP response: empty body');
  }
  if (!SSE_FIRST_LINE.test(trimmed)) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }
  const data = firstSseEventData(trimmed);
  if (data === undefined) {
    throw new Error('MCP response: SSE frame without data: line');
  }
  return JSON.parse(data) as JsonRpcResponse;
}

/**
 * A body is SSE when its first line is any SSE construct: a comment
 * (`: keepalive` — the server emits one ahead of the frame when a
 * generation runs long; SSE comments start with `:`), or an
 * `event:` / `data:` / `id:` / `retry:` field.
 */
const SSE_FIRST_LINE = /^(?::|event:|data:|id:|retry:)/;

/**
 * The first event's `data` per the SSE spec (WHATWG §9.2.6): comment
 * lines are skipped, fields other than `data` are ignored, several
 * `data:` lines join with `\n`, and a blank line ends the event.
 * `undefined` when no event carries data.
 */
function firstSseEventData(body: string): string | undefined {
  const dataLines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line === '') {
      if (dataLines.length > 0) break;
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      const value = line.slice('data:'.length);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  return dataLines.length > 0 ? dataLines.join('\n') : undefined;
}

/**
 * Fetch a resource by URI via JSON-RPC `resources/read`. Mirrors
 * {@link callTool}'s transport shape (streamable HTTP, both response
 * MIMEs). Returns the parsed JSON-RPC envelope; tests read
 * `result.contents` for the resource body.
 */
export async function readResource(
  mcpUrl: string,
  uri: string,
): Promise<JsonRpcResponse> {
  const id = nextRpcId++;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'resources/read',
    params: { uri },
  });
  const resp = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body,
  });
  if (!resp.ok) {
    throw new Error(
      `readResource ${uri}: HTTP ${resp.status} ${resp.statusText}`,
    );
  }
  return parseMcpResponse(await resp.text());
}

/**
 * Convenience: assert a JSON-RPC response is a success (no `error`,
 * `result.isError !== true`) and return its `result.structuredContent`.
 * Tests use this when they want the tool's typed output.
 */
export function unwrapStructured<T>(resp: JsonRpcResponse): T {
  if (resp.error !== undefined) {
    throw new Error(
      `MCP error (${resp.error.code}): ${resp.error.message}`,
    );
  }
  if (resp.result?.isError === true) {
    throw new Error(
      `MCP tool isError=true: ${JSON.stringify(resp.result.content)}`,
    );
  }
  const structured = resp.result?.structuredContent;
  if (structured === undefined) {
    throw new Error('MCP response missing structuredContent');
  }
  return structured as T;
}
