/**
 * ChatShell — a thread-backed reference chat UI for integrators.
 *
 * ─────────────────────────────────────────────────────────────────────
 * TWO ChatShells live in this repo — DO NOT confuse them:
 *   - THIS FILE (`chat-thread/shells/chat/ChatShell.tsx`) — THREAD-backed.
 *     Consumes useChatThread + MessageStorageAdapter. Exported at
 *     `@ggui-ai/react/chat-thread/shells/chat`.
 *   - The one at `shells/ChatShell.tsx` — INVOKE-SSE-backed. Consumes
 *     useInvoke + extractUiMoments + `<McpAppIframe>`. Exported at
 *     `@ggui-ai/react` root + `@ggui-ai/react/shells`.
 *
 * Both ship today. Consumers pick based on data model:
 *   invoke-SSE driven → the other shell; thread-backed → this file.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Deliberately small and generic: reads `useChatThread()`, renders a
 * timeline + composer + inline error banner, forwards user input back
 * through `send()`. No product-specific theming, no product logic, no
 * design-system imports — integrators who want richer UX either
 * compose on top of `useChatThread()` directly or wrap ChatShell.
 *
 * Web variant: DOM primitives, `scrollIntoView` for focus, composer is
 * a plain `<form>` with Enter-to-send. RN variant in the twin package
 * matches the same prop surface with FlatList/TextInput.
 */
/** @jsxRuntime automatic */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useChatThread } from '../../useChatThread';
import type { ChatThreadMessage } from '../../useChatThread';

export interface ChatShellProps {
  /** One-shot scroll target (consumed on mount; host should clear after). */
  focusMessageId?: string;
  /** Deterministic transitions (no smooth scroll). */
  reducedMotion?: boolean;
}

export function ChatShell({ focusMessageId, reducedMotion }: ChatShellProps = {}) {
  const { messages, send, isStreaming, error } = useChatThread();
  const listRef = useRef<HTMLUListElement | null>(null);
  const hasScrolledRef = useRef(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!focusMessageId || hasScrolledRef.current || !listRef.current) return;
    const el = listRef.current.querySelector(
      `[data-ggui-message-id="${CSS.escape(focusMessageId)}"]`,
    );
    if (!el) return;
    (el as HTMLElement).scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'center',
    });
    hasScrolledRef.current = true;
  }, [focusMessageId, messages, reducedMotion]);

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = draft.trim();
      if (!trimmed || isStreaming) return;
      void send(trimmed);
      setDraft('');
    },
    [draft, isStreaming, send],
  );

  return (
    <div data-ggui-shell="chat" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {error && (
        <div role="alert" data-ggui-shell-error style={{ padding: 8, background: '#fee', color: '#900' }}>
          {error.message}
        </div>
      )}
      <ul
        ref={listRef}
        data-ggui-shell-list
        style={{ flex: 1, overflowY: 'auto', listStyle: 'none', margin: 0, padding: 8 }}
      >
        {messages.map((m) => (
          <li key={m.id} data-ggui-message-id={m.id} data-ggui-message-role={m.role}>
            <MessageBody message={m} />
          </li>
        ))}
      </ul>
      <form onSubmit={onSubmit} data-ggui-shell-composer style={{ display: 'flex', gap: 8, padding: 8 }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={isStreaming}
          placeholder={isStreaming ? 'Agent is responding…' : 'Send a message'}
          style={{ flex: 1 }}
          data-ggui-shell-input
        />
        <button type="submit" disabled={isStreaming || draft.trim().length === 0}>
          Send
        </button>
      </form>
    </div>
  );
}

function MessageBody({ message }: { message: ChatThreadMessage }): ReactNode {
  return (
    <>
      {message.blocks.map((b, i) => {
        if (b.type === 'text') {
          return (
            <p key={i} data-ggui-block="text" style={message.isPending ? { opacity: 0.6 } : undefined}>
              {b.text}
            </p>
          );
        }
        if (b.type === 'tool_use') {
          return (
            <pre key={i} data-ggui-block="tool_use" style={{ fontSize: 12, opacity: 0.7 }}>
              {`[${b.name}]`}
            </pre>
          );
        }
        if (b.type === 'tool_result') {
          return (
            <div key={i} data-ggui-block="tool_result" data-ggui-card-snapshot>
              {message.cardSnapshot ? `[card ready]` : `[card pending]`}
            </div>
          );
        }
        return null;
      })}
    </>
  );
}
