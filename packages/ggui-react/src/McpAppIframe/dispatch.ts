/**
 * Platform-agnostic JSON-RPC dispatch for `<McpAppIframe>`.
 *
 * Extracts the host-role method switch from the platform-specific host
 * components so web (iframe + DOM message events) and RN (WebView +
 * `ReactNativeWebView.postMessage`) share ONE implementation of the
 * protocol. The host MUST respond to:
 *
 *   - `ping` → `{ok: true}` / `{pong: true}` shape.
 *   - `ui/initialize` → `{theme, containerDimensions, locale}` ONLY
 *     — the adapter-boundary rule (no outer-app state leaks).
 *   - `ui/open-link` with http(s) URLs → caller opens externally;
 *     other schemes → reject `unsupported-scheme`.
 *   - `tools/call` → caller-provided handler, or reject
 *     `no-tool-handler` when none.
 *   - any other method → `method_not_supported`.
 *
 * Notifications (requests without `id`) return `null` — the caller
 * MUST NOT post a response back to the iframe.
 *
 * The `handleHostBridgeRequest` helper used by the legacy
 * `McpAppsStackItemRenderer` stays in place for that session-bound
 * stack-item renderer; this is its generic-host sibling. Both retire
 * together once every consumer has migrated.
 */

import type {
  GguiBootstrapMeta,
  GguiUserActionMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { isGguiUserActionMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type {
  McpAppIframeDimensions,
  McpAppIframeProps,
} from './types.js';

/** Inbound JSON-RPC request shape — defensively typed. */
export interface HostBridgeRequest {
  readonly jsonrpc?: '2.0';
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

/** Outbound JSON-RPC response shape. */
export interface HostBridgeResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

/** Outbound JSON-RPC notification (host → iframe, fire-and-forget). */
export interface HostBridgeNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/**
 * Context passed to {@link dispatchHostBridgeRequest}. Kept narrow to
 * satisfy the adapter-boundary rule — only fields the iframe is
 * PERMITTED to read flow through this record.
 */
export interface HostBridgeContext {
  readonly theme: Readonly<Record<string, string>>;
  readonly locale: string;
  readonly containerDimensions: McpAppIframeDimensions;
  /**
   * Platform hook the host uses when the iframe asks `ui/open-link`
   * on an http(s) URL. Thrown errors are caught and mapped to a
   * `-32000` JSON-RPC error — callers (the platform host) MUST NOT
   * swallow them silently.
   */
  readonly openLink: (url: string) => Promise<void> | void;
  /**
   * Caller-provided tools/call handler. `undefined` = caller opted
   * out; every `tools/call` is rejected with `no-tool-handler`.
   */
  readonly onToolCall?: McpAppIframeProps['onToolCall'];
  /**
   * Opt-in first-party bootstrap forwarding.
   *
   * When present, `dispatchHostBridgeRequest`'s `ui/initialize`
   * branch adds `toolOutput._meta.ggui.bootstrap = bootstrap` to the
   * response alongside the existing `theme` / `containerDimensions` /
   * `locale` adapter-boundary fields. The renderer's `parseBootstrap`
   * (`packages/iframe-runtime/src/bootstrap.ts`) reads this exact shape.
   *
   * When absent (default), the response is `{theme,
   * containerDimensions, locale}` only — no `toolOutput`, no `_meta`.
   * Third-party MCP App iframes MUST NOT be given a `bootstrap` here:
   * leaking outer-app state into a generic MCP App's `ui/initialize`
   * response is exactly the adapter-boundary violation the rule
   * exists to prevent.
   *
   * Carrier shape mirrors the wire — the same `GguiBootstrapMeta`
   * type the server stamps onto the `ggui_push` tool result's
   * `_meta.ggui.bootstrap` ends up here verbatim. No transformation,
   * no per-namespace whitelisting; the host's contract is "thread the
   * forwarded bootstrap through" and that's it.
   */
  readonly bootstrap?: GguiBootstrapMeta;
}

/**
 * Minimal permissive-but-safe default theme — used when the host
 * provides no `theme` prop. Exported for test parity + so custom hosts
 * can round-trip the same default when they want to observe the exact
 * bytes the iframe would have received.
 */
export const DEFAULT_HOST_THEME: Readonly<Record<string, string>> = {
  '--color-primary': '#0284c7',
  '--color-surface': '#ffffff',
  '--color-text': '#111111',
  '--font-family': 'system-ui, -apple-system, sans-serif',
  '--border-radius-md': '8px',
};

// =============================================================================
// Request-shape guards
// =============================================================================

function isJsonRpcRequest(value: unknown): value is HostBridgeRequest {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { jsonrpc?: unknown; method?: unknown };
  return v.jsonrpc === '2.0' && typeof v.method === 'string';
}

function paramString(
  params: HostBridgeRequest['params'],
  key: string,
): string {
  if (!params) return '';
  const v = params[key];
  return typeof v === 'string' ? v : '';
}

function paramObject(
  params: HostBridgeRequest['params'],
  key: string,
): Record<string, unknown> {
  if (!params) return {};
  const v = params[key];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

// =============================================================================
// Dispatcher
// =============================================================================

/**
 * Host-role method dispatcher for `<McpAppIframe>`. Returns a JSON-RPC
 * response, or `null` when the request is malformed / a notification
 * (the caller MUST NOT post a response back in that case).
 *
 * Pure function — testable without a DOM / WebView / iframe present.
 */
export async function dispatchHostBridgeRequest(
  req: HostBridgeRequest,
  ctx: HostBridgeContext,
): Promise<HostBridgeResponse | null> {
  if (!isJsonRpcRequest(req)) return null;
  // Notifications (no `id`) — host MUST NOT reply.
  if (req.id === undefined) return null;

  const id = req.id;

  switch (req.method) {
    case 'ping': {
      return { jsonrpc: '2.0', id, result: { ok: true, pong: true } };
    }
    case 'ui/initialize': {
      // ADAPTER BOUNDARY (default posture). The result carries
      // `{theme, containerDimensions, locale}` ONLY — no outer-app
      // state leaks into the iframe.
      //
      // READING-B EXCEPTION (opt-in via `ctx.bootstrap`). When the
      // host has explicitly threaded a `GguiBootstrapMeta` for a
      // first-party ggui renderer iframe (see `McpAppIframeProps.
      // bootstrap` JSDoc), augment the result with
      // `toolOutput._meta.ggui.bootstrap = ctx.bootstrap`. The
      // renderer's `parseBootstrap` reads exactly that path. The
      // adapter-boundary rule still applies to every other key —
      // only `_meta.ggui.bootstrap` is forwarded, scoped by the
      // ggui namespace.
      const result: Record<string, unknown> = {
        theme: ctx.theme,
        containerDimensions: ctx.containerDimensions,
        locale: ctx.locale,
      };
      if (ctx.bootstrap !== undefined) {
        result['toolOutput'] = {
          _meta: { ggui: { bootstrap: ctx.bootstrap } },
        };
      }
      return { jsonrpc: '2.0', id, result };
    }
    case 'ui/open-link': {
      const url = paramString(req.params, 'url');
      if (!/^https?:\/\//i.test(url)) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'unsupported-scheme' },
        };
      }
      try {
        await ctx.openLink(url);
        return { jsonrpc: '2.0', id, result: { opened: true } };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: `open_link_failed: ${String(err)}`,
          },
        };
      }
    }
    case 'tools/call': {
      if (ctx.onToolCall === undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'no-tool-handler' },
        };
      }
      const tool = paramString(req.params, 'name');
      if (tool.length === 0) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'tools/call requires params.name' },
        };
      }
      const args = paramObject(req.params, 'arguments');
      try {
        const result: unknown = await ctx.onToolCall(tool, args);
        // JSON-RPC `result` MUST be an object. Wrap primitive /
        // array results into `{ value }` so the iframe always sees
        // the same envelope shape.
        const wrapped: Record<string, unknown> =
          result !== null && typeof result === 'object' && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : { value: result };
        return { jsonrpc: '2.0', id, result: wrapped };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: `tool_call_failed: ${String(err)}`,
          },
        };
      }
    }
    default: {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'method_not_supported' },
      };
    }
  }
}

