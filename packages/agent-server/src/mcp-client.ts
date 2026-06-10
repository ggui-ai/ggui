/**
 * Minimal MCP client helpers — issue a `tools/call` / `resources/read`
 * JSON-RPC request against a Streamable HTTP endpoint, parse the
 * negotiated response (either `application/json` or `text/event-stream`
 * with a single `data:` frame).
 *
 * Kept self-contained because the library can't pull in
 * `@modelcontextprotocol/sdk` without inheriting its full client +
 * transport machinery, which is overkill for the two server-to-server
 * RPCs this package needs. Call sites:
 *
 *   1. `GET /agent` rehydration + `POST /agent` tool-result interceptor
 *      — `resources/read` to inline the iframe HTML for a
 *      `_meta.ui.resourceUri` (fresh on replay, first-mount on live).
 *   2. `POST /agent { kind:'tool-call' }` — `tools/call` relay
 *      (iframe → host → MCP). The iframe holds no MCP credential; this
 *      host forwards the call and returns the JSON-RPC envelope.
 *   3. Boot-time MCP discovery — `initialize` (→ `serverInfo`) +
 *      `tools/list` (→ tool descriptors), folded by
 *      {@link buildAgentCatalog} into the canonical
 *      `AgentToolEntry` catalog the agent stamps into its handshake
 *      draft so reuse can match on `(serverInfo.name, toolName)`.
 *
 * Every RPC (`callMcpToolsCall`, `callMcpResourcesRead`,
 * `callMcpInitialize`, `callMcpToolsList`) uses
 * {@link parseMcpResponse} on the upstream body.
 */
import type { AgentToolEntry, JsonSchema } from '@ggui-ai/protocol';

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

/**
 * MCP wire-protocol version this client advertises in the `initialize`
 * handshake. Streamable-HTTP servers echo / negotiate it; `2025-06-18`
 * is the version the rest of this repo's clients speak (matches the
 * ggui MCP server + the sample smoke tests).
 */
const MCP_PROTOCOL_VERSION = '2025-06-18';

/** This client's identity, sent as `clientInfo` on `initialize`. */
const CLIENT_INFO = {
  name: '@ggui-ai/agent-server',
  // keep in sync with package.json version
  version: '0.3.0',
} as const;

/**
 * Issue an `initialize` JSON-RPC against an MCP endpoint and return the
 * server's identity (`serverInfo`). On stateless Streamable-HTTP the
 * `initialize` response carries `serverInfo` directly, so the
 * `notifications/initialized` follow-up isn't needed just to read it.
 * `(serverInfo.name, toolName)` is the canonical cross-framework tool
 * identity used by the reuse gate; `version` is metadata, not identity.
 */
export async function callMcpInitialize(args: {
  readonly url: string;
  readonly bearer: string;
  readonly signal?: AbortSignal;
}): Promise<{ name: string; version: string }> {
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
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const text = await response.text();
  const rpc = parseMcpResponse(text);
  if (rpc.error !== undefined) {
    throw new Error(
      `MCP initialize for ${args.url} failed: ${rpc.error.message ?? 'no message'}`,
    );
  }
  const result = rpc.result as
    | { readonly serverInfo?: { name?: unknown; version?: unknown } }
    | undefined;
  const serverInfo = result?.serverInfo;
  if (
    !serverInfo ||
    typeof serverInfo.name !== 'string' ||
    typeof serverInfo.version !== 'string'
  ) {
    throw new Error(
      `MCP initialize for ${args.url} returned no serverInfo {name, version}`,
    );
  }
  return { name: serverInfo.name, version: serverInfo.version };
}

/**
 * Issue a `tools/list` JSON-RPC against an MCP endpoint and return the
 * tool descriptors. Each descriptor mirrors the MCP `tools/list` entry:
 * `name` (the bare tool name), `inputSchema` (always present), plus
 * optional `description` / `outputSchema`.
 */
export async function callMcpToolsList(args: {
  readonly url: string;
  readonly bearer: string;
  readonly signal?: AbortSignal;
}): Promise<
  Array<{
    name: string;
    description?: string;
    inputSchema: JsonSchema;
    outputSchema?: JsonSchema;
  }>
