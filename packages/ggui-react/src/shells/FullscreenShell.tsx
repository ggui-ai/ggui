/**
 * FullscreenShell — an invoke-SSE-backed spatial card deck.
 *
 * Generated UIs render as full-screen swipeable cards. One UiMoment =
 * one card. A skeleton card surfaces while the agent is streaming and
 * no new moment has landed yet. A floating chat overlay surfaces text
 * bubbles (last 6) on tap.
 *
 * Data flow:
 *   1. `useInvoke()` from context endpoint + bearer.
 *   2. `extractUiMoments()` projects tool_result blocks → iframe URLs.
 *   3. Swipe deck renders one `<McpAppIframe>` per UiMoment.
 *   4. Skeleton card shown while `isStreaming` and no new moment.
 *   5. Chat overlay reads user + assistant text blocks off messages.
 *
 * This shell is built entirely on the invoke-SSE stream. It does not
 * use the older `<BaseShell>` / `<StackItemRenderer>` WebSocket-event
 * machinery: chat-overlay messages and skeleton progress derive purely
 * from `useInvoke`. The skeleton's progress curve is a pure fallback
 * animation — there is no real generation telemetry on the invoke-SSE
 * wire yet. Feedback UI is intentionally left to an in-iframe adapter
 * rather than a shell-level feedback bar.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ResourceContents } from '@modelcontextprotocol/sdk/types.js';
import type { ShellTheme } from './theme';
import { rgba } from './theme';
import { useChatInput, useShellTheme } from './hooks';
import {
  SendIcon, ChatIcon, CloseIcon, TypingIndicator,
  TYPING_BOUNCE_CSS, SPIN_CSS, SHIMMER_CSS,
} from './shared';
import { WelcomePage } from './WelcomePage';
import { useGguiContext } from '../context/GguiContext';
import { useInvoke, type ConversationMessage } from '../invoke/useInvoke';
import { extractUiMoments, type UiMoment } from '../invoke/ui-moments';

// Legacy `<McpAppIframe>` was deleted in the spec-migration slice
// (2026-05-26). See ChatShell.tsx for the same fail-loud stub rationale
// (cleanup tracked in #98).
function McpAppIframe(_props: { resource: unknown }): React.JSX.Element {
  throw new Error(
    '<FullscreenShell> uses the deleted <McpAppIframe>. Migrate to <AppRenderer> + sandbox-proxy URL, or use useMcpAppsChat + <AppRenderer> directly.',
  );
}
import { findLatestAssistantText } from './agent-shell/state-machine';

/* ── Props ── */

export interface FullscreenShellProps {
  /** App's primary accent color (hex). Defaults to ggui signature violet. */
  primaryColor?: string;
  /**
   * Override the invoke endpoint URL. When absent, falls through to
   * `useGguiContext().appConfig.endpointUrl`.
   */
  endpointUrl?: string;
  /**
   * Origin for session-resource URLs. Defaults to `apiBaseUrl` on the
   * context, or the origin component of the resolved `endpointUrl`.
   */
  sessionResourceOrigin?: string;
}

/* ── Constants ── */

const FALLBACK_STAGES: readonly { at: number; text: string }[] = [
  { at: 0, text: 'Understanding your request...' },
  { at: 15, text: 'Generating components...' },
  { at: 40, text: 'Building layout...' },
  { at: 65, text: 'Applying styles...' },
  { at: 85, text: 'Almost ready...' },
];

/* ── Helpers ── */

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

function momentToResource(moment: UiMoment | null | undefined): ResourceContents | null {
  if (!moment) return null;
  if (moment.source.kind === 'session-resource') {
    return { uri: moment.source.url, mimeType: 'text/html' };
  }
  return null;
}

/** Chat-overlay rows — just user + assistant text blocks, flattened. */
interface OverlayRow {
  readonly key: string;
  readonly sender: 'user' | 'agent';
  readonly text: string;
}