// =============================================================================
// Renderer → host envelope classification
// =============================================================================
//
// The renderer inside the iframe emits typed postMessage envelopes the
// host consumes to fire `onError` / `onUpgradeRequired` / `onObserve`.
// These helpers tag each envelope into its kind so the platform host
// can route it without duplicating the classification logic.

/** Tag for every envelope the host recognises from the renderer. */
export type RendererEnvelopeTag =
  | 'bootstrap-failed'
  | 'protocol-error'
  | 'observability'
  | 'lifecycle'
  | 'upgrade-required'
  | 'ui-message'
  | 'jsonrpc'
  | 'unknown';

/**
 * Parsed shape of a `ui/message` envelope the renderer posts to the
 * host. The MCP Apps spec primitive is for in-iframe widgets to
 * inject a chat message AS IF the user had typed it.
 *
 * In ggui, the iframe-runtime emits this as the agent-routed
 * dispatch fallback: when `actionSpec[name].dispatch.kind === 'agent'`
 * fires inside the iframe, runtime fires THREE envelopes:
 *
 *   1. `tools/call ggui_runtime_submit_action` — server-side audit +
 *      queues into the ggui_consume pipe.
 *   2. `ui/update-model-context` — structured pending-action hint.
 *   3. `ui/message` — this envelope. The host's job is to forward
 *      `text` to the agent (e.g., POST as a new user turn) so the
 *      consume long-poll isn't the ONLY path back to the agent.
 *
 * Hosts that route via consume don't need this; hosts that do
 * agent-as-chat (single-shot query() per turn, no resume) wire
 * `onUiMessage` and POST the text back to their own loop.
 */
