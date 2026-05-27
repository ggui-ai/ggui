import { useCallback, useEffect, useRef, useState, type FormEvent, type ChangeEvent, type KeyboardEvent } from 'react';
import { useChat } from './useChat';
import { StackItem } from './StackItem';
import type { ChatEntry, LayoutMode, StackItemRef, ToolCallEntry } from './types';

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
  return 'http://localhost:7790/sandbox.html';
}

export function Chat() {
  const { entries, stackItems, hostDisplayMode, sending, send, abort } =
    useChat();
  const [prompt, setPrompt] = useState('');
  const [layout, setLayout] = useState<LayoutMode>('inline');
  const historyRef = useRef<HTMLDivElement | null>(null);
  const sandboxUrl = resolveSandboxUrl();

  // `ui/message` from an iframe component (MCP-Apps SEP-1865) → fire a
  // fresh chat turn. The iframe's emitted text appears in the chat log
  // as a user message and the agent processes it through the usual
  // `/chat` SSE round-trip. Passed down through `<StackItem
  // onUiMessage>`.
  const onUiMessage = useCallback(
    (text: string) => {
      void send(text);
    },
    [send],
  );

  // Host-side presentation hint pickup.
  // `_meta.ui.displayMode` is the spec-native MCP-Apps SEP-1865 per-push
  // hint, stamped from `App.defaultDisplayMode` (and/or per-push agent
  // override) on the server side. We auto-switch our `Inline | Panel`
  // layout to match: `'fullscreen'` / `'pip'` → Panel, `'inline'` →
  // Inline. The user's manual toggle still wins (sticky until the next
  // push that carries a hint).
  useEffect(() => {
    if (hostDisplayMode === undefined) return;
    setLayout(hostDisplayMode === 'inline' ? 'inline' : 'panel');
  }, [hostDisplayMode]);

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
            <p className="subtitle">Claude Agent SDK · ggui MCP</p>
          </div>
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
        </header>

        <div className="history" ref={historyRef} role="log" aria-live="polite">
          {entries.length === 0 ? <EmptyState /> : null}
          {entries.map((entry) => (
            <ChatEntryView
              key={entry.id}
              entry={entry}
              renderStackInline={layout === 'inline'}
              sandboxUrl={sandboxUrl}
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

      {/* Panel mode renders the right pane with the top-of-stack item;
       * inline mode is full-width chat with stack-items embedded
       * between conversation turns. */}
      {layout === 'panel' ? (
        <main className="ui-pane">
          <PanelView
            stackItems={stackItems}
            sandboxUrl={sandboxUrl}
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

/**
 * Render one chat entry. In inline mode, stack-item entries embed the
 * iframe directly between conversation turns. In panel mode, stack-item
 * entries collapse to a compact marker.
 */
function ChatEntryView({
  entry,
  renderStackInline,
  sandboxUrl,
  onUiMessage,
}: {
  entry: ChatEntry;
  renderStackInline: boolean;
  sandboxUrl: string;
  onUiMessage: (text: string) => void;
}) {
  if (entry.kind === 'stack-item') {
    if (renderStackInline) {
      return (
        <div className="msg stack-item-wrap">
          <StackItem
            item={entry.stackItem}
            sandboxUrl={sandboxUrl}
            onUiMessage={onUiMessage}
          />
        </div>
      );
    }
    return (
      <div className="msg tool">
        ← UI #{entry.stackItem.stackItemId.slice(0, 12)} ·{' '}
        {entry.stackItem.action}
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
 * Right-pane mount — shows the top-of-stack item large. Earlier items
 * stay accessible as chat-history markers; only one iframe lives in
 * the panel at a time. Empty stack ⇒ placeholder.
 */
function PanelView({
  stackItems,
  sandboxUrl,
  onUiMessage,
}: {
  stackItems: ReadonlyArray<StackItemRef>;
  sandboxUrl: string;
  onUiMessage: (text: string) => void;
}) {
  const top = stackItems[stackItems.length - 1];
  if (!top) {
    return (
      <div className="ui-placeholder">
        <p>
          The rendered UI will appear here once the agent calls{' '}
          <code>ggui_push</code>.
        </p>
      </div>
    );
  }
  return (
    <div className="panel-frame">
      <StackItem
        item={top}
        sandboxUrl={sandboxUrl}
        onUiMessage={onUiMessage}
        fillContainer
      />
    </div>
  );
}