function buildOverlayRows(messages: readonly ConversationMessage[]): OverlayRow[] {
  const out: OverlayRow[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.length > 0) {
        out.push({ key: `${msg.id}:user`, sender: 'user', text });
      }
      continue;
    }
    let blockIndex = 0;
    for (const block of msg.content) {
      if (block.type === 'text' && block.text.length > 0) {
        out.push({ key: `${msg.id}:${blockIndex}`, sender: 'agent', text: block.text });
      }
      blockIndex += 1;
    }
  }
  return out;
}

/* ── Themed styles ── */

function buildStyles(t: ShellTheme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex', flexDirection: 'column', height: '100%', width: '100%',
      position: 'relative', backgroundColor: '#111827', overflow: 'hidden',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    },
    welcomeScreen: { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, padding: 24 },
    welcomeContent: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', maxWidth: 480, width: '100%' },
    generatingRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 24 },
    spinner: {
      width: 16, height: 16, borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.15)', borderTopColor: rgba(t.r, t.g, t.b, 0.8),
      animation: 'spin 0.8s linear infinite',
    },
    cardContainer: { position: 'relative', flex: 1, overflow: 'hidden', touchAction: 'pan-y' },
    card: { position: 'absolute', inset: 0, backgroundColor: '#ffffff', overflow: 'auto', display: 'flex', flexDirection: 'column' },
    dotContainer: {
      position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', gap: 8, zIndex: 20,
    },
    dot: {
      width: 8, height: 8, borderRadius: '50%', border: 'none', padding: 0,
      cursor: 'pointer', transition: 'background-color 0.2s ease',
    },
    floatingContainer: {
      position: 'absolute', bottom: 20, right: 20, zIndex: 50,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
    },
    fabButton: {
      width: 48, height: 48, borderRadius: '50%', border: 'none',
      background: `linear-gradient(135deg, ${t.hex} 0%, ${t.darkHex} 100%)`,
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', boxShadow: `0 4px 12px ${rgba(t.r, t.g, t.b, 0.35)}`,
      position: 'relative',
    },
    unreadDot: {
      position: 'absolute', top: 0, right: 0, width: 10, height: 10,
      borderRadius: '50%', backgroundColor: '#ef4444', border: `2px solid ${t.hex}`,
    },
    pillInput: {
      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 6px 6px 14px',
      borderRadius: 28, backgroundColor: 'rgba(255, 255, 255, 0.95)',
      backdropFilter: 'blur(12px)', boxShadow: '0 4px 20px rgba(0,0,0,0.25)', width: 340,
    },
    pillInputField: { flex: 1, border: 'none', outline: 'none', fontSize: 14, backgroundColor: 'transparent', padding: '6px 0' },
    pillSendButton: {
      width: 36, height: 36, borderRadius: '50%', border: 'none',
      background: `linear-gradient(135deg, ${t.hex} 0%, ${t.darkHex} 100%)`,
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', flexShrink: 0,
    },
    pillCloseButton: {
      width: 28, height: 28, borderRadius: '50%', border: 'none',
      backgroundColor: 'transparent', color: '#9ca3af',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', flexShrink: 0,
    },
    chatOverlay: {
      position: 'absolute', bottom: 80, right: 20, width: 360, maxHeight: '50%',
      zIndex: 40, display: 'flex', flexDirection: 'column', gap: 6,
      overflowY: 'auto', padding: 8,
    },
    chatOverlayRow: { display: 'flex', width: '100%' },
    chatBubble: {
      maxWidth: '80%', padding: '8px 12px', borderRadius: 16, fontSize: 13,
      lineHeight: '1.4', wordBreak: 'break-word', whiteSpace: 'pre-wrap',
      backdropFilter: 'blur(12px)', boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
    },
    chatUserBubble: {
      background: `linear-gradient(135deg, ${t.hex} 0%, ${t.darkHex} 100%)`,
      color: '#fff', borderBottomRightRadius: 4,
    },
    chatAgentBubble: { backgroundColor: 'rgba(255, 255, 255, 0.85)', color: '#111827', borderBottomLeftRadius: 4 },
    // Skeleton
    skeletonContainer: {
      display: 'flex', flexDirection: 'column' as const,
      padding: '48px 32px', height: '100%', boxSizing: 'border-box' as const,
    },
    shimmerBlock: {
      backgroundColor: 'rgba(255, 255, 255, 0.06)', borderRadius: 8,
      animation: 'ggui-shimmer 1.5s ease-in-out infinite',
      backgroundImage: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.04) 50%, transparent 100%)',
      backgroundSize: '200% 100%',
    },
    progressTrack: {
      width: '100%', height: 3, backgroundColor: 'rgba(255, 255, 255, 0.08)',
      borderRadius: 2, overflow: 'hidden', marginBottom: 16,
    },
    progressFill: { height: '100%', backgroundColor: t.hex, borderRadius: 2, transition: 'width 0.3s ease-out' },
    skeletonStatusRow: { display: 'flex', alignItems: 'center', gap: 8 },
    skeletonSpinner: {
      width: 14, height: 14, borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.1)', borderTopColor: t.hex,
      animation: 'spin 0.8s linear infinite', flexShrink: 0,
    },
    skeletonStatusText: { fontSize: 13, color: 'rgba(255, 255, 255, 0.5)', flex: 1 },
    skeletonPercent: { fontSize: 12, color: 'rgba(255, 255, 255, 0.3)', fontVariantNumeric: 'tabular-nums' },
    errorBanner: {
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: 60,
      padding: '8px 16px', fontSize: 12, color: '#fecaca',
      backgroundColor: 'rgba(127, 29, 29, 0.85)', backdropFilter: 'blur(8px)',
    },
  };
}