export interface UiMessageEvent {
  readonly role: 'user' | 'assistant' | 'system';
  readonly text: string;
  /**
   * Structured user-action discriminator. When this `ui/message`
   * originated from the iframe-runtime's gesture dispatch path, this
   * field carries the {@link GguiUserActionMeta} envelope unwrapped
   * from `_meta.ggui.userAction`:
   *
   *   - `kind: 'queued'` — pipe HAS the event; agent should dispatch
   *     `nextStep` (prepared `ggui_consume` call) to drain.
   *   - `kind: 'inline'` — pipe is GONE; action + ui context delivered
   *     inline in `payload`. Agent acts directly on `payload.actionData`
   *     using the optional `nextStep` hint or its own contract awareness.
   *
   * Hosts with first-class ggui support route via this field through
   * their tool-result loop; hosts without it see a regular `ui/message`
   * (the `text` is self-sufficient) and don't break.
   *
   * Absent → standard `ui/message` (user-authored chat-shortcut etc.).
   *
   * See `GguiUserActionMeta` in `@ggui-ai/protocol/integrations/mcp-apps`
   * for the full shape + type guard `isGguiUserActionMeta`.
   */
  readonly userAction?: GguiUserActionMeta;
}

/**
 * Classify a raw message payload received from the iframe/WebView. The
 * platform host routes each tag to the matching callback prop.
 *
 * Accepted envelopes (match the sibling renderer's emission contract):
 *
 *   - `{type:'ggui:bootstrap-failed', reason, message}` → boot-failure
 *     postMessage; host calls `onError(fromBootstrapFailure(...))`.
 *   - `{type:'ggui:protocol-error', error: ProtocolError}` → already-
 *     classified error the renderer forwards as-is; host calls
 *     `onError(error)`.
 *   - `{type:'ggui:observe', event: ObservabilityEvent}` → observability
 *     frame; host calls `onObserve(event)`.
 *   - `{type:'ggui:lifecycle', event: McpAppLifecycleEvent}` → mount-
 *     state transition; host mirrors `event.state` onto the outer
 *     iframe element (`data-ggui-mcp-app-iframe-lifecycle="<state>"`)
 *     so observers (E2E, third-party hosts, console inspectors) can
 *     pin without `frameLocator`. Locked in
 *     `@ggui-ai/protocol/integrations/mcp-apps`.
 *   - `{type:'ggui:upgrade-required', server, client}` → explicit
 *     version-negotiation rejection; host calls `onUpgradeRequired`.
 *   - Otherwise, treat as a standard JSON-RPC request (from the
 *     embedded MCP App) or unknown (drop silently).
 */
export function classifyRendererEnvelope(data: unknown): RendererEnvelopeTag {
  if (data === null || typeof data !== 'object') return 'unknown';
  const d = data as { type?: unknown; jsonrpc?: unknown; method?: unknown };
  if (typeof d.type === 'string') {
    switch (d.type) {
      case 'ggui:bootstrap-failed':
        return 'bootstrap-failed';
      case 'ggui:protocol-error':
        return 'protocol-error';
      case 'ggui:observe':
        return 'observability';
      case 'ggui:lifecycle':
        return 'lifecycle';
      case 'ggui:upgrade-required':
        return 'upgrade-required';
      default:
        break;
    }
  }
  if (d.jsonrpc === '2.0' && typeof d.method === 'string') {
    // `ui/message` is the agent-routed-dispatch fallback envelope —
    // hosts that want to forward the iframe's chat-shortcut into
    // their agent loop wire `onUiMessage`. Other `ui/*` and bridge
    // methods fall through to the generic jsonrpc dispatcher.
    if (d.method === 'ui/message') return 'ui-message';
    return 'jsonrpc';
  }
  return 'unknown';
}

