/**
 * Tool-result interceptor: inlines the spec-canonical
 * `_meta.ui.resourceUri` resource alongside every tool result that
 * carries one.
 *
 * Why this exists: none of the three sample SDKs (Claude Agent SDK,
 * OpenAI Agents SDK, Google ADK) implement `resources/read` on
 * `_meta.ui.resourceUri` themselves. The frontend can fetch via a
 * relay endpoint, but that's an extra round-trip per render AND
 * leaves the iframe blank during the gap. By having the library
 * intercept the tool result on the way out — issuing the
 * `resources/read` to the same MCP server with the same auth — the
 * browser receives the iframe HTML inline on the FIRST SSE event for
 * the tool result. `<AppRenderer>` then renders directly via its
 * `toolResource` prop, no separate fetch.
 *
 * Inline shape (added under `_meta.ui.resource`):
 *
 * ```
 * {
 *   uri: string,
 *   mimeType?: string,
 *   text?: string,          // the iframe HTML body
 *   _meta?: Record<string, unknown>  // forwarded from the
 *                                    // resource content, carries
 *                                    // `ui.csp` etc.
 * }
 * ```
 *
 * This matches the existing AppRenderer `toolResource` prop shape
 * from `@modelcontextprotocol/ext-apps`, so the frontend can adopt
 * it without a new schema.
 *
 * Failure handling: when the read fails, log + leave the message
 * untouched. The frontend's existing relay path (or its own
 * `onReadResource`) is the fallback — fail-honest rather than
 * silently corrupt the tool result.
 */

import { callMcpResourcesRead } from './mcp-client.js';
import type { McpCallToolResult, NormalizedMessage } from './types.js';

/**
 * Per-server context the interceptor needs to map a resource URI
 * back to an MCP endpoint. Each entry pairs the MCP URL with the
 * bearer the library resolved for it.
 */
export interface InterceptorMcpServers {
  readonly [name: string]: {
    readonly url: string;
    readonly bearer: string;
  };
}

/**
 * Look up the spec-canonical `_meta.ui.resourceUri` on a normalized
 * `tool_use_result`. Returns the URI when present + non-empty, else
 * `undefined`.
 */
function extractResourceUri(
  result: McpCallToolResult | undefined,
): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const meta = result._meta;
  if (meta === null || typeof meta !== 'object') return undefined;
  const ui = (meta as { ui?: unknown }).ui;
  if (ui === null || typeof ui !== 'object') return undefined;
  const uri = (ui as { resourceUri?: unknown }).resourceUri;
  if (typeof uri === 'string' && uri.length > 0) return uri;
  return undefined;
}

/**
 * Decide which MCP server owns a `ui://` resource URI. Strategy:
 * iterate every configured server in order and pick the FIRST whose
 * URL host matches the URI's host. For `ui://<host>/...` URIs this
 * lands on the right server when each MCP is on its own port. When
 * no host match exists, fall back to the first configured `ggui`
 * entry (the conventional primary), then to the first entry overall.
 *
 * Production deployments with multiple MCPs serving overlapping
 * `ui://` namespaces should override this by exposing a router on
 * `AgentServerOptions` — the library exposes the routing logic so a
 * future override is one swap away.
 */
export function selectMcpServerForResource(
  resourceUri: string,
  servers: InterceptorMcpServers,
): { readonly url: string; readonly bearer: string } | undefined {
  const entries = Object.entries(servers);
  if (entries.length === 0) return undefined;
  // ui:// URIs carry their server hint in the host component, e.g.
  // `ui://ggui/render/abc`. Pick the entry whose KEY matches the
  // host first — that's the operator's explicit naming.
  try {
    const parsed = new URL(resourceUri);
    const host = parsed.host || parsed.pathname.split('/')[0] || '';
    if (host.length > 0) {
      const named = entries.find(([name]) => name === host);
      if (named) return named[1];
    }
  } catch {
    /* not a URL — fall through to fallback */
  }
  // Fallbacks: conventional `ggui` key → first entry.
  const ggui = entries.find(([name]) => name === 'ggui');
  if (ggui) return ggui[1];
  return entries[0]?.[1];
}

