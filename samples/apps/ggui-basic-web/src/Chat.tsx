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
   * Wired into the `useMcpAppsChat` hook for POST /agent + GET /agent?
   * chatId=X and into the iframe relay call (`/agent/relay/tools-call`).
   * The frontend stays SDK-agnostic — the backend decides which LLM it
   * drives.
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

// localStorage keys for the guest-token flow. The token survives
// reloads so a returning visitor lands on the same chats; the chatId
// is URL-resident so cross-tab links land on the same conversation.
const LS_GUEST_TOKEN = 'ggui-basic-web/guestToken';
const URL_CHAT_PARAM = 'chat';

/**
 * Read the URL `?chat=<id>` — returns the chatId when present so the
 * hook rehydrates that specific conversation, else `undefined` so the
 * server allocates a fresh id on the first POST.
 */
function getInitialChatId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const fromUrl = new URL(window.location.href).searchParams.get(
    URL_CHAT_PARAM,
  );
  return fromUrl && fromUrl.length > 0 ? fromUrl : undefined;
}

/**
 * Mint a fresh guest token via the agent backend's
 * `POST /auth/guest` mount (the spec-canonical endpoint mounted by
 * `@ggui-ai/agent-server`'s default `createGuestTokenAuth()`).
 */
async function mintGuestToken(agentEndpoint: string): Promise<string> {
  const res = await fetch(`${agentEndpoint}/auth/guest`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`POST /auth/guest returned ${res.status}`);
  }
  const body = (await res.json()) as { guestToken?: unknown };
  if (typeof body.guestToken !== 'string' || body.guestToken.length === 0) {
    throw new Error('POST /auth/guest response missing guestToken');
  }
  return body.guestToken;
}

/**
 * Chat panel + iframe area for an MCP-Apps-spec agent backend.
 *
 * Auth: bearer guest token resolved at mount (or cached in
 * localStorage). The token is the principal id the backend gates
 * chat-ownership on; clearing localStorage = fresh guest = new
 * conversations.
 */
export function Chat({ agentEndpoint, sandboxUrl }: ChatProps) {
  // Bearer token (kept in a ref so the per-fetch `getAuthToken`
  // callback always sees the latest). null = not yet minted.
  const guestTokenRef = useRef<string | null>(null);
  const [guestTokenReady, setGuestTokenReady] = useState(false);

  // Boot: pull cached token from localStorage; mint a fresh one if
  // absent. Async; the chat panel guards against premature renders
  // via `guestTokenReady`.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cached =
          typeof window !== 'undefined'
            ? window.localStorage.getItem(LS_GUEST_TOKEN)
            : null;
        if (cached && cached.length > 0) {
          guestTokenRef.current = cached;
          if (!cancelled) setGuestTokenReady(true);
          return;
        }
        const fresh = await mintGuestToken(agentEndpoint);
        if (cancelled) return;
        guestTokenRef.current = fresh;
        window.localStorage.setItem(LS_GUEST_TOKEN, fresh);
        setGuestTokenReady(true);
      } catch (err) {
        console.warn('[Chat] guest-token mint failed', err);
        // Surface as "ready" anyway — requests will 401 + show error
        // entries; better than a permanent loading state.
        if (!cancelled) setGuestTokenReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentEndpoint]);

  // Stable chat id from URL (initial) + server-allocated thereafter.
  const [chatId, setChatId] = useState<string | undefined>(() =>
    getInitialChatId(),
  );

  const getAuthToken = useCallback(
    () => guestTokenRef.current ?? undefined,
    [],
  );

  // 401 handler: clear the cached token, mint a fresh one, signal
  // retry. The hook reissues the failing request once on `true`.
  const onUnauthenticated = useCallback(async (): Promise<boolean> => {
    try {
      const fresh = await mintGuestToken(agentEndpoint);
      guestTokenRef.current = fresh;
      window.localStorage.setItem(LS_GUEST_TOKEN, fresh);
      return true;
    } catch (err) {
      console.warn('[Chat] guest-token refresh failed', err);
      return false;
    }
  }, [agentEndpoint]);

  // Stamp the server-allocated chatId into URL + state once
  // received. Quiet when the URL already carries the right id (this
  // covers the rehydration path).
  const onChatAllocated = useCallback((allocated: string) => {
    setChatId((prev) => {
      if (prev === allocated) return prev;
      const url = new URL(window.location.href);
      url.searchParams.set(URL_CHAT_PARAM, allocated);
      window.history.replaceState({}, '', url.toString());
      return allocated;
    });
  }, []);

  const { entries, renders, hostDisplayMode, sending, send, abort } =
    useMcpAppsChat({
      chatEndpoint: `${agentEndpoint}/agent`,
      snapshotEndpoint: `${agentEndpoint}/agent`,
      ...(chatId !== undefined ? { chatId } : {}),
      onChatAllocated,
      getAuthToken,
      onUnauthenticated,
    });

  const [prompt, setPrompt] = useState('');
  const [layout, setLayout] = useState<LayoutMode>('inline');
  const historyRef = useRef<HTMLDivElement | null>(null);

  // `userAction` is the spec-canonical `_meta.ai.ggui/userAction` slice
  // iframe-runtime stamps on `ui/message` envelopes when a click can't
  // reach the agent via the consume pipe. Forwarded to `send(...)` so
  // the agent-server library synthesizes the imperative-first directive
  // server-side.
  const onUiMessage = useCallback(
    (text: string, userAction?: GguiUserActionMeta) => {
      void send(text, userAction !== undefined ? { userAction } : undefined);
    },
    [send],
  );

  useEffect(() => {
    if (hostDisplayMode === undefined) return;
    setLayout(hostDisplayMode === 'inline' ? 'inline' : 'panel');
  }, [hostDisplayMode]);

  useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [entries.length]);

  const newSession = useCallback(() => {
    // Drop the URL chat param + local state. Next POST allocates a
    // fresh server-side chatId, which lands via onChatAllocated.
    const url = new URL(window.location.href);
    url.searchParams.delete(URL_CHAT_PARAM);
    window.history.replaceState({}, '', url.toString());
    setChatId(undefined);
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

  if (!guestTokenReady) {
    return (
      <div style={{ padding: 24, color: '#888', fontFamily: 'system-ui' }}>
        Provisioning guest session…
      </div>
    );
  }

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
              getAuthToken={getAuthToken}
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
            getAuthToken={getAuthToken}
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
  getAuthToken,
  onUiMessage,
}: {
  entry: ChatEntry;
  renderInline: boolean;
  sandboxUrl: string;
  agentEndpoint: string;
  getAuthToken: () => string | undefined;
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
            getAuthToken={getAuthToken}
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
  getAuthToken,
  onUiMessage,
}: {
  renders: ReadonlyArray<RenderRef>;
  sandboxUrl: string;
  agentEndpoint: string;
  getAuthToken: () => string | undefined;
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
        getAuthToken={getAuthToken}
        onUiMessage={onUiMessage}
        fillContainer
      />
    </div>
  );
}

