/**
 * Minimal MCP client helpers — issue a `tools/call` / `resources/read`
 * JSON-RPC request against a Streamable HTTP endpoint, parse the
 * negotiated response (either `application/json` or `text/event-stream`
 * with a single `data:` frame).
 *
 * Kept self-contained because the library can't pull in
 * `@modelcontextprotocol/sdk` without inheriting its full client +
 * transport machinery, which is overkill for the two server-to-server
 * RPCs this package needs. Three call sites total:
 *
 *   1. `POST /agent` tool-result interceptor — `resources/read` to
 *      inline the iframe HTML for a `_meta.ui.resourceUri`.
 *   2. (Future) MCP discovery — `tools/list` to learn what each
 *      configured server exposes.
 *   3. (Removed) `/relay/resources-read` — replaced by the
 *      interceptor inlining the resource alongside the tool result.
 *
 * The `tools/call` relay (iframe → host → MCP) is still served
 * directly out of the Hono app at `POST /agent/relay/tools-call`; it
 * uses {@link parseMcpResponse} on the upstream body.
 */

/**
 * Parse a streamable-HTTP MCP response body. Returns the inner
 * JSON-RPC envelope (success or error). Always returns SOMETHING — on
 * parse failure we synthesize a JSON-RPC-shaped error envelope so the
 * caller's error handling stays uniform.
 */
export function parseMcpResponse(text: string): {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string; readonly code?: number };
} {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { jsonrpc: '2.0', error: { message: 'empty MCP response' } };
  }
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const dataLine = trimmed
      .split('\n')
      .find((line) => line.startsWith('data:'));
    if (dataLine === undefined) {
      return {
        jsonrpc: '2.0',
        error: { message: 'SSE without data frame' },
      };
    }
    try {
      return JSON.parse(dataLine.slice('data:'.length).trim()) as ReturnType<
        typeof parseMcpResponse
      >;
    } catch (err) {
      return {
        jsonrpc: '2.0',
        error: {
          message: `SSE JSON parse failed: ${(err as Error).message}`,
        },
      };
    }
  }
  try {
    return JSON.parse(trimmed) as ReturnType<typeof parseMcpResponse>;
  } catch (err) {
    return {
      jsonrpc: '2.0',
      error: { message: `JSON parse failed: ${(err as Error).message}` },
    };
  }
}

/**
 * Per-process JSON-RPC id counter. MCP requires unique ids per
 * connection; we open a fresh connection per call so collisions
 * across calls are harmless, but a monotonically-increasing id keeps
 * logs / debug output diffable.
 */
let nextRpcId = 1;

/**
 * Issue a `resources/read` JSON-RPC call against an MCP endpoint with
 * the given bearer auth. Returns the inner MCP `ReadResourceResult`
 * (a `{contents: [{uri, mimeType?, text?, ...}]}` envelope) on
 * success, or throws on RPC error / transport failure.
 */
export async function callMcpResourcesRead(args: {
  readonly url: string;
  readonly bearer: string;
  readonly uri: string;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly contents: ReadonlyArray<{
    readonly uri: string;
    readonly mimeType?: string;
    readonly text?: string;
    readonly blob?: string;
    readonly _meta?: Record<string, unknown>;
  }>;
}> {
  const rpcId = nextRpcId++;
  const response = await fetch(args.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${args.bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'resources/read',
      params: { uri: args.uri },
    }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const text = await response.text();
  const rpc = parseMcpResponse(text);
  if (rpc.error !== undefined) {
    throw new Error(
      `MCP resources/read for ${args.uri} failed: ${rpc.error.message ?? 'no message'}`,
    );
  }
  const result = rpc.result as
    | {
        readonly contents?: ReadonlyArray<{
          readonly uri?: unknown;
          readonly mimeType?: unknown;
          readonly text?: unknown;
          readonly blob?: unknown;
          readonly _meta?: unknown;
        }>;
      }
    | undefined;
  if (!result || !Array.isArray(result.contents)) {
    throw new Error(
      `MCP resources/read for ${args.uri} returned no contents envelope`,
    );
  }
  // Narrow the wire shape to our typed return.
  const contents = result.contents.map((c) => {
    const out: {
      uri: string;
      mimeType?: string;
      text?: string;
      blob?: string;
      _meta?: Record<string, unknown>;
    } = {
      uri: typeof c.uri === 'string' ? c.uri : args.uri,
    };
    if (typeof c.mimeType === 'string') out.mimeType = c.mimeType;
    if (typeof c.text === 'string') out.text = c.text;
    if (typeof c.blob === 'string') out.blob = c.blob;
    if (c._meta !== null && typeof c._meta === 'object') {
      out._meta = c._meta as Record<string, unknown>;
    }
    return out;
  });
  return { contents };
}

/**
 * Issue a `tools/call` JSON-RPC against an MCP endpoint. Returns the
 * parsed JSON-RPC envelope (caller handles error envelopes); kept
 * generic because the iframe → host relay forwards the result body
 * back to the browser as-is.
 */
export async function callMcpToolsCall(args: {
  readonly url: string;
  readonly bearer: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}): Promise<ReturnType<typeof parseMcpResponse>> {
  const rpcId = nextRpcId++;
  const params: {
    name: string;
    arguments: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  } = {
    name: args.name,
    arguments: args.arguments,
  };
  if (args.meta !== undefined) params._meta = args.meta;
  const response = await fetch(args.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${args.bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'tools/call',
      params,
    }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const text = await response.text();
  return parseMcpResponse(text);
}
