/**
 * ChatShell — invoke-SSE composite chat shell.
 *
 * ─────────────────────────────────────────────────────────────────────
 * TWO ChatShells live in this repo — DO NOT confuse them:
 *   - THIS FILE (`shells/ChatShell.tsx`) — the INVOKE-SSE-backed
 *     composite. Consumes `useInvoke` + `extractUiMoments` +
 *     `<McpAppIframe>`. Exported at `@ggui-ai/react` root +
 *     `@ggui-ai/react/shells`.
 *   - The one at `chat-thread/shells/chat/ChatShell.tsx` — THREAD-
 *     backed. Consumes useChatThread + MessageStorageAdapter; used by
 *     `<ChatThreadProvider>`-scoped surfaces. Exported at
 *     `@ggui-ai/react/chat-thread/shells/chat`.
 *
 * Both ship today. Consumers pick based on data model:
 *   invoke-SSE driven → this file; thread-backed → the chat-thread twin.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Data flow:
 *
 *   1. `useInvoke()` POSTs user messages to the agent's `/invoke` endpoint
 *      (resolved from `useGguiContext().appConfig.endpointUrl`) and reads
 *      the Anthropic-style SSE stream. Messages accumulate in the hook's
 *      `messages: ConversationMessage[]` state.
 *   2. `extractUiMoments(messages, {sessionResourceOrigin})` scans
 *      `tool_result` blocks and returns the set of `<McpAppIframe>` mounts
 *      the shell should render. See `../invoke/ui-moments.ts`.
 *   3. Render loop interleaves text bubbles (from `text` blocks) with
 *      `<McpAppIframe>` cards (from UiMoments) in content-block order.
 *      Session-resource URL moments render directly; bootstrap-inline
 *      moments are supported by the helper but not yet rendered here
 *      (they need a client-side thin-shell HTML builder).
 *
 * Accepts an optional `primaryColor` prop — the accent color from the
 * app's configured theme. All glass-morphism accents (gradients, glows,
 * shadows) derive from this single color. Defaults to the ggui signature
 * violet.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ResourceContents } from '@modelcontextprotocol/sdk/types.js';
import { getThemeCss } from '@ggui-ai/design/rendering';
import type { ShellTheme } from './theme';
import { rgba } from './theme';
import { useChatInput, useShellTheme } from './hooks';
import {
  SendIcon, ExpandIcon, TypingIndicator, ConnectionDot,
  renderMarkdown, TYPING_BOUNCE_CSS,
} from './shared';
import { useGguiContext } from '../context/GguiContext';
import { useInvoke, type ConversationMessage } from '../invoke/useInvoke';
import { extractUiMoments, type UiMoment } from '../invoke/ui-moments';
import { McpAppIframe } from '../McpAppIframe/McpAppIframe';

/* ── Props ── */

export interface ChatShellProps {
  /** App's primary accent color (hex). Defaults to ggui signature violet. */
  primaryColor?: string;
  /**
   * Override the invoke endpoint URL. When absent, falls through to
   * `useGguiContext().appConfig.endpointUrl` (the usual path when the
   * shell is mounted inside `<GguiProvider>` with a configured app).
   */
  endpointUrl?: string;
  /**
   * Origin to prefix session-resource URLs with — the host's Lambda /
   * `ggui serve` endpoint serving `/ggui/session-resource/item/<sid>/<stackItemId>`.
   * When absent, defaults to:
   *   (1) `useGguiContext().apiBaseUrl` if the provider supplies one;
   *   (2) otherwise, the origin component of the resolved `endpointUrl`.
   * Option (b) UI moments without a valid origin are dropped silently by
   * {@link extractUiMoments}.
   */
  sessionResourceOrigin?: string;
}

/* ── Row types (presentation-only; distinct from invoke-SSE shapes) ── */

/** @internal — exported for ChatShell's unit tests. Not part of the public package API. */
export type ChatRow =
  | { readonly kind: 'text'; readonly key: string; readonly sender: 'user' | 'agent'; readonly text: string; readonly streaming: boolean }
  | { readonly kind: 'ui-moment'; readonly key: string; readonly moment: UiMoment };