> {
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
      method: 'tools/list',
      params: {},
    }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const text = await response.text();
  const rpc = parseMcpResponse(text);
  if (rpc.error !== undefined) {
    throw new Error(
      `MCP tools/list for ${args.url} failed: ${rpc.error.message ?? 'no message'}`,
    );
  }
  const result = rpc.result as
    | {
        readonly tools?: ReadonlyArray<{
          readonly name?: unknown;
          readonly description?: unknown;
          readonly inputSchema?: unknown;
          readonly outputSchema?: unknown;
        }>;
      }
    | undefined;
  if (!result || !Array.isArray(result.tools)) {
    throw new Error(`MCP tools/list for ${args.url} returned no tools array`);
  }
  // Narrow the wire shape to our typed return. A tool without a string
  // `name` or an object `inputSchema` is malformed for our purposes; the
  // MCP spec requires both, so skip anything that doesn't satisfy them.
  const tools: Array<{
    name: string;
    description?: string;
    inputSchema: JsonSchema;
    outputSchema?: JsonSchema;
  }> = [];
  for (const t of result.tools) {
    if (typeof t.name !== 'string') continue;
    if (t.inputSchema === null || typeof t.inputSchema !== 'object') continue;
    const tool: {
      name: string;
      description?: string;
      inputSchema: JsonSchema;
      outputSchema?: JsonSchema;
    } = {
      name: t.name,
      inputSchema: t.inputSchema as JsonSchema,
    };
    if (typeof t.description === 'string') tool.description = t.description;
    if (t.outputSchema !== null && typeof t.outputSchema === 'object') {
      tool.outputSchema = t.outputSchema as JsonSchema;
    }
    tools.push(tool);
  }
  return tools;
}

/**
 * Build the canonical agent-tool catalog by querying every configured
 * MCP server live: `initialize` (→ `serverInfo`) + `tools/list` (→ tool
 * descriptors). The result is keyed by BARE tool name and maps to the
 * nested {@link AgentToolEntry} shape (`serverInfo` + `toolInfo`), which
 * the agent stamps into `blueprintDraft.contract.agentCapabilities` so
 * the reuse gate can match on `(serverInfo.name, toolName)` + schema.
 *
 * Constraint: bare tool names MUST be unique across the configured
 * server SET. Two servers exposing the same bare name collide on the
 * catalog key; we keep the FIRST (iteration-order) and drop later ones
 * with a warning rather than silently overwriting. Operators who need
 * to expose two servers with overlapping tool names must namespace them
 * at the MCP layer.
 *
 * Failure mode is all-or-nothing: if ANY server's `initialize` /
 * `tools/list` fails, the entire build rejects (fail-fast via
 * `Promise.all`) — there is no partial catalog. The caller's degrade
 * path treats this rejection as `agentCapabilities: undefined`, so a
 * single down server degrades ALL tools, not just that server's.
 */
export async function buildAgentCatalog(
  servers: Record<string, { url: string; bearer: string }>,
): Promise<Record<string, AgentToolEntry>> {
  const perServer = await Promise.all(
    Object.entries(servers).map(async ([key, cfg]) => {
      const [serverInfo, tools] = await Promise.all([
        callMcpInitialize({ url: cfg.url, bearer: cfg.bearer }),
        callMcpToolsList({ url: cfg.url, bearer: cfg.bearer }),
      ]);
      return { key, serverInfo, tools };
    }),
  );

  const catalog: Record<string, AgentToolEntry> = {};
  for (const { key, serverInfo, tools } of perServer) {
    for (const tool of tools) {
      if (Object.prototype.hasOwnProperty.call(catalog, tool.name)) {
        console.warn(
          `[agent-server] duplicate bare tool name "${tool.name}" — server "${key}" (${serverInfo.name}) collides with an earlier server; keeping the first.`,
        );
        continue;
      }
      const toolInfo: AgentToolEntry['toolInfo'] = {
        inputSchema: tool.inputSchema,
      };
      if (tool.description !== undefined) toolInfo.description = tool.description;
      if (tool.outputSchema !== undefined) toolInfo.outputSchema = tool.outputSchema;
      catalog[tool.name] = { serverInfo, toolInfo };
    }
  }
  return catalog;
}
