'use client';
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
  useMcpAppsChat,
  type ChatEntry,
  type RenderRef,
  type ToolCallEntry,
} from '@ggui-ai/react/chat-helpers';
import { Render } from './Render';

type LayoutMode = 'inline' | 'panel';

interface ChatProps {
  /**
   * MCP-Apps-spec agent backend base URL (e.g.
   * `http://localhost:6790`). Wired into the `useMcpAppsChat` hook for
   * POST /chat + GET /chat?chatId=X and into each `<Render>` for the
   * relay endpoint. The frontend stays SDK-agnostic — the backend
   * decides which LLM it drives.
   */
  readonly agentEndpoint: string;
}

/**
 * Stable per-conversation chat id. Resolution mirrors the sample-agent
 * `src-ui/useChat.ts` pattern, ported for Next.js's App Router:
 *
 *   1. URL `?chat=<id>` query param — authoritative. Every link to
 *      "this conversation" carries the id, so opening the URL in any
 *      tab/window restores that specific conversation, the same way
 *      claude.ai's `/c/<id>` URLs work.
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
 * Brand-agnostic by design: the sample-agent backends only know about
 * SDKMessage[] storage and the relay path; every ggui-shape parse —
 * `_meta` walking, render-id dedup, host-display-mode pickup, wsToken-
 * gated state refetch — lives in `useMcpAppsChat` (in
 * `@ggui-ai/react/chat-helpers`). This component is a thin chrome over
 * the hook plus `<Render>` mount points.
 *
 * Pairs with `app/page.tsx` which owns the sandbox-proxy URL fetch and
 * the ThemeProvider wrap.
 */
export function Chat({ agentEndpoint, sandboxUrl }: ChatProps & { readonly sandboxUrl: string }) {
  // Resolve the chatId AFTER mount via useEffect — the initial render
  // runs on the server (with a placeholder) or pre-hydration (where
  // crypto.randomUUID + URL APIs are both available but we still want
  // to keep server-rendered HTML byte-identical to the first client
  // render). After mount we read / mint / stamp the URL chatId and
  // rebind the hook.
  const [chatId, setChatId] = useState<string>('ssr-placeholder');
  useEffect(() => {
    setChatId(getOrCreateChatId());
  }, []);

  const {
    entries,
    renders,
    hostDisplayMode,
    sending,
    send,
    abort,
  } = useMcpAppsChat({
    chatEndpoint: `${agentEndpoint}/chat`,
    snapshotEndpoint: `${agentEndpoint}/chat`,
    stateEndpointPrefix: `${agentEndpoint}/api/renders`,
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
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
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
          <Render
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
        ← UI #{entry.render.renderId.slice(0, 12)} · {entry.render.action}
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
              {entry.result === undefined ? '(awaiting)' : prettyJson(entry.result)}
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
        <p>
          The rendered UI will appear here once the agent calls{' '}
          <code>ggui_render</code>.
        </p>
      </div>
    );
  }
  return (
    <div className="panel-frame">
      <Render
        item={top}
        sandboxUrl={sandboxUrl}
        agentEndpoint={agentEndpoint}
        onUiMessage={onUiMessage}
        fillContainer
      />
    </div>
  );
}
