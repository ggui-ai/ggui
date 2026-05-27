import { useEffect, useRef, useState, type FormEvent, type ChangeEvent, type KeyboardEvent } from 'react';
import { useChat } from './useChat';
import { Render } from './Render';
import type { ChatEntry, LayoutMode, RenderRef, ToolCallEntry } from './types';

/**
 * Sandbox-proxy URL injected by the server-rendered host page (see
 * `src/server.ts`). The sample's `index.html` template gets the URL
 * substituted into a global so the AppRenderer can mount on a
 * different-origin iframe sandbox per MCP Apps spec. Falls back to
 * `http://localhost:7790/sandbox.html` for dev usage when the global
 * isn't injected.
 */
declare global {
  // eslint-disable-next-line no-var
  var GGUI_SANDBOX_PROXY_URL: string | undefined;
}
function resolveSandboxUrl(): string {
  if (
    typeof globalThis.GGUI_SANDBOX_PROXY_URL === 'string' &&
    globalThis.GGUI_SANDBOX_PROXY_URL.length > 0
  ) {
    return globalThis.GGUI_SANDBOX_PROXY_URL;
  }
  return 'http://localhost:7792/sandbox.html';
}

export function Chat() {
  const { entries, renders, sending, send, abort } = useChat();
  const [prompt, setPrompt] = useState('');
  const [layout, setLayout] = useState<LayoutMode>('inline');
  const historyRef = useRef<HTMLDivElement | null>(null);
  const sandboxUrl = resolveSandboxUrl();

  // Auto-scroll the chat log on new entries.
  useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [entries.length]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || sending) return;
    setPrompt('');
    void send(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter to send, Shift+Enter to insert a newline. Mirrors claude.ai
    // / ChatGPT / Slack conventions.
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
            <h1>Sample Agent</h1>
            <p className="subtitle">Google ADK · ggui MCP</p>
          </div>
          <div
            className="layout-toggle"
            role="group"
            aria-label="Layout"
          >
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
        </header>

        <div className="history" ref={historyRef} role="log" aria-live="polite">
          {entries.length === 0 ? <EmptyState /> : null}
          {entries.map((entry) => (
            <ChatEntryView
              key={entry.id}
              entry={entry}
              renderInline={layout === 'inline'}
              sandboxUrl={sandboxUrl}
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
          {/*
           * Dual-role button: submits a new prompt when idle, aborts
           * the in-flight stream when sending. Type flips between
           * `submit` and `button` so a keyboard Enter while idle still
           * triggers form submit, while a click during sending fires
           * onClick={abort} without re-submitting an empty prompt.
           * Disabled only when idle AND no prompt — never when sending
           * (the user MUST be able to click stop).
           */}
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

      {/* Panel mode renders the right pane; inline mode is full-width
       * chat (no panel at all). */}
      {layout === 'panel' ? (
        <main className="ui-pane">
          <PanelView renders={renders} sandboxUrl={sandboxUrl} />
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

/**
 * Render one chat entry. In inline mode, render entries embed the
 * iframe directly between conversation turns. In panel mode, render
 * entries collapse to a compact marker.
 */
function ChatEntryView({
  entry,
  renderInline,
  sandboxUrl,
}: {
  entry: ChatEntry;
  renderInline: boolean;
  sandboxUrl: string;
}) {
  if (entry.kind === 'render') {
    if (renderInline) {
      return (
        <div className="msg render-wrap">
          <Render item={entry.render} sandboxUrl={sandboxUrl} />
        </div>
      );
    }
    return (
      <div className="msg tool">
        ← UI #{entry.render.renderId.slice(0, 12)} ·{' '}
        {entry.render.action}
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

/**
 * Tool-call row: compact one-liner summary with an expand button that
 * reveals the full call input + result JSON. Helpful for debugging
 * what the agent is actually sending/receiving on each wire call.
 *
 * State is local — no chat-log mutation needed. Each tool-call gets
 * its own expand state; the disclosure persists across re-renders by
 * being inside the React component tree.
 */
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

/**
 * Panel mode: render the most-recent render large in the right pane.
 * Older renders remain accessible via the chat-history compact
 * markers, but only one iframe is mounted at a time.
 */
function PanelView({
  renders,
  sandboxUrl,
}: {
  renders: ReadonlyArray<RenderRef>;
  sandboxUrl: string;
}) {
  const top = renders[renders.length - 1];
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
      <Render item={top} sandboxUrl={sandboxUrl} fillContainer />
    </div>
  );
}
