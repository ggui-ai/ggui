/**
 * Thin MCP JSON-RPC client for the operator console — talks to the
 * server's stateless `/ops` endpoint (mounted in
 * `packages/mcp-server/src/server.ts`).
 *
 * **Why this exists.** The console SPA needs to invoke the four
 * `ggui_ops_*` blueprint tools — `generate`, `list`, `update`,
 * `delete`. Rather than minting REST proxy endpoints on `mcp-server`,
 * the SPA posts JSON-RPC `tools/call` requests directly to `/ops`,
 * which is the canonical operator-tool surface.
 *
 * **Wire shape.** `/ops` runs the MCP Streamable HTTP transport in
 * stateless mode (`sessionIdGenerator: undefined`). It accepts a
 * single JSON-RPC request body and responds with either a single JSON
 * object or an SSE stream depending on `Accept`. We send `application/
 * json, text/event-stream` and parse whichever body the server picks;
 * MCP servers MAY return SSE even for a single-shot call.
 *
 * **Auth posture.** The console's same-origin cookie middleware
 * (`cookieAuthMiddleware`) injects the operator's bearer header from
 * the `ggui_console_admin` cookie before the request reaches the
 * `/ops` MCP handler. Browser specs land logged-in; bare curl gets
 * 401.
 *
 * **Result envelope.** MCP tool calls return a `{content, isError?,
 * structuredContent?}` envelope — `structuredContent` carries the
 * typed output (mirrors the tool's `outputSchema`) when present, with
 * `content[0].text` carrying a JSON-stringified fallback for legacy
 * clients. We prefer `structuredContent` and fall back to parsing the
 * text — same posture the MCP SDK client takes.
 */
import type {
  OpsDeleteBlueprintInput,
  OpsDeleteBlueprintOutput,
  OpsGenerateBlueprintInput,
  OpsGenerateBlueprintOutput,
  OpsListBlueprintsInput,
  OpsListBlueprintsOutput,
  OpsUpdateBlueprintInput,
  OpsUpdateBlueprintOutput,
} from '@ggui-ai/protocol';

/** Shape of a JSON-RPC error returned by MCP. */
export interface OpsRpcError {
  readonly code: number;
  readonly message: string;
}

/** Shape thrown when the call fails. Preserves the JSON-RPC error code
 *  for handlers that want to differentiate (e.g. 401 vs server-internal). */
export class OpsCallError extends Error {
  readonly code: number;
  readonly status?: number;
  constructor(message: string, code: number, status?: number) {
    super(message);
    this.name = 'OpsCallError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/**
 * One MCP content block. The MCP SDK types `content` as a discriminated
 * union (`text` | `image` | `resource`). The ops-blueprint tools only
 * emit text fallbacks, so we narrow.
 */
interface McpTextBlock {
  readonly type: 'text';
  readonly text: string;
}

interface McpToolResult<T> {
  readonly content?: ReadonlyArray<McpTextBlock>;
  readonly structuredContent?: T;
  readonly isError?: boolean;
}

interface JsonRpcSuccess<T> {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly result: T;
}

interface JsonRpcFailure {
  readonly jsonrpc: '2.0';
  readonly id: number | string | null;
  readonly error: OpsRpcError;
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

let nextRequestId = 1;

/**
 * Parse an MCP Streamable-HTTP response body — accepts either a single
 * JSON object or an SSE stream containing exactly one `data:` event
 * payload. Returns the parsed envelope or throws.
 *
 * Spec: servers respond with `application/json` when the call is a
 * one-shot (which all ops tool calls are); we tolerate `text/event-
 * stream` to be robust against server-side accept-driven branching.
 */
async function parseMcpResponse<T>(res: Response): Promise<JsonRpcResponse<T>> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    // Find the first `data:` line; the body is `data: <json>\n\n`.
    const match = /^data:\s*(.+)$/m.exec(text);
    if (!match || !match[1]) {
      throw new OpsCallError(
        `Malformed SSE response from /ops — no data line`,
        -32700,
        res.status,
      );
    }
    return JSON.parse(match[1]) as JsonRpcResponse<T>;
  }
  // Default to JSON.
  return (await res.json()) as JsonRpcResponse<T>;
}

/**
 * Invoke an MCP `tools/call` against `/ops` and unwrap the result to
 * the tool's typed `structuredContent` (or parse the text fallback).
 * Throws {@link OpsCallError} on JSON-RPC failure or HTTP error.
 */
async function callOpsTool<TArgs, TResult>(
  name: string,
  args: TArgs,
  signal?: AbortSignal,
): Promise<TResult> {
  const requestId = nextRequestId++;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const fetchInit: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Streamable HTTP transport requires the client to advertise both
      // shapes; the server picks one. Sending only `application/json`
      // is enough for stateless servers in practice but the spec calls
      // for both.
      accept: 'application/json, text/event-stream',
    },
    body,
  };
  if (signal !== undefined) {
    fetchInit.signal = signal;
  }
  const res = await fetch('/ops', fetchInit);
  if (!res.ok && res.status !== 200) {
    // The MCP transport returns 200 even for tool errors (errors live
    // in the JSON-RPC envelope). Any other status is a transport-level
    // failure — auth, route, server crash.
    const text = await res.text().catch(() => '');
    throw new OpsCallError(
      `/ops returned HTTP ${res.status}${text ? ` — ${text}` : ''}`,
      -32000,
      res.status,
    );
  }
  const envelope = await parseMcpResponse<McpToolResult<TResult>>(res);
  if ('error' in envelope) {
    throw new OpsCallError(envelope.error.message, envelope.error.code);
  }
  const result = envelope.result;
  if (result.isError) {
    const errText = result.content?.[0]?.text ?? 'tool reported error';
    throw new OpsCallError(errText, -32000);
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  // Fallback: parse the text block. ops tools always emit structured
  // content in practice, but we honour the MCP spec's optional shape.
  const text = result.content?.[0]?.text;
  if (typeof text === 'string' && text.length > 0) {
    return JSON.parse(text) as TResult;
  }
  throw new OpsCallError(
    `tool ${name} returned empty result`,
    -32000,
  );
}

export function callOpsGenerateBlueprint(
  input: OpsGenerateBlueprintInput,
  signal?: AbortSignal,
): Promise<OpsGenerateBlueprintOutput> {
  return callOpsTool<OpsGenerateBlueprintInput, OpsGenerateBlueprintOutput>(
    'ggui_ops_generate_blueprint',
    input,
    signal,
  );
}

export function callOpsListBlueprints(
  input: OpsListBlueprintsInput,
  signal?: AbortSignal,
): Promise<OpsListBlueprintsOutput> {
  return callOpsTool<OpsListBlueprintsInput, OpsListBlueprintsOutput>(
    'ggui_ops_list_blueprints',
    input,
    signal,
  );
}

export function callOpsUpdateBlueprint(
  input: OpsUpdateBlueprintInput,
  signal?: AbortSignal,
): Promise<OpsUpdateBlueprintOutput> {
  return callOpsTool<OpsUpdateBlueprintInput, OpsUpdateBlueprintOutput>(
    'ggui_ops_update_blueprint',
    input,
    signal,
  );
}

export function callOpsDeleteBlueprint(
  input: OpsDeleteBlueprintInput,
  signal?: AbortSignal,
): Promise<OpsDeleteBlueprintOutput> {
  return callOpsTool<OpsDeleteBlueprintInput, OpsDeleteBlueprintOutput>(
    'ggui_ops_delete_blueprint',
    input,
    signal,
  );
}
