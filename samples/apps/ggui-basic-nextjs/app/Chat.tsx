'use client';
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
}

/**
 * Stable per-conversation chat id. Resolution:
 *
 *   1. URL `?chat=<id>` query param — authoritative. Every link to
 *      "this conversation" carries the id, so opening the URL in any
 *      tab/window restores that specific conversation.
 *   2. Mint fresh UUID and stamp it into the URL.
 *
 * SSR-safe: returns a throwaway id when neither URL API nor crypto is
 * available; the resulting chat is single-turn isolated.
 */
const URL_CHAT_PARAM = 'chat';

function getOrCreateChatId(): string {
  if (typeof window === 'undefined') {
    // SSR pre-hydration tick — useEffect picks up the real id after
    // mount; this throwaway never escapes the initial render.
    return 'ssr-placeholder';
  }
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get(URL_CHAT_PARAM);
    if (fromUrl && fromUrl.length > 0) return fromUrl;
    const resolved = crypto.randomUUID();
    url.searchParams.set(URL_CHAT_PARAM, resolved);
    window.history.replaceState({}, '', url.toString());
    return resolved;
  } catch {
    return crypto.randomUUID();
  }
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
export function Chat({
  agentEndpoint,
  sandboxUrl,
}: ChatProps & { readonly sandboxUrl: string }) {
  // Resolve the chatId AFTER mount — the initial render runs on the
  // server (with a placeholder); after mount we read / mint / stamp
  // the URL chatId and rebind the hook.
  const [chatId, setChatId] = useState<string>('ssr-placeholder');
  useEffect(() => {
    setChatId(getOrCreateChatId());
  }, []);

  const { entries, renders, hostDisplayMode, sending, send, abort } =
    useMcpAppsChat({
      chatEndpoint: `${agentEndpoint}/chat`,
      snapshotEndpoint: `${agentEndpoint}/chat`,
      chatId,
    });

  const [prompt, setPrompt] = useState('');
  const [layout, setLayout] = useState<LayoutMode>('inline');
  const historyRef = useRef<HTMLDivElement | null>(null);

  const onUiMessage = useCallback(
    (text: string) => {
      void send(text);
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
    window.location.href = `/?${URL_CHAT_PARAM}=${encodeURIComponent(fresh)}`;
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
  onUiMessage: (text: string) => void;
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
  onUiMessage: (text: string) => void;
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
 * Render one MCP-Apps resource by URI. Pure spec wiring: passes
 * `toolResourceUri` to `<AppRenderer>` and a relay-backed
 * `onReadResource` that proxies the read through the agent backend. No
 * vendor-specific knowledge — replace `@ggui-ai/react`'s `AppRenderer`
 * re-export with `@mcp-ui/client`'s direct import and this component
 * keeps working against any MCP-Apps-spec server.
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
  onUiMessage?: (text: string) => void;
}) {
  const sandbox = useMemo(
    () => ({ url: new URL(sandboxUrl) }),
    [sandboxUrl],
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

  // Spec-canonical resources/read proxy. AppRenderer calls this when it
  // sees `toolResourceUri` set, gets back the iframe HTML, and srcdocs
  // it into the inner sandbox iframe.
  const onReadResource = useCallback(
    async (
      params: ReadResourceRequest['params'],
      _extra: RequestHandlerExtra,
    ): Promise<ReadResourceResult> => {
      console.log('[ResourceFrame] resources/read', params.uri);
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
      content: ReadonlyArray<{ type: string; text?: string }>;
    }): Promise<Record<string, unknown>> => {
      const text = params.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text ?? '')
        .join('\n')
        .trim();
      if (text.length === 0 || onUiMessage === undefined) {
        return { isError: true };
      }
      onUiMessage(text);
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
        <AppRenderer
          key={item.resourceUri}
          toolName="ggui_render"
          sandbox={sandbox}
          toolResourceUri={item.resourceUri}
          onReadResource={onReadResource}
          onCallTool={onCallTool}
          onMessage={onMessage}
          onError={(err) =>
            console.warn('[ResourceFrame] AppRenderer error', err)
          }
        />
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