/**
 * Extract `{role, text}` from a `ui/message` envelope's params. The
 * params shape mirrors the MCP Apps spec: `{role, content: [{type:
 * 'text', text}, …]}`. Multiple text blocks are concatenated with a
 * single newline; non-text blocks are skipped (image, resource, etc.
 * aren't meaningful here). Returns `null` if the params are malformed.
 */
export function parseUiMessageEnvelope(data: unknown): UiMessageEvent | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as { method?: unknown; params?: unknown };
  if (d.method !== 'ui/message') return null;
  if (d.params === null || typeof d.params !== 'object') return null;
  const p = d.params as { role?: unknown; content?: unknown; _meta?: unknown };
  const role =
    p.role === 'user' || p.role === 'assistant' || p.role === 'system'
      ? p.role
      : 'user';
  if (!Array.isArray(p.content)) return null;
  const texts: string[] = [];
  for (const block of p.content) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
  }
  if (texts.length === 0) return null;
  // Unwrap `_meta.ggui.userAction` so hosts with first-class ggui
  // support can route the envelope through their tool-result loop.
  // Hosts without first-class support ignore the field; the public
  // `text` is self-sufficient so chat behavior is unchanged.
  let userAction: GguiUserActionMeta | undefined;
  if (p._meta !== null && typeof p._meta === 'object') {
    const meta = p._meta as { ggui?: unknown };
    if (meta.ggui !== null && typeof meta.ggui === 'object') {
      const g = meta.ggui as { userAction?: unknown };
      if (isGguiUserActionMeta(g.userAction)) {
        userAction = g.userAction;
      }
    }
  }
  return {
    role,
    text: texts.join('\n'),
    ...(userAction !== undefined ? { userAction } : {}),
  };
}

/**
 * Build the JSON-RPC notification the imperative-ref `dispatchAction`
 * posts into the iframe. Exported so tests can assert the wire shape
 * without instantiating a real iframe.
 */
export function buildDispatchActionNotification(
  name: string,
  data: unknown,
): HostBridgeNotification {
  return {
    jsonrpc: '2.0',
    method: name,
    params: { data },
  };
}

/**
 * Build the `ui/resource-teardown` notification posted to the iframe
 * BEFORE the host element leaves the DOM. Exported so tests can
 * assert the wire shape at unmount time.
 */
export function buildResourceTeardownNotification(): HostBridgeNotification {
  return {
    jsonrpc: '2.0',
    method: 'ui/resource-teardown',
    params: { reason: 'host_unmount' },
  };
}

// =============================================================================
// Resource → iframe mount-source derivation
// =============================================================================

/**
 * Compute the iframe mount source from an MCP Apps `ResourceContents`.
 *
 * Decision tree:
 *   1. `text` present → mount via `srcdoc` (inline HTML). `srcdoc`
 *      creates an iframe whose origin is opaque + fully sandboxed, so
 *      this is the safest path for embedded content.
 *   2. `blob` + `mimeType` → mount via a `data:` URL (base64 blob).
 *      Same opaque-origin semantics as srcdoc.
 *   3. Else → mount via `src = uri` IF `uri` is http(s); otherwise
 *      reject (`null` returned from this helper — caller renders a
 *      blank iframe + emits a classification error upstream).
 */
export interface ResourceMountSource {
  readonly kind: 'srcdoc' | 'data-url' | 'src';
  readonly value: string;
}

export function deriveResourceMountSource(resource: {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}): ResourceMountSource | null {
  if (typeof resource.text === 'string' && resource.text.length > 0) {
    return { kind: 'srcdoc', value: resource.text };
  }
  if (typeof resource.blob === 'string' && resource.blob.length > 0) {
    const mime =
      typeof resource.mimeType === 'string' && resource.mimeType.length > 0
        ? resource.mimeType
        : 'text/html';
    return {
      kind: 'data-url',
      value: `data:${mime};base64,${resource.blob}`,
    };
  }
  if (typeof resource.uri === 'string' && /^https?:\/\//i.test(resource.uri)) {
    return { kind: 'src', value: resource.uri };
  }
  return null;
}