/**
 * Walk a normalized message and, when it's a `tool_result` carrying
 * `_meta.ui.resourceUri`, fetch the resource and return a NEW
 * message with the resource inlined under
 * `tool_use_result._meta.ui.resource`. Returns the original message
 * unchanged when there's no resourceUri or when the fetch fails.
 *
 * Pure-functional: never mutates the input. The library forwards the
 * returned message through SSE + records it in the snapshot, so
 * rehydrations see the same inlined resource on `GET /agent`.
 *
 * Two call paths with opposite freshness semantics:
 *
 *   - LIVE (`POST /agent` stream, default): skip when the result is
 *     already inlined — the inlined HTML is the first-mount
 *     optimization and re-fetching mid-stream would be wasted work.
 *   - REPLAY (`GET /agent` rehydration, `forceReinline: true`): IGNORE
 *     the record-time inlined resource and re-issue `resources/read`
 *     so the replayed message carries the CURRENT server-authoritative
 *     HTML (latest props). The frozen record-time resource captured the
 *     initial render; a `*_update` delivered live over WS afterward
 *     never re-baked into the snapshot, so the replay MUST re-fetch to
 *     reflect current state — otherwise a reload shows pre-click HTML.
 */
export async function interceptToolResult(args: {
  readonly message: NormalizedMessage;
  readonly mcpServers: InterceptorMcpServers;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
  /**
   * Replay-path flag. When `true`, re-fetch the resource even if it's
   * already inlined, overwriting the record-time HTML with the current
   * server state. Defaults to `false` (live-stream behavior — skip the
   * already-inlined no-op).
   */
  readonly forceReinline?: boolean;
}): Promise<NormalizedMessage> {
  const { message, mcpServers, signal, log, forceReinline = false } = args;
  if (message.type !== 'user') return message;
  const fullResult = message.tool_use_result;
  // Failed tool results are never mountable. The ggui failure envelope
  // (`isError: true`) carries NO `_meta` at all — no `ai.ggui/render`
  // slice, no `ui.resourceUri` — so there is nothing to inline; the
  // model self-corrects from `content[0].text`. Even if some other
  // server DID stamp a resourceUri on an error result, issuing
  // `resources/read` for a render that failed would be a wasted
  // round-trip against a resource that may not exist. Skip early.
  if (fullResult?.isError === true) return message;
  const uri = extractResourceUri(fullResult);
  if (uri === undefined || fullResult === undefined) return message;

  // Skip when the resource has already been inlined (idempotent
  // live path: a second pass over an already-inlined result is a
  // no-op) — UNLESS the caller forces a fresh re-inline (the
  // `GET /agent` rehydration path, which MUST reflect current server
  // state rather than the record-time HTML).
  if (!forceReinline) {
    const existingUi = (fullResult._meta as { ui?: unknown } | undefined)
      ?.ui as { resource?: unknown } | undefined;
    if (existingUi?.resource !== undefined) return message;
  }

  const server = selectMcpServerForResource(uri, mcpServers);
  if (!server) {
    log?.(
      `[agent-server] tool-result interceptor: no MCP server matched ${uri} — passing through`,
    );
    return message;
  }

  try {
    const read = await callMcpResourcesRead({
      url: server.url,
      bearer: server.bearer,
      uri,
      ...(signal ? { signal } : {}),
    });
    const first = read.contents[0];
    if (!first) {
      log?.(
        `[agent-server] tool-result interceptor: ${uri} returned no contents — passing through`,
      );
      return message;
    }
    // Build the merged _meta.ui slice: keep every existing key,
    // overwrite ONLY the new `resource` slot.
    const existingMeta = (fullResult._meta ?? {}) as Record<string, unknown>;
    const existingUiBlock = (existingMeta.ui ?? {}) as Record<string, unknown>;
    const resource: {
      uri: string;
      mimeType?: string;
      text?: string;
      _meta?: Record<string, unknown>;
    } = { uri: first.uri };
    if (first.mimeType !== undefined) resource.mimeType = first.mimeType;
    if (first.text !== undefined) resource.text = first.text;
    if (first._meta !== undefined) resource._meta = first._meta;
    const nextMeta: Record<string, unknown> = {
      ...existingMeta,
      ui: { ...existingUiBlock, resource },
    };
    const nextResult: McpCallToolResult = {
      ...fullResult,
      _meta: nextMeta,
    };
    return { ...message, tool_use_result: nextResult };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    log?.(
      `[agent-server] tool-result interceptor: resources/read for ${uri} failed — ${errMessage}`,
    );
    return message;
  }
}
