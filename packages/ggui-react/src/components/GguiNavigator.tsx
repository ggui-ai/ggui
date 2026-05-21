/**
 * GguiNavigator — iOS-style bottom nav bar for ggui stack navigation.
 *
 * Provides a frosted-glass bottom navigation bar with floating pill buttons
 * for Stack overview, New Session, and Agent Browse. Designed to feel like
 * a native iOS experience for agent interfaces.
 *
 * Uses inline styles with CSS variable fallbacks.
 */

import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { StackItem } from '@ggui-ai/protocol';
import type { AgentListingItem } from '@ggui-ai/shared';
import { StackItemRenderer, type StackItemRendererProps } from './DynamicComponent';
import { useStackNavigation } from '../hooks/useStackNavigation';
import type { UseStackNavigationOptions } from '../hooks/useStackNavigation';
import { AgentBrowsePanel } from './AgentBrowsePanel';

export interface GguiNavigatorProps {
  /** Stack items from GguiSession */
  stack: StackItem[];
  /** Navigation options (e.g., autoFollow) */
  navigationOptions?: UseStackNavigationOptions;
  /** Custom renderer for a stack item (overrides default StackItemRenderer) */
  renderItem?: (item: StackItem, index: number) => ReactNode;
  /** Content shown when the stack is empty */
  emptyState?: ReactNode;
  /** Error handler for render errors */
  onError?: (error: Error) => void;
  /** Callback when the user navigates to a different item */
  onNavigate?: (index: number, item: StackItem) => void;
  /** Whether to show the bottom nav bar (default: true) */
  showNavBar?: boolean;
  /** Additional CSS class for the container */
  className?: string;
  /** App name displayed in the top bar */
  appName?: string;
  /** Callback when user submits a new session prompt */
  onNewSession?: (prompt: string) => void;
  /** Callback when user taps the browse button (if no built-in panel) */
  onBrowseAgents?: () => void;
  /** Agent listings data for the browse panel */
  agentListings?: AgentListingItem[];
  /** Whether to show the built-in agent browse panel (default: true if agentListings provided) */
  showBrowsePanel?: boolean;
}

// ---------------------------------------------------------------------------
// Inline SVG icons (no dependency needed)
// ---------------------------------------------------------------------------

function LayersIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 2 7l10 5 10-5-10-5Z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const FONT_FAMILY = "var(--ggui-font-family-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)";
const NAV_BAR_HEIGHT = 72;

const containerStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  fontFamily: FONT_FAMILY,
};

const topBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 44,
  padding: '0 16px',
  borderBottom: '1px solid var(--ggui-color-neutral-100, #f3f4f6)',
  background: 'var(--ggui-color-neutral-50, #ffffff)',
  flexShrink: 0,
  zIndex: 10,
};

const topBarTextStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--ggui-color-neutral-900, #111827)',
  letterSpacing: '-0.01em',
};

const contentAreaStyle: CSSProperties = {
  flex: 1,
  overflow: 'auto',
  minHeight: 0,
};

// Frosted glass bottom bar
const navBarStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  height: NAV_BAR_HEIGHT,
  padding: '0 16px',
  background: 'rgba(255, 255, 255, 0.72)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  borderTop: '1px solid rgba(0, 0, 0, 0.06)',
  flexShrink: 0,
  zIndex: 10,
};

// Floating pill button
const pillButtonStyle: CSSProperties = {
  display: 'inline-flex',
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '10px 18px',
  border: 'none',
  borderRadius: 20,
  background: 'var(--ggui-color-neutral-100, #f3f4f6)',
  cursor: 'pointer',
  color: 'var(--ggui-color-neutral-700, #374151)',
  fontSize: 13,
  fontWeight: 500,
  fontFamily: FONT_FAMILY,
  transition: 'background 0.15s, transform 0.1s',
  position: 'relative',
  whiteSpace: 'nowrap',
};