/**
 * Render one MCP-Apps resource. Prefers the inlined resource
 * `@ggui-ai/agent-server`'s tool-result interceptor stamped on
 * `_meta.ui.resource` (zero-round-trip mount). Falls back to a
 * `/agent/relay/resources-read` proxy when the interceptor didn't
 * inline (rare — typically only on restored entries from an older
 * snapshot, or when the upstream MCP's resources/read failed
 * server-side).
 */
function ResourceFrame({
  item,
  sandboxUrl,
  agentEndpoint,
  getAuthToken,
  fillContainer = false,
  onUiMessage,
}: {
  item: RenderRef;
  sandboxUrl: string;
  agentEndpoint: string;
  getAuthToken: () => string | undefined;
  fillContainer?: boolean;
  onUiMessage?: (text: string, userAction?: GguiUserActionMeta) => void;
}) {
  // Inlined resource ride-along from the library's interceptor wins.
  // No fetch needed — render straight from `inlinedResource.text`.
  const html = item.inlinedResource?.text;
  const inlinedCsp = item.inlinedResource?.csp;

  const sandbox = useMemo(() => {
    if (!inlinedCsp) return { url: new URL(sandboxUrl) };
    // SandboxConfig wants mutable string[] arrays; the RenderRef
    // shape keeps them readonly so reassignment doesn't leak. Copy
    // here at the boundary.
    const csp: {
      connectDomains?: string[];
      resourceDomains?: string[];
    } = {};
    if (inlinedCsp.connectDomains) {
      csp.connectDomains = [...inlinedCsp.connectDomains];
    }
    if (inlinedCsp.resourceDomains) {
      csp.resourceDomains = [...inlinedCsp.resourceDomains];
    }
    return { url: new URL(sandboxUrl), csp };
  }, [sandboxUrl, inlinedCsp]);

  // Spec-canonical tools/call proxy. The iframe holds no MCP client
  // credential, so we relay through the agent backend.
  const onCallTool = useCallback(
    async (
      params: CallToolRequest['params'],
      _extra: RequestHandlerExtra,
    ): Promise<CallToolResult> => {
      console.log('[ResourceFrame] tool_call', params);
      try {
        const token = getAuthToken();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        const resp = await fetch(`${agentEndpoint}/agent/relay/tools-call`, {
          method: 'POST',
          headers,
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
    [agentEndpoint, getAuthToken],
  );

  // The frontend's `onReadResource` callback shouldn't normally fire
  // any more — the library inlines the iframe HTML alongside every
  // tool result. Keep a defensive implementation that throws a
  // descriptive error, so any guest-initiated `resources/list-changed`
  // → re-read surfaces a clear message in dev tools rather than
  // hanging.
  const onReadResource = useCallback(
    async (
      params: ReadResourceRequest['params'],
      _extra: RequestHandlerExtra,
    ): Promise<ReadResourceResult> => {
      throw new Error(
        `[ResourceFrame] resources/read for ${params.uri} requested ` +
          `post-mount, but the host doesnt operate a relay endpoint. ` +
          `The agent-server library inlines resources on the FIRST tool ` +
          `result; guest-initiated re-reads need the host to add a custom ` +
          `relay (or upgrade to AppRenderer's built-in MCP client).`,
      );
    },
    [],
  );

  const onMessage = useCallback(
    async (params: {
      role: 'user';
      content: ReadonlyArray<{
        type: string;
        text?: string;
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
        {html !== undefined ? (
          <AppRenderer
            key={item.resourceUri}
            toolName="ggui_render"
            sandbox={sandbox}
            html={html}
            onReadResource={onReadResource}
            onCallTool={onCallTool}
            onMessage={onMessage}
            onError={(err) =>
              console.warn('[ResourceFrame] AppRenderer error', err)
            }
          />
        ) : (
          <div className="render-loading" aria-hidden="true">
            <p style={{ padding: 12, fontSize: 13, color: '#888' }}>
              Resource not inlined — the agent-server didn't pre-fetch the
              iframe HTML for <code>{item.resourceUri}</code>.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function shortLabel(item: RenderRef): string {
  if (item.toolUseId !== undefined && item.toolUseId.length > 0) {
    return `#${item.toolUseId.slice(0, 12)}`;
  }
  const tail = item.resourceUri.split('/').filter(Boolean).pop() ?? '';
  return tail.length > 0 ? `#${tail.slice(0, 12)}` : '#render';
}
