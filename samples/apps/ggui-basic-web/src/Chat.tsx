/* eslint-disable no-console */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  AppRenderer,
  type RequestHandlerExtra,
} from '@ggui-ai/react';
import {
  useMcpAppsChat,
  type ChatEntry,
  type RenderRef,
  type ToolCallEntry,
} from '@ggui-ai/react/chat-helpers';
import {
  isGguiUserActionMeta,
  type GguiUserActionMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type {
  CallToolRequest,
  CallToolResult,
  ReadResourceRequest,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';

type LayoutMode = 'inline' | 'panel';

interface ChatProps {
  /**
   * MCP-Apps-spec agent backend base URL (e.g. `http://localhost:6790`).
   * Wired into the `useMcpAppsChat` hook for POST /chat + GET /chat?
   * chatId=X and into the iframe relay calls (`/relay/tools-call` +
   * `/relay/resources-read`). The frontend stays SDK-agnostic — the
   * backend decides which LLM it drives.
   */
  readonly agentEndpoint: string;
  /**
   * Sandbox-proxy origin (second-origin iframe host, per MCP-Apps spec).
   * Fetched by {@link App} from `GET /sandbox-proxy-url` on the agent
   * backend and threaded down here so a `<Chat>` mount always has a
   * resolved URL — no in-component loading state.
   */
  readonly sandboxUrl: string;
}

/**
 * Stable per-conversation chat id. Resolution:
 *
 *   1. URL `?chat=<id>` query param — authoritative. Every link to
 *      "this conversation" carries the id, so opening the URL in any
 *      tab/window restores that specific conversation.
 *   2. Mint fresh UUID and stamp it into the URL.
 *
 * Browser-only — this app is a pure Vite SPA, so no SSR/pre-hydration
 * dance is required (unlike the Next.js predecessor).
 */
const URL_CHAT_PARAM = 'chat';

function getOrCreateChatId(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get(URL_CHAT_PARAM);
  if (fromUrl && fromUrl.length > 0) return fromUrl;
  const resolved = crypto.randomUUID();
  url.searchParams.set(URL_CHAT_PARAM, resolved);
  window.history.replaceState({}, '', url.toString());
  return resolved;
}

/**
 * Chat panel + iframe area for an MCP-Apps-spec agent backend.
 *
 * Brand-agnostic by design: the sample agent backends only know about
 * the SDK message stream + relay paths. Every MCP-Apps spec parse —
 * `_meta.ui.resourceUri` extraction, render-URI dedup, display-mode
 * pickup — lives in {@link useMcpAppsChat}. Iframe mounting is the
 * stock `<AppRenderer>` from `@mcp-ui/client` (re-exported through
 * `@ggui-ai/react` for ergonomics).
 */
export function Chat({ agentEndpoint, sandboxUrl }: ChatProps) {
  // Pure browser env (Vite SPA) — resolve the chat id synchronously
  // during mount. `useState` initializer runs once per mount; the
  // returned id is then stable for the lifetime of the component.
  const [chatId, setChatId] = useState<string>(() => getOrCreateChatId());

  const { entries, renders, hostDisplayMode, sending, send, abort } =
    useMcpAppsChat({
      chatEndpoint: `${agentEndpoint}/chat`,
      snapshotEndpoint: `${agentEndpoint}/chat`,
      chatId,
    });

  const [prompt, setPrompt] = useState('');
  const [layout, setLayout] = useState<LayoutMode>('inline');
  const historyRef = useRef<HTMLDivElement | null>(null);

  // `userAction` is the spec-canonical `_meta.ai.ggui/userAction` slice
  // iframe-runtime stamps on `ui/message` envelopes when a click can't
  // reach the agent via the consume pipe (no active long-poll). Threading
  // it through `send(...)` lets the backend extract renderId + actionData
  // as structured fields, so the new agent loop targets the existing
  // render with `ggui_update` instead of re-handshaking and orphaning the
  // live iframe. Without this, the renderId only reaches the agent as a
  // substring of the chat prose — fragile against LLM judgment drift.
  const onUiMessage = useCallback(
    (text: string, userAction?: GguiUserActionMeta) => {
      void send(text, userAction !== undefined ? { userAction } : undefined);
    },
    [send],
  );

  // Host-side displayMode hint pickup (MCP-Apps SEP-1865). User toggle
  // still wins until the next render that carries a hint.
  useEffect(() => {
    if (hostDisplayMode === undefined) return;
    setLayout(hostDisplayMode === 'inline' ? 'inline' : 'panel');
  }, [hostDisplayMode]);

  useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [entries.length]);

  const newSession = useCallback(() => {
    const fresh = crypto.randomUUID();
    const url = new URL(window.location.href);
    url.searchParams.set(URL_CHAT_PARAM, fresh);
    window.history.replaceState({}, '', url.toString());
    setChatId(fresh);
  }, []);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || sending) return;
    setPrompt('');
    void send(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault();
      (e.currentTarget.form as HTMLFormElement).requestSubmit();
    }
  };

  return (
    <div className={`layout layout-${layout}`}>
      <aside className="chat">
        <header>
          <div className="title">
            <h1>Agent Chat</h1>
            <p className="subtitle">MCP Apps · ggui</p>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="new-session"
              onClick={newSession}
              title="Start a fresh conversation"
              data-testid="new-session"
            >
              + New
            </button>
            <div className="layout-toggle" role="group" aria-label="Layout">
              <button
                type="button"
                className={layout === 'inline' ? 'active' : ''}
                onClick={() => setLayout('inline')}
                data-testid="layout-inline"
              >
                Inline
              </button>
              <button
                type="button"
                className={layout === 'panel' ? 'active' : ''}
                onClick={() => setLayout('panel')}
                data-testid="layout-panel"
              >
                Panel
              </button>
            </div>
          </div>
        </header>

        <div className="history" ref={historyRef} role="log" aria-live="polite">
          {entries.length === 0 ? <EmptyState /> : null}
          {entries.map((entry) => (
            <ChatEntryView
              key={entry.id}
              entry={entry}
              renderInline={layout === 'inline'}
              sandboxUrl={sandboxUrl}
              agentEndpoint={agentEndpoint}
              onUiMessage={onUiMessage}
            />
          ))}
        </div>

        <form onSubmit={onSubmit}>
          <textarea
            name="prompt"
            placeholder="Ask the agent to render a UI…    (Shift+Enter for newline)"
            rows={1}
            autoFocus
            value={prompt}
            disabled={sending}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
              setPrompt(e.target.value)
            }
            onKeyDown={onKeyDown}
          />
          <button
            type={sending ? 'button' : 'submit'}
            disabled={!sending && !prompt.trim()}
            onClick={sending ? abort : undefined}
            aria-label={sending ? 'Stop' : 'Send'}
            title={sending ? 'Stop' : 'Send'}
          >
            {sending ? (
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  background: 'currentColor',
                  borderRadius: 2,
                }}
              />
            ) : (
              'Send'
            )}
          </button>
        </form>
      </aside>

      {layout === 'panel' ? (
        <main className="ui-pane">
          <PanelView
            renders={renders}
            sandboxUrl={sandboxUrl}
            agentEndpoint={agentEndpoint}
            onUiMessage={onUiMessage}
          />
        </main>
      ) : null}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-state-mark">⌘</div>
      <h2>Generate a UI</h2>
      <p>Type a prompt below — the agent renders interactive UI inline.</p>
      <div className="empty-state-examples">
        <code>weather card for Berlin</code>
        <code>feedback form with a rating</code>
        <code>counter that starts at 0</code>
      </div>
    </div>
  );
}

