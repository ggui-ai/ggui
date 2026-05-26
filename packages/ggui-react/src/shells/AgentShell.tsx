/**
 * AgentShell — an invoke-SSE-backed character shell.
 *
 * The agent IS the interface. Character (Gumi, the default underwater
 * crab) with animated head, thinking bubble, and a frame that mounts
 * the generated UI via `<McpAppIframe>`. Character state transitions
 * drive optional sound cues.
 *
 * Data flow mirrors ChatShell:
 *   1. `useInvoke()` reads the agent's `/invoke` SSE endpoint from
 *      `useGguiContext().appConfig.endpointUrl`.
 *   2. `extractUiMoments(messages, {sessionResourceOrigin})` projects
 *      tool_result blocks into `<McpAppIframe>` mount coordinates.
 *   3. `deriveAgentState({messages, isStreaming, uiMoments})` computes
 *      `idle`/`thinking`/`presenting` + the latest assistant text
 *      block content for the thinking bubble.
 *
 * Layout (Gumi character overlaps the top of the frame; history panel
 * toggles inside the frame):
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ brand-top                      [input] [→]  │
 *   │          🦀  💬                              │
 *   │ ┌─────────────────────────────────────────┐ │
 *   │ │                                         │ │
 *   │ │         <McpAppIframe /> here            │ │
 *   │ │                              [history]  │ │
 *   │ └─────────────────────────────────────────┘ │
 *   │                           powered by GGUI   │
 *   └─────────────────────────────────────────────┘
 *
 * Usage (standalone inside GguiProvider):
 *   <GguiApp shell="agent" />
 *   <GguiApp shell={(props) => <AgentShell {...props} components={{...}} />} />
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResourceContents } from '@modelcontextprotocol/sdk/types.js';
import { Clock, X } from 'lucide-react';
import { useGguiContext } from '../context/GguiContext';
import { useInvoke } from '../invoke/useInvoke';
import { extractUiMoments, type UiMoment } from '../invoke/ui-moments';

// Legacy `<McpAppIframe>` was deleted in the spec-migration slice
// (2026-05-26). See ChatShell.tsx for the same fail-loud stub rationale
// (cleanup tracked in #98).
function McpAppIframe(_props: { resource: unknown }): React.JSX.Element {
  throw new Error(
    '<AgentShell> uses the deleted <McpAppIframe>. Migrate to <AppRenderer> + sandbox-proxy URL, or use useMcpAppsChat + <AppRenderer> directly.',
  );
}
import type {
  AgentShellProps,
  AgentShellComponents,
  ShellReadinessStatus,
} from './agent-shell/types';
import { useAgentState } from './agent-shell/state-machine';
import { useSoundEngine } from './agent-shell/sound-engine';
import { useAgentHistory } from './agent-shell/use-history';
import type { HistoryEntry } from './agent-shell/use-history';
import {
  GumiHead,
  GumiFrame,
  GumiBackground,
  GumiBubble,
  GumiInput,
} from './agent-shell/gumi';

const DEFAULT_COMPONENTS: AgentShellComponents = {
  head: (props) => <GumiHead {...props} />,
  frame: (props) => <GumiFrame {...props} />,
  background: (props) => <GumiBackground {...props} />,
  thinkingBubble: (props) => <GumiBubble {...props} />,
  inputField: (props) => <GumiInput {...props} />,
};

// ── History Panel ──────────────────────────────────────────────────────

function HistoryPanel({ entries }: { entries: readonly HistoryEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: 'rgba(255, 255, 255, 0.25)', fontSize: 13,
      }}>
        No messages yet
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1, overflow: 'auto', padding: '16px 20px',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      {entries.map((entry) => (
        <div
          key={entry.id}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: entry.sender === 'user' ? 'flex-end' : 'flex-start',
          }}
        >
          <div style={{
            maxWidth: '80%',
            padding: '8px 14px',
            borderRadius: entry.sender === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
            background: entry.sender === 'user'
              ? 'rgba(79, 195, 247, 0.15)'
              : entry.type === 'thinking'
                ? 'rgba(255, 255, 255, 0.04)'
                : 'rgba(255, 255, 255, 0.08)',
            border: entry.sender === 'user'
              ? '1px solid rgba(79, 195, 247, 0.2)'
              : '1px solid rgba(255, 255, 255, 0.06)',
            fontSize: 13,
            lineHeight: 1.5,
            color: entry.type === 'thinking'
              ? 'rgba(255, 255, 255, 0.4)'
              : 'rgba(255, 255, 255, 0.8)',
            fontStyle: entry.type === 'thinking' ? 'italic' : 'normal',
          }}>
            {entry.text}
          </div>
          <div style={{
            fontSize: 10, color: 'rgba(255, 255, 255, 0.2)',
            marginTop: 2,
            padding: '0 4px',
          }}>
            {formatTime(entry.timestamp)}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── History Toggle Button ──────────────────────────────────────────────

function HistoryToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={open ? 'Close history' : 'Show history'}
      style={{
        position: 'absolute',
        bottom: 12,
        right: 12,
        width: 36,
        height: 36,
        borderRadius: 12,
        background: open ? 'rgba(233, 69, 96, 0.15)' : 'rgba(255, 255, 255, 0.06)',
        border: open
          ? '1px solid rgba(233, 69, 96, 0.3)'
          : '1px solid rgba(255, 255, 255, 0.1)',
        color: open ? 'rgba(233, 69, 96, 0.8)' : 'rgba(255, 255, 255, 0.4)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 5,
        transition: 'all 0.2s ease',
      }}
    >
      {open ? <X size={16} /> : <Clock size={16} />}
    </button>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

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

function momentToResource(moment: UiMoment | null): ResourceContents | null {
  if (!moment) return null;
  if (moment.source.kind === 'session-resource') {
    return { uri: moment.source.url, mimeType: 'text/html' };
  }
  // Inline-bootstrap moments — rendering them needs a client-side
  // thin-shell HTML builder that this shell does not implement.
  return null;
}

// ── AgentShell ────────────────────────────────────────────────────────

export function AgentShell({
  components: customComponents,
  sounds,
  assets,
  primaryColor: _primaryColor,
  onStateChange,
  endpointUrl,
  sessionResourceOrigin,
}: AgentShellProps) {
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

  const { agentState, currentMessage } = useAgentState({
    messages,
    isStreaming,
    uiMoments,
  });
  const { entries } = useAgentHistory({ messages });
  useSoundEngine({ agentState, sounds });

  const components = useMemo(
    () => ({ ...DEFAULT_COMPONENTS, ...customComponents }),
    [customComponents],
  );

  React.useEffect(() => {
    onStateChange?.(agentState);
  }, [agentState, onStateChange]);

  const [historyOpen, setHistoryOpen] = useState(false);

  // Top-of-stack UI moment — the generated UI the character is
  // currently presenting. Latest moment wins; AgentShell shows one at
  // a time (unlike ChatShell's inline timeline).
  const topMoment = uiMoments.length > 0 ? uiMoments[uiMoments.length - 1] : null;
  const topResource = momentToResource(topMoment);

  const isReady = resolvedEndpoint !== undefined;
  const readinessStatus: ShellReadinessStatus = error
    ? 'disconnected'
    : isStreaming
      ? 'connecting'
      : isReady
        ? 'connected'
        : 'disconnected';

  const handleInvoke = useCallback(
    (text: string) => {
      void send(text);
    },
    [send],
  );

  const showBubble = agentState === 'thinking' || (agentState === 'presenting' && !!currentMessage);

  const appName = gguiCtx.appMetadata?.appName ?? gguiCtx.appConfig?.name;

  return (
    <div style={{
      position: 'relative', width: '100vw', height: '100vh',
      overflow: 'hidden',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      {/* Background — full bleed */}
      {components.background({ state: agentState, backgroundUrl: assets?.background })}

      {/* Brand — top-left, fixed */}
      {appName && (
        <div style={{
          position: 'fixed', top: 16, left: 20,
          fontFamily: '"Jaro", sans-serif',
          fontSize: 28, fontWeight: 400,
          color: 'rgba(10, 20, 50, 0.8)',
          letterSpacing: 0, textTransform: 'uppercase',
          zIndex: 10,
        }}>
          {appName}
        </div>
      )}

      {/* Brand — bottom-right, fixed */}
      <div style={{
        position: 'fixed', bottom: 12, right: 20,
        display: 'flex', alignItems: 'baseline', gap: 6,
        zIndex: 10,
      }}>
        <span style={{
          fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
          fontSize: 16, color: 'rgba(255, 255, 255, 0.8)',
          letterSpacing: 0.5,
        }}>
          powered by
        </span>
        <span style={{
          fontFamily: '"Jaro", sans-serif',
          fontSize: 26, fontWeight: 400,
          color: 'rgba(255, 255, 255, 0.95)',
        }}>
          GGUI
        </span>
      </div>

      {/* Container — centered, max-width */}
      <div style={{
        position: 'relative', zIndex: 1,
        maxWidth: 1200, width: 'calc(100% - 64px)',
        margin: '0 auto', height: '100vh',
        display: 'flex', flexDirection: 'column',
        padding: '16px 0 40px',
        boxSizing: 'border-box' as const,
        overflow: 'hidden',
      }}>
        {/* Top bar — character + bubble + input */}
        <div style={{
          display: 'flex', alignItems: 'flex-end',
          justifyContent: 'space-between',
          minHeight: 80, position: 'relative',
        }}>
          <div>{/* left spacer */}</div>

          {/* Right: input + send */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            paddingBottom: 8,
          }}>
            {components.inputField({
              state: agentState,
              onSubmit: handleInvoke,
              disabled: !isReady || isStreaming,
            })}
          </div>

          {/* Character — overlaps into frame below */}
          {components.head({
            state: agentState,
            connectionStatus: readinessStatus,
            characterUrl: assets?.character,
          })}

          {/* Thinking bubble — near character */}
          {components.thinkingBubble({
            state: agentState, message: currentMessage, visible: showBubble,
          })}
        </div>

        {/* Frame / Screen */}
        {components.frame({
          state: agentState,
          children: (
            <div style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column' }}>
              {historyOpen ? (
                <HistoryPanel entries={entries} />
              ) : topResource ? (
                <div style={{ flex: 1, display: 'flex' }}>
                  <McpAppIframe resource={topResource} />
                </div>
              ) : agentState === 'thinking' ? (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  height: '100%', color: 'rgba(255, 255, 255, 0.3)', fontSize: 14,
                }}>
                  <div style={{
                    width: 24, height: 24,
                    border: '2px solid rgba(79, 195, 247, 0.3)',
                    borderTopColor: '#4fc3f7', borderRadius: '50%',
                    animation: 'ggui-spin 0.8s linear infinite',
                  }} />
                  <style>{`@keyframes ggui-spin { to { transform: rotate(360deg); } }`}</style>
                </div>
              ) : (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  height: '100%', color: 'rgba(255, 255, 255, 0.35)', fontSize: 14,
                }}>
                  Ask me anything to get started
                </div>
              )}

              {/* History toggle — bottom-right of frame */}
              <HistoryToggle
                open={historyOpen}
                onClick={() => setHistoryOpen((prev) => !prev)}
              />
            </div>
          ),
        })}
      </div>

      {/* Responsive overrides */}
      <style>{`
        @media (max-width: 640px) {
          [data-ggui-frame] { border-radius: 12px !important; margin-top: 8px !important; }
          [data-ggui-head] { display: none !important; }
          [data-ggui-bubble] { left: 0 !important; }
        }
      `}</style>
    </div>
  );
}