/* ── FullscreenShell ── */

export function FullscreenShell({
  primaryColor,
  endpointUrl,
  sessionResourceOrigin,
}: FullscreenShellProps) {
  const gguiCtx = useGguiContext();
  const resolvedEndpoint = endpointUrl ?? gguiCtx.appConfig?.endpointUrl;
  const resolvedOrigin = useMemo(
    () => resolveSessionResourceOrigin(sessionResourceOrigin, gguiCtx.apiBaseUrl, resolvedEndpoint),
    [sessionResourceOrigin, gguiCtx.apiBaseUrl, resolvedEndpoint],
  );

  const { messages, send, isStreaming, error } = useInvoke({
    ...(endpointUrl !== undefined ? { endpointUrl } : {}),
    bearerToken: gguiCtx.auth?.token,
    sessionId: gguiCtx.sessionId,
  });

  const uiMoments = useMemo(
    () => extractUiMoments(messages, resolvedOrigin !== undefined ? { sessionResourceOrigin: resolvedOrigin } : {}),
    [messages, resolvedOrigin],
  );
  const cards = useMemo(
    () => uiMoments.map((m) => ({ moment: m, resource: momentToResource(m) })).filter((c) => c.resource !== null),
    [uiMoments],
  );
  const hasAnyCard = cards.length > 0;

  const theme = useShellTheme(primaryColor);
  const s = useMemo(() => buildStyles(theme), [theme]);

  // Chat overlay rows — user + assistant text blocks, flattened.
  const overlayRows = useMemo(() => buildOverlayRows(messages), [messages]);
  const thinkingMessage = useMemo(() => findLatestAssistantText(messages), [messages]);

  const isReady = resolvedEndpoint !== undefined;

  // Swipe + skeleton UI state
  const [activeIndex, setActiveIndex] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [skeletonProgress, setSkeletonProgress] = useState(0);
  const [skeletonStatus, setSkeletonStatus] = useState<string>(FALLBACK_STAGES[0]!.text);
  const dragStartX = useRef(0);
  const dragCurrentX = useRef(0);
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Grace period: when ready + no cards, wait 5s before showing the
  // WelcomePage — the agent may be about to emit a moment.
  const [graceExpired, setGraceExpired] = useState(false);
  useEffect(() => {
    if (isReady && !hasAnyCard) {
      const t = setTimeout(() => setGraceExpired(true), 5000);
      return () => clearTimeout(t);
    }
    setGraceExpired(false);
  }, [isReady, hasAnyCard]);

  // Skeleton: show while streaming + no new moment has landed for the
  // current turn. Simple rule — isStreaming AND the last user message
  // is after the last uiMoment (or no uiMoment yet). Approximated by
  // checking message index of the last user vs the assistant message
  // that contains the last uiMoment.
  const showSkeleton = useMemo(() => {
    if (!isStreaming) return false;
    if (!hasAnyCard) return true;
    // Latest moment key encodes `<messageId>:<blockIndex>` (tool_use_id).
    // If another user turn has landed after it, we're streaming a new
    // response with no moment yet → skeleton.
    const lastMoment = uiMoments[uiMoments.length - 1];
    if (!lastMoment) return true;
    // Find the index of the assistant message containing the moment
    // and check whether a later user message exists.
    const lastMomentMsgIdx = messages.findIndex((m) =>
      m.role === 'assistant' && m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === lastMoment.key),
    );
    if (lastMomentMsgIdx === -1) return true;
    for (let i = lastMomentMsgIdx + 1; i < messages.length; i += 1) {
      if (messages[i]?.role === 'user') return true;
    }
    return false;
  }, [isStreaming, hasAnyCard, uiMoments, messages]);

  const totalSlides = cards.length + (showSkeleton ? 1 : 0);

  // Auto-advance to latest card on new moment
  const prevCardCount = useRef(cards.length);
  useEffect(() => {
    if (cards.length > prevCardCount.current && cards.length > 0) {
      setActiveIndex(cards.length - 1);
    }
    prevCardCount.current = cards.length;
  }, [cards.length]);

  // If skeleton just appeared, make it active
  useEffect(() => {
    if (showSkeleton) setActiveIndex(cards.length);
  }, [showSkeleton, cards.length]);

  // Clamp activeIndex
  useEffect(() => {
    if (totalSlides > 0 && activeIndex >= totalSlides) setActiveIndex(totalSlides - 1);
  }, [totalSlides, activeIndex]);

  // Skeleton fallback progress (no real telemetry on the invoke wire).
  useEffect(() => {
    if (!showSkeleton) {
      setSkeletonProgress(0);
      setSkeletonStatus(FALLBACK_STAGES[0]!.text);
      return;
    }
    setSkeletonStatus(FALLBACK_STAGES[0]!.text);
    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed += 200;
      const t = Math.min(elapsed / 15000, 1);
      const progress = 92 * (1 - Math.pow(1 - t, 2.5));
      setSkeletonProgress(progress);
      for (let i = FALLBACK_STAGES.length - 1; i >= 0; i -= 1) {
        if (progress >= FALLBACK_STAGES[i]!.at) {
          setSkeletonStatus(FALLBACK_STAGES[i]!.text);
          break;
        }
      }
    }, 200);
    return () => clearInterval(interval);
  }, [showSkeleton]);

  // Auto-scroll chat overlay
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [overlayRows.length, isStreaming]);

  // Swipe gestures
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (chatOpen || totalSlides <= 1) return;
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragCurrentX.current = e.clientX;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [chatOpen, totalSlides]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    dragCurrentX.current = e.clientX;
    setDragOffset(dragCurrentX.current - dragStartX.current);
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    const delta = dragCurrentX.current - dragStartX.current;
    const threshold = 80;
    if (delta < -threshold && activeIndex < totalSlides - 1) setActiveIndex((prev) => prev + 1);
    else if (delta > threshold && activeIndex > 0) setActiveIndex((prev) => prev - 1);
    setDragOffset(0);
  }, [activeIndex, totalSlides]);

  // Chat input
  const onSend = useCallback((text: string) => {
    void send(text);
  }, [send]);

  const { inputText, setInputText, inputRef, handleSend, handleKeyDown, canSend } = useChatInput({
    onSend, isConnected: isReady && !isStreaming, onEscape: () => setChatOpen(false),
  });

  // Focus input when chat opens
  useEffect(() => {
    if (chatOpen) setTimeout(() => inputRef.current?.focus(), 100);
  }, [chatOpen, inputRef]);

  // Card positioning
  const getCardTransform = (index: number): string => {
    const base = index - activeIndex;
    if (base === 0) return `translateX(${dragOffset}px)`;
    return `translateX(${base * 100}%)`;
  };
  const getCardTransition = (): string => {
    if (isDragging.current && dragOffset !== 0) return 'none';
    return 'transform 0.3s ease-out';
  };

  const isTyping = isStreaming && overlayRows[overlayRows.length - 1]?.sender !== 'agent';

  return (
    <div style={s.container}>
      {/* Error banner — overlay at top when useInvoke fails. */}
      {error && (
        <div style={s.errorBanner}>
          {error.code}: {error.message}
        </div>
      )}

      {/* Card stack */}
      {!hasAnyCard ? (
        isReady && !graceExpired ? (
          <div style={s.welcomeScreen}>
            <div style={s.welcomeContent}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%',
                backgroundColor: '#22c55e', marginBottom: 24,
                boxShadow: '0 0 8px rgba(34,197,94,0.4)',
              }} />
              <div style={s.generatingRow}>
                <div style={s.spinner} />
                <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }}>
                  {thinkingMessage ?? 'Preparing your interface...'}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <WelcomePage
            connectionStatus={isReady ? 'connected' : 'disconnected'}
          />
        )
      ) : (
        <div
          ref={containerRef}
          style={s.cardContainer}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {cards.map((card, index) => (
            <div
              key={card.moment.key}
              className="ggui-fs-card"
              style={{
                ...s.card,
                transform: getCardTransform(index),
                transition: getCardTransition(),
                visibility: Math.abs(index - activeIndex) <= 1 ? 'visible' : 'hidden',
              }}
            >
              <div style={{ flex: 1, display: 'flex' }}>
                <McpAppIframe resource={card.resource!} />
              </div>
            </div>
          ))}

          {/* Skeleton transition card */}
          {showSkeleton && (
            <div
              key="skeleton"
              style={{
                ...s.card,
                transform: getCardTransform(cards.length),
                transition: getCardTransition(),
                backgroundColor: '#111827',
              }}
            >
              <div className="ggui-fs-skeleton" style={s.skeletonContainer}>
                {thinkingMessage && (
                  <div style={{
                    fontSize: 14, color: 'rgba(255, 255, 255, 0.6)',
                    marginBottom: 16, lineHeight: 1.5, maxHeight: 48, overflow: 'hidden',
                  }}>
                    {thinkingMessage.length > 120 ? thinkingMessage.slice(0, 120) + '...' : thinkingMessage}
                  </div>
                )}

                <div style={s.progressTrack}>
                  <div style={{ ...s.progressFill, width: `${skeletonProgress}%` }} />
                </div>

                <div style={s.skeletonStatusRow}>
                  <div style={s.skeletonSpinner} />
                  <span style={s.skeletonStatusText}>{skeletonStatus}</span>
                  <span style={s.skeletonPercent}>{Math.round(skeletonProgress)}%</span>
                </div>

                {/* Shimmer blocks */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', marginTop: 32 }}>
                  <div className="ggui-shimmer" style={{ ...s.shimmerBlock, width: '60%', height: 28, marginBottom: 8 }} />
                  <div className="ggui-shimmer" style={{ ...s.shimmerBlock, width: '40%', height: 16, marginBottom: 32 }} />
                  <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
                    <div className="ggui-shimmer" style={{ ...s.shimmerBlock, flex: 1, height: 80, borderRadius: 12 }} />
                    <div className="ggui-shimmer" style={{ ...s.shimmerBlock, flex: 1, height: 80, borderRadius: 12 }} />
                    <div className="ggui-shimmer" style={{ ...s.shimmerBlock, flex: 1, height: 80, borderRadius: 12 }} />
                  </div>
                  <div className="ggui-shimmer" style={{ ...s.shimmerBlock, width: '100%', height: 200, borderRadius: 12, marginBottom: 16 }} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div className="ggui-shimmer" style={{ ...s.shimmerBlock, width: '90%', height: 18 }} />
                    <div className="ggui-shimmer" style={{ ...s.shimmerBlock, width: '75%', height: 18 }} />
                    <div className="ggui-shimmer" style={{ ...s.shimmerBlock, width: '85%', height: 18 }} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dot indicators */}
      {totalSlides > 1 && (
        <div style={s.dotContainer}>
          {cards.map((card, index) => (
            <button
              key={card.moment.key}
              onClick={() => setActiveIndex(index)}
              style={{ ...s.dot, backgroundColor: index === activeIndex ? '#ffffff' : 'rgba(255, 255, 255, 0.4)' }}
            />
          ))}
          {showSkeleton && (
            <button
              key="skeleton-dot"
              onClick={() => setActiveIndex(cards.length)}
              style={{ ...s.dot, backgroundColor: activeIndex === cards.length ? '#ffffff' : 'rgba(255, 255, 255, 0.4)' }}
            />
          )}
        </div>
      )}

      {/* Chat overlay — last 6 bubbles */}
      {chatOpen && overlayRows.length > 0 && (
        <div style={s.chatOverlay} onClick={() => setChatOpen(false)}>
          {overlayRows.slice(-6).map((row) => (
            <div
              key={row.key}
              onClick={(e) => e.stopPropagation()}
              style={{ ...s.chatOverlayRow, justifyContent: row.sender === 'user' ? 'flex-end' : 'flex-start' }}
            >
              <div style={{
                ...s.chatBubble,
                ...(row.sender === 'user' ? s.chatUserBubble : s.chatAgentBubble),
              }}>
                {row.text}
              </div>
            </div>
          ))}
          {isTyping && (
            <div style={{ ...s.chatOverlayRow, justifyContent: 'flex-start' }}>
              <div style={{ ...s.chatBubble, ...s.chatAgentBubble }}>
                <TypingIndicator r={theme.r} g={theme.g} b={theme.b} compact />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Floating FAB / pill input */}
      {isReady && (
        <div style={s.floatingContainer}>
          {chatOpen ? (
            <div style={s.pillInput}>
              <input
                ref={inputRef}
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isReady ? 'Type a message...' : 'Connecting...'}
                disabled={!isReady || isStreaming}
                style={s.pillInputField}
              />
              <button
                onClick={handleSend}
                disabled={!canSend}
                style={{ ...s.pillSendButton, opacity: canSend ? 1 : 0.4 }}
              >
                <SendIcon size={18} />
              </button>
              <button onClick={() => setChatOpen(false)} style={s.pillCloseButton}>
                <CloseIcon />
              </button>
            </div>
          ) : (
            <button onClick={() => setChatOpen(true)} style={s.fabButton}>
              {overlayRows.length > 0 && <span style={s.unreadDot} />}
              <ChatIcon />
            </button>
          )}
        </div>
      )}

      {/* Keyframes */}
      <style>{`
        .ggui-fs-card > div { height: 100% !important; }
        ${TYPING_BOUNCE_CSS}
        ${SHIMMER_CSS}
        ${SPIN_CSS}
      `}</style>
    </div>
  );
}