/**
 * Flatten a ConversationMessage[] + UiMoment[] into a render-ordered
 * row list. Walks each message's content blocks: text → text row,
 * tool_result → lookup UiMoment by tool_use_id (if any) → ui-moment row
 * or drop. User messages always produce exactly one text row (the
 * send() input). The assistant's trailing text row inherits the
 * message's `isStreaming` flag so the UI can show a streaming caret.
 *
 * @internal — exported for ChatShell's unit tests. Not part of the public
 * package API.
 */
export function buildRows(
  messages: readonly ConversationMessage[],
  uiMoments: readonly UiMoment[],
): ChatRow[] {
  const byToolUseId = new Map<string, UiMoment>();
  for (const m of uiMoments) byToolUseId.set(m.key, m);

  const rows: ChatRow[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      // User turns carry a single text block per send(); concatenate any
      // multi-block edge-case into one bubble for simplicity.
      const text = msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.length > 0) {
        rows.push({ kind: 'text', key: `${msg.id}:user`, sender: 'user', text, streaming: false });
      }
      continue;
    }
    // Assistant — emit one row per content block so text can interleave
    // with UI moments in the natural order the agent produced.
    let blockIndex = 0;
    for (const block of msg.content) {
      if (block.type === 'text') {
        if (block.text.length > 0) {
          rows.push({
            kind: 'text',
            key: `${msg.id}:${blockIndex}`,
            sender: 'agent',
            text: block.text,
            streaming: msg.isStreaming,
          });
        }
      } else if (block.type === 'tool_result') {
        const moment = byToolUseId.get(block.tool_use_id);
        if (moment) {
          rows.push({
            kind: 'ui-moment',
            key: `${msg.id}:${blockIndex}:${moment.key}`,
            moment,
          });
        }
        // Non-ggui tool_results (search hits, errors, raw text tools) are
        // agent-internal; shell keeps them out of the user-facing timeline.
      }
      // tool_use blocks are internal — never rendered.
      blockIndex += 1;
    }
  }
  return rows;
}

/** Derive session-resource origin from explicit prop → context apiBaseUrl → endpointUrl origin. */
function resolveSessionResourceOrigin(
  explicit: string | undefined,
  apiBaseUrl: string | undefined,
  endpointUrl: string | undefined,
): string | undefined {
  if (explicit) return explicit;
  if (apiBaseUrl) return apiBaseUrl;
  if (!endpointUrl) return undefined;
  try {
    return new URL(endpointUrl).origin;
  } catch {
    return undefined;
  }
}

/** Map a UiMoment to the `resource` prop `<McpAppIframe>` consumes. */
function momentToResource(moment: UiMoment): ResourceContents | null {
  if (moment.source.kind === 'session-resource') {
    return {
      uri: moment.source.url,
      mimeType: 'text/html',
    };
  }
  // Inline-bootstrap moments — the helper emits them so consumers on
  // the toolResultPush path aren't silently dropped at the extraction
  // step, but rendering them requires a client-side thin-shell HTML
  // builder that this shell does not implement (a third copy of the
  // shell-building logic belongs in a shared package, not here).
  // Returning null causes the card to render an empty body until that
  // builder exists.
  return null;
}

/* ── Themed styles ── */

