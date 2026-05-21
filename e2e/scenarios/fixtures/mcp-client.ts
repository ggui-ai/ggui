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
 * Parse the MCP server's response body. Handles two shapes:
 *
 *   - `application/json` → JSON-RPC envelope as a flat object.
 *   - `text/event-stream` → SSE-framed (`event: message\ndata: …`)
 *     with the JSON-RPC envelope in the `data:` line. SDK emits this
 *     when the Accept header advertises both.
 */
export function parseMcpResponse(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('MCP response: empty body');
  }
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const dataLine = trimmed
      .split('\n')
      .find((line) => line.startsWith('data:'));
    if (dataLine === undefined) {
      throw new Error('MCP response: SSE frame without data: line');
    }
    return JSON.parse(dataLine.slice('data:'.length).trim()) as JsonRpcResponse;
  }
  return JSON.parse(trimmed) as JsonRpcResponse;
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