const pillButtonActiveStyle: CSSProperties = {
  ...pillButtonStyle,
  background: 'var(--ggui-color-primary-600, #0284c7)',
  color: '#ffffff',
};

const pillButtonCenterStyle: CSSProperties = {
  ...pillButtonStyle,
  padding: '10px 22px',
  background: 'var(--ggui-color-primary-600, #0284c7)',
  color: '#ffffff',
};

const badgeStyle: CSSProperties = {
  position: 'absolute',
  top: -4,
  right: -4,
  minWidth: 18,
  height: 18,
  borderRadius: 9,
  background: 'var(--ggui-color-primary-600, #0284c7)',
  color: '#ffffff',
  fontSize: 10,
  fontWeight: 600,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 5px',
  border: '2px solid rgba(255, 255, 255, 0.9)',
};

// Chat input bar (expanded from New Session)
const chatInputBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '12px 16px',
  background: 'rgba(255, 255, 255, 0.88)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  borderTop: '1px solid rgba(0, 0, 0, 0.06)',
  flexShrink: 0,
  zIndex: 10,
};

const chatInputWrapperStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'var(--ggui-color-neutral-50, #f9fafb)',
  border: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
  borderRadius: 24,
  padding: '8px 12px',
  transition: 'border-color 0.15s, box-shadow 0.15s',
};

const chatInputStyle: CSSProperties = {
  flex: 1,
  border: 'none',
  background: 'none',
  outline: 'none',
  fontSize: 14,
  color: 'var(--ggui-color-neutral-900, #111827)',
  fontFamily: FONT_FAMILY,
  lineHeight: 1.4,
};

const chatIconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  borderRadius: 16,
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  color: 'var(--ggui-color-neutral-400, #9ca3af)',
  padding: 0,
  flexShrink: 0,
  transition: 'color 0.15s, background 0.15s',
};

const chatSendButtonStyle: CSSProperties = {
  ...chatIconButtonStyle,
  background: 'var(--ggui-color-primary-600, #0284c7)',
  color: '#ffffff',
};

const chatSendButtonDisabledStyle: CSSProperties = {
  ...chatSendButtonStyle,
  opacity: 0.4,
  cursor: 'default',
};

// Overlays
const overlayBackdropStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.3)',
  zIndex: 20,
};

const overviewPanelStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: NAV_BAR_HEIGHT,
  maxHeight: '60%',
  background: 'var(--ggui-color-neutral-50, #ffffff)',
  borderTop: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
  borderTopLeftRadius: 12,
  borderTopRightRadius: 12,
  boxShadow: 'var(--ggui-shape-shadow-xl, 0 20px 25px -5px rgba(0,0,0,0.1))',
  overflow: 'auto',
  zIndex: 30,
};

const overviewHeaderStyle: CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid var(--ggui-color-neutral-100, #f3f4f6)',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--ggui-color-neutral-500, #6b7280)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const overviewItemStyle: CSSProperties = {
  padding: '10px 16px',
  borderBottom: '1px solid var(--ggui-color-neutral-100, #f3f4f6)',
  cursor: 'pointer',
  transition: 'background 0.1s',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
};

const overviewItemActiveStyle: CSSProperties = {
  ...overviewItemStyle,
  background: 'var(--ggui-color-primary-50, #f0f9ff)',
};

const overviewIndexStyle: CSSProperties = {
  flexShrink: 0,
  width: 22,
  height: 22,
  borderRadius: 11,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 11,
  fontWeight: 600,
  marginTop: 1,
};

const overviewPromptStyle: CSSProperties = {
  flex: 1,
  fontSize: 13,
  color: 'var(--ggui-color-neutral-700, #374151)',
  lineHeight: 1.4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
};

const emptyStateDefaultStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  color: 'var(--ggui-color-neutral-400, #9ca3af)',
  fontSize: 14,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GguiNavigator({
  stack,
  navigationOptions,
  renderItem,
  emptyState,
  onError,
  onNavigate,
  showNavBar = true,
  className,
  appName,
  onNewSession,
  onBrowseAgents,
  agentListings,
  showBrowsePanel,
}: GguiNavigatorProps) {
  const nav = useStackNavigation(stack, navigationOptions);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [browseOpen, setBrowseOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when chat opens
  useEffect(() => {
    if (chatOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [chatOpen]);

  const handleGoToIndex = useCallback(
    (index: number) => {
      nav.goToIndex(index);
      const item = stack[index];
      if (item && onNavigate) onNavigate(index, item);
    },
    [nav, stack, onNavigate],
  );

  const handleSendChat = useCallback(() => {
    const trimmed = chatInput.trim();
    if (!trimmed || !onNewSession) return;
    onNewSession(trimmed);
    setChatInput('');
    setChatOpen(false);
  }, [chatInput, onNewSession]);

  const handleChatKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && chatInput.trim()) {
        handleSendChat();
      } else if (e.key === 'Escape') {
        setChatOpen(false);
      }
    },
    [chatInput, handleSendChat],
  );

  const handleBrowseClick = useCallback(() => {
    if (onBrowseAgents) {
      onBrowseAgents();
      return;
    }
    setBrowseOpen((prev) => !prev);
  }, [onBrowseAgents]);

  const handleAgentSelect = useCallback(
    (agent: AgentListingItem) => {
      setBrowseOpen(false);
      if (onNewSession) {
        onNewSession(`Use ${agent.name}: ${agent.description || agent.name}`);
      }
    },
    [onNewSession],
  );

  // Close browse panel and chat when overlay is tapped
  const handleOverlayClose = useCallback(() => {
    if (nav.overviewOpen) nav.closeOverview();
    if (browseOpen) setBrowseOpen(false);
  }, [nav, browseOpen]);

  // Determine whether to show the built-in browse panel
  const shouldShowBrowsePanel = showBrowsePanel ?? (agentListings !== undefined);

  // Empty state
  if (stack.length === 0) {
    return (
      <div style={containerStyle} className={className}>
        {appName && (
          <div style={topBarStyle}>
            <span style={topBarTextStyle}>{appName}</span>
          </div>
        )}
        <div style={contentAreaStyle}>
          {emptyState ?? (
            <div style={emptyStateDefaultStyle}>No items in stack</div>
          )}
        </div>
      </div>
    );
  }

  const { currentItem, currentIndex, overviewOpen, stackLength } = nav;
  const anyOverlayOpen = overviewOpen || browseOpen;

  return (
    <div style={containerStyle} className={className}>
      {/* Top bar */}
      {appName && (
        <div style={topBarStyle}>
          <span style={topBarTextStyle}>{appName}</span>
        </div>
      )}

      {/* Content area — renders the current stack item */}
      <div style={contentAreaStyle}>
        {currentItem ? (
          renderItem ? (
            renderItem(currentItem, currentIndex)
          ) : (
            <StackItemRenderer
              stackItem={currentItem as StackItemRendererProps['stackItem']}
              onError={onError}
            />
          )
        ) : null}
      </div>

      {/* Overlay backdrops */}
      {anyOverlayOpen && (
        <div
          style={overlayBackdropStyle}
          onClick={handleOverlayClose}
        />
      )}

      {/* Stack overview panel */}
      {overviewOpen && (
        <div style={overviewPanelStyle}>
          <div style={overviewHeaderStyle}>
            Stack ({stackLength} items)
          </div>
          {stack.map((item, i) => {
            const isActive = i === currentIndex;
            return (
              <div
                key={item.id}
                style={isActive ? overviewItemActiveStyle : overviewItemStyle}
                onClick={() => handleGoToIndex(i)}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'var(--ggui-color-neutral-50, #f9fafb)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = '';
                }}
              >
                <div
                  style={{
                    ...overviewIndexStyle,
                    background: isActive
                      ? 'var(--ggui-color-primary-600, #0284c7)'
                      : 'var(--ggui-color-neutral-200, #e5e7eb)',
                    color: isActive ? '#ffffff' : 'var(--ggui-color-neutral-600, #4b5563)',
                  }}
                >
                  {i + 1}
                </div>
                <div style={overviewPromptStyle}>
                  {item.prompt || `Item ${i + 1}`}
                  {item.error && (
                    <span style={{ color: 'var(--ggui-color-error-500, #ef4444)', marginLeft: 6, fontSize: 11 }}>
                      (error)
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Agent browse panel */}
      {browseOpen && shouldShowBrowsePanel && (
        <AgentBrowsePanel
          listings={agentListings ?? []}
          onSelect={handleAgentSelect}
          onClose={() => setBrowseOpen(false)}
          bottomOffset={chatOpen ? 68 : NAV_BAR_HEIGHT}
        />
      )}

      {/* Chat input bar (expanded from New Session) */}
      {chatOpen ? (
        <div style={chatInputBarStyle}>
          <button
            type="button"
            style={chatIconButtonStyle}
            onClick={() => setChatOpen(false)}
            aria-label="Close chat input"
          >
            <CloseIcon />
          </button>
          <div style={chatInputWrapperStyle}>
            <button
              type="button"
              style={{ ...chatIconButtonStyle, width: 28, height: 28, borderRadius: 14, color: 'var(--ggui-color-primary-600, #0284c7)' }}
              aria-label="Attach"
            >
              <PlusIcon />
            </button>
            <input
              ref={inputRef}
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={handleChatKeyDown}
              placeholder="Describe a UI..."
              style={chatInputStyle}
            />
            <button
              type="button"
              style={{ ...chatIconButtonStyle, width: 28, height: 28, borderRadius: 14 }}
              aria-label="Voice input"
            >
              <MicIcon />
            </button>
          </div>
          <button
            type="button"
            style={chatInput.trim() ? chatSendButtonStyle : chatSendButtonDisabledStyle}
            onClick={handleSendChat}
            disabled={!chatInput.trim()}
            aria-label="Send"
          >
            <SendIcon />
          </button>
        </div>
      ) : (
        /* Frosted glass bottom nav bar */
        showNavBar && stackLength > 0 && (
          <div style={navBarStyle}>
            {/* Stack button */}
            <button
              type="button"
              style={overviewOpen ? pillButtonActiveStyle : pillButtonStyle}
              onClick={nav.toggleOverview}
              onMouseEnter={(e) => { if (!overviewOpen) e.currentTarget.style.background = 'var(--ggui-color-neutral-200, #e5e7eb)'; }}
              onMouseLeave={(e) => { if (!overviewOpen) e.currentTarget.style.background = 'var(--ggui-color-neutral-100, #f3f4f6)'; }}
              aria-label="Toggle stack overview"
            >
              <LayersIcon />
              <span>Stack</span>
              {stackLength > 1 && <span style={badgeStyle}>{stackLength}</span>}
            </button>

            {/* New Session button */}
            {onNewSession && (
              <button
                type="button"
                style={pillButtonCenterStyle}
                onClick={() => setChatOpen(true)}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--ggui-color-primary-700, #0369a1)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--ggui-color-primary-600, #0284c7)'; }}
                aria-label="New session"
              >
                <SparkleIcon />
                <span>New Session</span>
              </button>
            )}

            {/* Apps / Browse button */}
            {(onBrowseAgents || shouldShowBrowsePanel) && (
              <button
                type="button"
                style={browseOpen ? pillButtonActiveStyle : pillButtonStyle}
                onClick={handleBrowseClick}
                onMouseEnter={(e) => { if (!browseOpen) e.currentTarget.style.background = 'var(--ggui-color-neutral-200, #e5e7eb)'; }}
                onMouseLeave={(e) => { if (!browseOpen) e.currentTarget.style.background = 'var(--ggui-color-neutral-100, #f3f4f6)'; }}
                aria-label="Browse agents"
              >
                <GridIcon />
                <span>Apps</span>
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