function buildStyles(t: ShellTheme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex', flexDirection: 'column', height: '100%', width: '100%',
      position: 'relative', backgroundColor: '#FFFFFF',
      fontFamily: '"Pretendard Variable", "Pretendard", system-ui, -apple-system, sans-serif',
      color: '#0A0A0A',
    },
    header: {
      padding: '12px 16px', borderBottom: '1px solid #E5E5E5',
      backgroundColor: '#FAFAFA',
    },
    headerContent: { display: 'flex', alignItems: 'center', gap: 12 },
    agentAvatar: {
      width: 38, height: 38, borderRadius: '50%',
      background: `linear-gradient(135deg, ${t.hex} 0%, ${t.darkHex} 100%)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      boxShadow: `0 2px 8px ${rgba(t.r, t.g, t.b, 0.25)}`,
    },
    avatarText: { color: '#fff', fontSize: 15, fontWeight: '700' as const, letterSpacing: '0.02em' },
    agentName: { fontSize: 15, fontWeight: '700' as const, color: '#0A0A0A', letterSpacing: '-0.01em' },
    statusDot: { fontSize: 12, display: 'flex', alignItems: 'center' },
    messageList: {
      flex: 1, overflowY: 'auto' as const, padding: '16px',
      display: 'flex', flexDirection: 'column' as const, gap: 10,
    },
    emptyState: {
      display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1,
      color: '#A1A1A1', fontSize: 14, fontStyle: 'italic',
    },
    messageRow: { display: 'flex', width: '100%' },
    bubble: {
      padding: '12px 16px', borderRadius: 18,
      fontSize: 14, lineHeight: '1.55', wordBreak: 'break-word' as const, whiteSpace: 'pre-wrap' as const,
    },
    userBubble: {
      background: `linear-gradient(135deg, ${t.hex} 0%, ${t.darkHex} 100%)`,
      color: '#FAFAFA', borderBottomRightRadius: 4,
      boxShadow: `0 2px 12px ${rgba(t.r, t.g, t.b, 0.2)}`,
    },
    agentBubble: {
      backgroundColor: '#F5F5F5', color: '#0A0A0A',
      border: '1px solid #E5E5E5', borderBottomLeftRadius: 4,
    },
    componentCard: {
      width: '100%', maxWidth: '100%', borderRadius: 14,
      border: `1px solid #E5E5E5`,
      backgroundColor: '#FFFFFF', overflow: 'hidden',
      boxShadow: `0 2px 8px rgba(0,0,0,0.06)`,
    },
    componentCardHeader: {
      padding: '8px 14px', fontSize: 11, fontWeight: '700' as const,
      color: t.hex, letterSpacing: '0.05em', textTransform: 'uppercase' as const,
      borderBottom: '1px solid #E5E5E5',
      backgroundColor: '#FAFAFA',
    },
    componentCardBody: { minHeight: 220, display: 'flex' },
    componentCardEmpty: {
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#A1A1A1', fontSize: 12, fontStyle: 'italic',
    },
    inputBar: {
      display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px',
      borderTop: '1px solid #E5E5E5',
      backgroundColor: '#FAFAFA',
    },
    input: {
      flex: 1, padding: '11px 16px', borderRadius: 24,
      border: '1px solid #E5E5E5', fontSize: 14, outline: 'none',
      backgroundColor: '#FFFFFF', color: '#0A0A0A',
      boxShadow: 'none',
      transition: 'border-color 0.2s, box-shadow 0.2s',
    },
    sendButton: {
      width: 42, height: 42, borderRadius: '50%', border: 'none',
      background: `linear-gradient(135deg, ${t.hex} 0%, ${t.darkHex} 100%)`,
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', flexShrink: 0,
      boxShadow: `0 2px 8px ${rgba(t.r, t.g, t.b, 0.25)}`,
      transition: 'transform 0.15s, box-shadow 0.15s',
    },
    overlay: {
      position: 'absolute' as const, inset: 0, zIndex: 10,
      display: 'flex', flexDirection: 'column' as const, backgroundColor: '#FFFFFF',
    },
    overlayBar: {
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
      borderBottom: '1px solid #E5E5E5',
      backgroundColor: '#FAFAFA',
    },
    backButton: {
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px',
      borderRadius: 8, border: '1px solid #E5E5E5',
      backgroundColor: '#F5F5F5', fontSize: 13, fontWeight: '500' as const,
      color: '#525252', cursor: 'pointer',
      transition: 'background-color 0.15s',
    },
    overlayContent: { flex: 1, overflow: 'hidden', display: 'flex' },
    errorBanner: {
      padding: '8px 16px', fontSize: 12, color: '#b91c1c',
      backgroundColor: '#fef2f2', borderTop: '1px solid #fecaca',
    },
  };
}