function ChatEntryView({
  entry,
  renderInline,
  sandboxUrl,
  agentEndpoint,
  onUiMessage,
}: {
  entry: ChatEntry;
  renderInline: boolean;
  sandboxUrl: string;
  agentEndpoint: string;
  onUiMessage: (text: string, userAction?: GguiUserActionMeta) => void;
}) {
  if (entry.kind === 'render') {
    if (renderInline) {
      return (
        <div className="msg render-wrap">
          <ResourceFrame
            item={entry.render}
            sandboxUrl={sandboxUrl}
            agentEndpoint={agentEndpoint}
            onUiMessage={onUiMessage}
          />
        </div>
      );
    }
    return (
      <div className="msg tool">
        ← UI · {shortLabel(entry.render)}
      </div>
    );
  }
  if (entry.kind === 'end') {
    return (
      <div className="msg turn-end" data-testid="turn-end">
        turn ended · {entry.subtype}
      </div>
    );
  }
  if (entry.kind === 'tool-call') {
    return <ToolCallView entry={entry} />;
  }
  return <div className={`msg ${entry.kind}`}>{entry.text}</div>;
}

function ToolCallView({ entry }: { entry: ToolCallEntry }) {
  const [open, setOpen] = useState(false);
  const shortName = entry.name.replace(/^mcp__[^_]+__/, '');
  const pending = entry.result === undefined && entry.isError !== true;
  const status = entry.isError ? 'error' : pending ? 'pending' : 'ok';
  return (
    <div className={`msg tool-call tool-call-${status}`}>
      <button
        type="button"
        className="tool-call-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tool-call-chevron">{open ? '▾' : '▸'}</span>
        <span className="tool-call-name">{shortName}</span>
        <span className={`tool-call-status tool-call-status-${status}`}>
          {pending ? '…' : entry.isError ? 'error' : 'ok'}
        </span>
      </button>
      {open ? (
        <div className="tool-call-body">
          <div className="tool-call-section">
            <div className="tool-call-section-label">input</div>
            <pre className="tool-call-json">{prettyJson(entry.input)}</pre>
          </div>
          <div className="tool-call-section">
            <div className="tool-call-section-label">
              {entry.isError ? 'error result' : 'result'}
            </div>
            <pre className="tool-call-json">
              {entry.result === undefined
                ? '(awaiting)'
                : prettyJson(entry.result)}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function PanelView({
  renders,
  sandboxUrl,
  agentEndpoint,
  onUiMessage,
}: {
  renders: ReadonlyArray<RenderRef>;
  sandboxUrl: string;
  agentEndpoint: string;
  onUiMessage: (text: string, userAction?: GguiUserActionMeta) => void;
}) {
  const top = useMemo(() => renders[renders.length - 1], [renders]);
  if (!top) {
    return (
      <div className="ui-placeholder">
        <p>The rendered UI will appear here once the agent emits one.</p>
      </div>
    );
  }
  return (
    <div className="panel-frame">
      <ResourceFrame
        item={top}
        sandboxUrl={sandboxUrl}
        agentEndpoint={agentEndpoint}
        onUiMessage={onUiMessage}
        fillContainer
      />
    </div>
  );
}

/**
 * Render one MCP-Apps resource by URI. Pure spec wiring: pre-fetches
 * the spec-canonical `resources/read` (via the agent backend relay),
 * extracts the HTML body and the `_meta.ui.csp` block, and hands both
 * to `<AppRenderer>` as `html` + `sandbox.csp`. The sandbox proxy
 * applies that CSP via its `?csp=<json>` query param so the inner
 * iframe can fetch the server-declared `script-src` / `connect-src`
 * origins.
 *
 * Pre-fetching (instead of letting AppRenderer call onReadResource
 * itself) is a host-side stopgap until AppRenderer extracts CSP from
 * the resource _meta automatically. We don't parse the HTML body — the
 * resource is opaque text. CSP shape is MCP-spec
 * (`{connectDomains, resourceDomains, ...}`); replace this sample's
 * relay with any MCP-UI server's `resources/read` and the wiring
 * works unchanged.
 */
function ResourceFrame({
  item,
  sandboxUrl,
  agentEndpoint,
  fillContainer = false,
  onUiMessage,
}: {
  item: RenderRef;
  sandboxUrl: string;
  agentEndpoint: string;
  fillContainer?: boolean;
  onUiMessage?: (text: string, userAction?: GguiUserActionMeta) => void;
}) {
  // Pre-fetched resource state: `{ html, csp }`. Lazily populated by
  // the effect below; AppRenderer holds the loading placeholder until
  // both are ready.
  const [resource, setResource] = useState<
    | undefined
    | {
        readonly html: string;
        readonly csp?: {
          connectDomains?: string[];
          resourceDomains?: string[];
        };
      }
  >(undefined);

  useEffect(() => {
    let cancelled = false;
    setResource(undefined);
    void (async () => {
      try {
        const resp = await fetch(`${agentEndpoint}/relay/resources-read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uri: item.resourceUri }),
        });
        if (!resp.ok) {
          console.warn(
            '[ResourceFrame] resources/read relay non-2xx',
            resp.status,
          );
          return;
        }
        const jsonRpc = (await resp.json()) as {
          readonly result?: ReadResourceResult;
          readonly error?: { readonly message?: string };
        };
        if (cancelled) return;
        if (jsonRpc.error !== undefined || !jsonRpc.result) {
          console.warn(
            '[ResourceFrame] resources/read relay error',
            jsonRpc.error,
          );
          return;
        }
        const first = jsonRpc.result.contents?.[0];
        if (!first || typeof first !== 'object') return;
        const text = (first as { text?: unknown }).text;
        if (typeof text !== 'string') return;
        // Pluck spec-canonical `_meta.ui.csp` if the server stamped it.
        let csp:
          | {
              connectDomains?: string[];
              resourceDomains?: string[];
            }
          | undefined;
        const contentMeta = (first as { _meta?: unknown })._meta;
        if (contentMeta !== null && typeof contentMeta === 'object') {
          const uiBlock = (contentMeta as { ui?: unknown }).ui;
          if (uiBlock !== null && typeof uiBlock === 'object') {
            const cspBlock = (uiBlock as { csp?: unknown }).csp;
            if (cspBlock !== null && typeof cspBlock === 'object') {
              const c = cspBlock as {
                connectDomains?: unknown;
                resourceDomains?: unknown;
              };
              csp = {};
              if (Array.isArray(c.connectDomains)) {
                csp.connectDomains = c.connectDomains.filter(
                  (s): s is string => typeof s === 'string',
                );
              }
              if (Array.isArray(c.resourceDomains)) {
                csp.resourceDomains = c.resourceDomains.filter(
                  (s): s is string => typeof s === 'string',
                );
              }
            }
          }
        }
        setResource({ html: text, ...(csp ? { csp } : {}) });
      } catch (err) {
        console.warn('[ResourceFrame] resources/read failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentEndpoint, item.resourceUri]);

  const sandbox = useMemo(
    () => ({
      url: new URL(sandboxUrl),
      ...(resource?.csp ? { csp: resource.csp } : {}),
    }),
    [sandboxUrl, resource?.csp],
  );

  // Spec-canonical tools/call proxy. The iframe holds no MCP client
  // credential, so we relay through the agent backend (matches the
  // pattern at `/relay/resources-read`).
  const onCallTool = useCallback(
    async (
      params: CallToolRequest['params'],
      _extra: RequestHandlerExtra,
    ): Promise<CallToolResult> => {
      console.log('[ResourceFrame] tool_call', params);
      try {
        const resp = await fetch(`${agentEndpoint}/relay/tools-call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: params.name,
            arguments: params.arguments ?? {},
          }),
        });
        if (!resp.ok) {
          console.warn('[ResourceFrame] relay non-2xx', resp.status);
          return { isError: true, content: [] };
        }
        const jsonRpc = (await resp.json()) as {
          readonly result?: CallToolResult;
          readonly error?: { readonly message?: string };
        };
        if (jsonRpc.error !== undefined) {
          console.warn('[ResourceFrame] relay error envelope', jsonRpc.error);
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: jsonRpc.error.message ?? 'relay error',
              },
            ],
          };
        }
        return jsonRpc.result ?? { content: [] };
      } catch (err) {
        console.warn('[ResourceFrame] relay transport error', err);
        return { isError: true, content: [] };
      }
    },
    [agentEndpoint],
  );

  // Spec-canonical resources/read proxy. AppRenderer will call this if
  // it ever needs to re-read the resource (e.g. via the guest's
  // resources/list-changed flow). The initial mount comes from the
  // pre-fetched `resource.html` above; this handler proxies any later
  // reads through the agent backend relay.
  const onReadResource = useCallback(
    async (
      params: ReadResourceRequest['params'],
      _extra: RequestHandlerExtra,
    ): Promise<ReadResourceResult> => {
      console.log('[ResourceFrame] resources/read (post-mount)', params.uri);
      const resp = await fetch(`${agentEndpoint}/relay/resources-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: params.uri }),
      });
      if (!resp.ok) {
        throw new Error(
          `[ResourceFrame] resources/read relay non-2xx: ${resp.status}`,
        );
      }
      const jsonRpc = (await resp.json()) as {
        readonly result?: ReadResourceResult;
        readonly error?: { readonly message?: string };
      };
      if (jsonRpc.error !== undefined) {
        throw new Error(
          jsonRpc.error.message ?? '[ResourceFrame] resources/read relay error',
        );
      }
      if (!jsonRpc.result) {
        throw new Error('[ResourceFrame] resources/read relay empty result');
      }
      return jsonRpc.result;
    },
    [agentEndpoint],
  );

  const onMessage = useCallback(
    async (params: {
      role: 'user';
      content: ReadonlyArray<{
        type: string;
        text?: string;
        // Spec-canonical extension point: per the base MCP spec, every
        // content block has its own open `_meta` record. iframe-runtime
        // stamps `ai.ggui/userAction` here for queued/inline gestures.
        // The exact slice shape is validated below via
        // `isGguiUserActionMeta` — keep the surface area minimally typed
        // to match `@mcp-ui/client`'s onMessage signature.
        _meta?: { readonly [key: string]: unknown };
      }>;
    }): Promise<Record<string, unknown>> => {
      const text = params.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text ?? '')
        .join('\n')
        .trim();
      if (text.length === 0 || onUiMessage === undefined) {
        return { isError: true };
      }
      // Extract the spec-canonical `ai.ggui/userAction` slice off the
      // first content block that carries one — iframe-runtime stamps it
      // on the SAME block as the prose text. Type-guarded by the
      // protocol validator so a malformed slice fails closed (falls
      // back to prose-only delivery rather than corrupting the backend
      // signal).
      let userAction: GguiUserActionMeta | undefined;
      for (const block of params.content) {
        const slice = block._meta?.['ai.ggui/userAction'];
        if (slice !== undefined && isGguiUserActionMeta(slice)) {
          userAction = slice;
          break;
        }
      }
      onUiMessage(text, userAction);
      return {};
    },
    [onUiMessage],
  );

  return (
    <div className="render">
      <div className="render-chrome">
        <span className="render-id">{shortLabel(item)}</span>
        <span className="render-action">{item.action}</span>
      </div>
      <div
        className="render-frame"
        style={fillContainer ? { flex: 1, minHeight: 0 } : undefined}
      >
        {resource ? (
          <AppRenderer
            key={item.resourceUri}
            toolName="ggui_render"
            sandbox={sandbox}
            html={resource.html}
            onReadResource={onReadResource}
            onCallTool={onCallTool}
            onMessage={onMessage}
            onError={(err) =>
              console.warn('[ResourceFrame] AppRenderer error', err)
            }
          />
        ) : (
          <div className="render-loading" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

/**
 * Compact display label for a render. Uses the tool-use id when
 * available (matches the SDK's view of "which tool call mounted this
 * iframe"); falls back to the last URI segment so claude.ai-style
 * `ui://server/render/<id>` URIs still show something meaningful.
 */
function shortLabel(item: RenderRef): string {
  if (item.toolUseId !== undefined && item.toolUseId.length > 0) {
    return `#${item.toolUseId.slice(0, 12)}`;
  }
  const tail = item.resourceUri.split('/').filter(Boolean).pop() ?? '';
  return tail.length > 0 ? `#${tail.slice(0, 12)}` : '#render';
}