function buildChatCss(t: ShellTheme): string {
  return `
    @keyframes ggui-msg-enter {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .ggui-chat-input:focus {
      border-color: ${t.hex} !important;
      box-shadow: 0 0 0 3px ${rgba(t.r, t.g, t.b, 0.12)} !important;
    }
    .ggui-chat-input::placeholder { color: #A1A1A1; }
    .ggui-send-btn:hover:not(:disabled) { transform: scale(1.05); box-shadow: 0 4px 16px ${rgba(t.r, t.g, t.b, 0.3)}; }
    .ggui-send-btn:active:not(:disabled) { transform: scale(0.95); }
    .ggui-back-btn:hover { background-color: #E5E5E5 !important; }
  `;
}

/* ── ChatShell ── */

export function ChatShell({ primaryColor, endpointUrl, sessionResourceOrigin }: ChatShellProps) {
  const gguiCtx = useGguiContext();
  const appThemeId = gguiCtx.appConfig?.themeId;
  const resolvedEndpoint = endpointUrl ?? gguiCtx.appConfig?.endpointUrl;
  const resolvedOrigin = useMemo(
    () => resolveSessionResourceOrigin(sessionResourceOrigin, gguiCtx.apiBaseUrl, resolvedEndpoint),
    [sessionResourceOrigin, gguiCtx.apiBaseUrl, resolvedEndpoint],
  );

  // Invoke-SSE transport. useInvoke reads the endpoint from context when
  // `endpointUrl` option is absent, and threads bearerToken for auth.
  const { messages, send, isStreaming, error } = useInvoke({
    ...(endpointUrl !== undefined ? { endpointUrl } : {}),
    bearerToken: gguiCtx.auth?.token,
    sessionId: gguiCtx.sessionId,
  });

  // Theme — derive shell accent from app's design theme when primaryColor
  // isn't explicit.
  const resolvedPrimary = useMemo(() => {
    if (primaryColor) return primaryColor;
    if (!appThemeId) return undefined;
    const css = getThemeCss(appThemeId);
    return css.match(/--ggui-color-primary-500:\s*(#[0-9a-fA-F]{6})/)?.[1];
  }, [primaryColor, appThemeId]);
  const theme = useShellTheme(resolvedPrimary);
  const s = useMemo(() => buildStyles(theme), [theme]);
  const chatCss = useMemo(() => buildChatCss(theme), [theme]);

  // Derive UI moments + render rows from the invoke-SSE stream.
  const uiMoments = useMemo(
    () => extractUiMoments(messages, resolvedOrigin !== undefined ? { sessionResourceOrigin: resolvedOrigin } : {}),
    [messages, resolvedOrigin],
  );
  const rows = useMemo(() => buildRows(messages, uiMoments), [messages, uiMoments]);

  // Connection status mapping — no WS lifecycle; state derives from
  // transport surface + streaming flag.
  const isReady = resolvedEndpoint !== undefined;
  const statusLabel = error ? 'Error' : isStreaming ? 'Streaming' : isReady ? 'Online' : 'Configuring';

  // Auto-scroll to bottom on new rows / streaming ticks.
  const messagesEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [rows.length, isStreaming]);

  // Chat input
  const onSend = useCallback(
    (text: string) => {
      // Fire-and-forget; useInvoke exposes errors via `error` state which
      // surfaces in the error banner below.
      void send(text);
    },
    [send],
  );
  const { inputText, setInputText, inputRef, handleSend, handleKeyDown, canSend } = useChatInput({
    onSend, isConnected: isReady && !isStreaming,
  });

  // Fullscreen overlay — click a card's Expand to mount it full-screen.
  // Unlike the legacy ShellContext-driven auto-overlay, this is explicit
  // click-only; no auto-surface on stack growth.
  const [overlayMomentKey, setOverlayMomentKey] = useState<string | null>(null);
  const overlayMoment = useMemo(
    () => (overlayMomentKey ? uiMoments.find((m) => m.key === overlayMomentKey) ?? null : null),
    [overlayMomentKey, uiMoments],
  );
  const overlayResource = overlayMoment ? momentToResource(overlayMoment) : null;

  return (
    <div style={s.container}>
      {/* Header */}
      <div style={s.header}>
        <div style={s.headerContent}>
          <div style={s.agentAvatar}>
            <span style={s.avatarText}>🤖</span>
          </div>
          <div>
            <div style={s.agentName}>{gguiCtx.appMetadata?.appName ?? gguiCtx.appConfig?.name ?? 'Agent'}</div>
            <div style={{ ...s.statusDot, color: error ? '#dc2626' : isReady ? '#22c55e' : '#f59e0b' }}>
              <ConnectionDot isConnected={isReady && !error} />
              {statusLabel}
            </div>
          </div>
        </div>
      </div>

      {/* Message list */}
      <div style={s.messageList}>
        {rows.length === 0 && (
          <div style={s.emptyState}>
            {isReady ? 'Send a message to start the conversation' : 'Configuring endpoint...'}
          </div>
        )}

        {rows.map((row) => (
          <div
            key={row.key}
            style={{
              ...s.messageRow,
              justifyContent: row.kind === 'text' && row.sender === 'user' ? 'flex-end' : 'flex-start',
              animation: 'ggui-msg-enter 0.3s ease-out',
            }}
          >
            <div style={{
              display: 'flex', flexDirection: 'column',
              alignItems: row.kind === 'text' && row.sender === 'user' ? 'flex-end' : 'flex-start',
              ...(row.kind === 'ui-moment' ? { width: '100%', maxWidth: 480 } : { maxWidth: '80%' }),
            }}>
              {row.kind === 'text' ? (
                <div style={{ ...s.bubble, ...(row.sender === 'user' ? s.userBubble : s.agentBubble) }}>
                  {row.sender === 'agent' ? renderMarkdown(row.text) : row.text}
                </div>
              ) : (() => {
                const resource = momentToResource(row.moment);
                return (
                  <div style={s.componentCard}>
                    <div style={{
                      ...s.componentCardHeader,
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}>
                      <span>Generated UI</span>
                      {resource && (
                        <button
                          onClick={() => setOverlayMomentKey(row.moment.key)}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            padding: 2, display: 'flex', alignItems: 'center',
                            color: rgba(theme.r, theme.g, theme.b, 0.5),
                          }}
                          title="Expand fullscreen"
                        >
                          <ExpandIcon />
                        </button>
                      )}
                    </div>
                    <div style={s.componentCardBody}>
                      {resource ? (
                        <McpAppIframe resource={resource} />
                      ) : (
                        <div style={s.componentCardEmpty}>
                          Waiting for inline-bootstrap renderer…
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        ))}

        {/* Typing indicator — streaming with no current text accumulated yet. */}
        {isStreaming && rows[rows.length - 1]?.kind !== 'text' && (
          <div style={{ ...s.messageRow, justifyContent: 'flex-start' }}>
            <div style={{ ...s.bubble, ...s.agentBubble }}>
              <TypingIndicator r={theme.r} g={theme.g} b={theme.b} />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Error banner — surface useInvoke errors instead of swallowing. */}
      {error && (
        <div style={s.errorBanner}>
          {error.code}: {error.message}
        </div>
      )}

      {/* Input bar */}
      <div style={s.inputBar}>
        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isReady ? 'Type a message...' : 'Configuring...'}
          disabled={!isReady || isStreaming}
          style={s.input}
          className="ggui-chat-input"
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          className="ggui-send-btn"
          style={{ ...s.sendButton, opacity: canSend ? 1 : 0.4 }}
        >
          <SendIcon />
        </button>
      </div>

      {/* Full-screen overlay */}
      {overlayMoment && overlayResource && (
        <div style={s.overlay}>
          <div style={s.overlayBar}>
            <button
              onClick={() => setOverlayMomentKey(null)}
              style={s.backButton}
              className="ggui-back-btn"
            >
              ← Back to chat
            </button>
          </div>
          <div style={s.overlayContent}>
            <McpAppIframe resource={overlayResource} />
          </div>
        </div>
      )}

      {/* Keyframes */}
      <style>{TYPING_BOUNCE_CSS}{chatCss}</style>
    </div>
  );
}
