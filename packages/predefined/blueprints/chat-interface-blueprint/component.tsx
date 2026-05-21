import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Container, Row, Input, Button } from '@ggui-ai/design/primitives';

/* ========================================================================= */
/* Types                                                                      */
/* ========================================================================= */

interface ChatMessage {
  id: string;
  text: string;
  sender: 'agent' | 'user';
  timestamp: string;
  /** ISO date string for grouping by day */
  date: string;
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  componentUrl?: string;
  componentTitle?: string;
}

interface ChatInterfaceBlueprintProps {
  title?: string;
  initialMessages?: ChatMessage[];
  currentUser?: string;
  onSubmit?: (data: { text: string; sender: string; timestamp: string }) => void;
}

/* ========================================================================= */
/* Inline Markdown Parser                                                     */
/* ========================================================================= */

/**
 * Parse simple inline markdown to React elements.
 * Supports: **bold**, *italic*, `code`, [link](url), ```code blocks```
 * Zero dependencies — safe (no dangerouslySetInnerHTML).
 */
function parseMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const remaining = text;
  let key = 0;

  // Pre-process: handle code blocks (```...```)
  const codeBlockParts = remaining.split(/```([\s\S]*?)```/);
  if (codeBlockParts.length > 1) {
    const blockNodes: React.ReactNode[] = [];
    for (let i = 0; i < codeBlockParts.length; i++) {
      if (i % 2 === 1) {
        // Code block content
        blockNodes.push(
          <pre
            key={`cb-${i}`}
            style={{
              backgroundColor: 'var(--ggui-color-neutral-100, #f3f4f6)',
              color: 'var(--ggui-color-neutral-800, #1f2937)',
              padding: '8px 12px',
              borderRadius: 8,
              fontSize: 13,
              fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
              overflowX: 'auto',
              margin: '4px 0',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {codeBlockParts[i].trim()}
          </pre>
        );
      } else if (codeBlockParts[i]) {
        blockNodes.push(...parseInline(codeBlockParts[i], `bk-${i}`));
      }
    }
    return blockNodes;
  }

  return parseInline(remaining, 'root');

  function parseInline(str: string, prefix: string): React.ReactNode[] {
    const result: React.ReactNode[] = [];
    // Regex handles: `code`, **bold**, *italic*, [text](url)
    const pattern = /`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\(([^)]+)\)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(str)) !== null) {
      // Push text before match
      if (match.index > lastIndex) {
        result.push(str.slice(lastIndex, match.index));
      }

      if (match[1] !== undefined) {
        // Inline code: `code`
        result.push(
          <code
            key={`${prefix}-${key++}`}
            style={{
              backgroundColor: 'var(--ggui-color-neutral-100, #f3f4f6)',
              color: 'var(--ggui-color-neutral-800, #1f2937)',
              padding: '2px 5px',
              borderRadius: 4,
              fontSize: '0.9em',
              fontFamily: '"SF Mono", "Fira Code", monospace',
            }}
          >
            {match[1]}
          </code>
        );
      } else if (match[2] !== undefined) {
        // Bold: **text**
        result.push(
          <strong key={`${prefix}-${key++}`} style={{ fontWeight: 600 }}>
            {match[2]}
          </strong>
        );
      } else if (match[3] !== undefined) {
        // Italic: *text*
        result.push(
          <em key={`${prefix}-${key++}`}>{match[3]}</em>
        );
      } else if (match[4] !== undefined && match[5] !== undefined) {
        // Link: [text](url)
        result.push(
          <a
            key={`${prefix}-${key++}`}
            href={match[5]}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: 'inherit',
              textDecoration: 'underline',
              textUnderlineOffset: 2,
            }}
          >
            {match[4]}
          </a>
        );
      }

      lastIndex = match.index + match[0].length;
    }

    // Push remaining text
    if (lastIndex < str.length) {
      result.push(str.slice(lastIndex));
    }

    return result;
  }
}

/* ========================================================================= */
/* Helpers                                                                     */
/* ========================================================================= */

const formatTime = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const getDateStr = () => new Date().toISOString().split('T')[0];

function dateLabel(dateStr: string): string {
  const today = new Date();
  const d = new Date(dateStr + 'T00:00:00');
  const diffDays = Math.floor(
    (today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7)
    return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

const welcomeMessage: ChatMessage = {
  id: 'welcome',
  text: 'Hi! How can I help you?',
  sender: 'agent',
  timestamp: formatTime(),
  date: getDateStr(),
};

/* ========================================================================= */
/* Component                                                                   */
/* ========================================================================= */

export default function ChatInterfaceBlueprint({
  title = 'Chat',
  initialMessages,
  currentUser = 'user',
  onSubmit,
}: ChatInterfaceBlueprintProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(
    initialMessages ?? [welcomeMessage]
  );
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback((smooth = true) => {
    messagesEndRef.current?.scrollIntoView({
      behavior: smooth ? 'smooth' : 'instant',
    });
  }, []);

  useEffect(() => {
    if (isAtBottom) scrollToBottom();
  }, [messages, isTyping, isAtBottom, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const c = messagesContainerRef.current;
    if (!c) return;
    setIsAtBottom(c.scrollHeight - c.scrollTop - c.clientHeight < 80);
  }, []);

  // Listen for ggui:agent-data events (real-time data from agent via ggui_emit)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || typeof detail !== 'object') return;

      const { type, ...data } = detail;
      switch (type) {
        case 'message':
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              text: data.text || data.message || '',
              sender: data.sender || 'agent',
              timestamp: formatTime(),
              date: getDateStr(),
              status: 'delivered',
            },
          ]);
          setIsTyping(false);
          break;
        case 'typing':
          setIsTyping(data.active ?? true);
          break;
        case 'status':
          if (data.messageId && data.status) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === data.messageId ? { ...msg, status: data.status } : msg
              )
            );
          }
          break;
        case 'component':
          if (data.url) {
            setMessages((prev) => [
              ...prev,
              {
                id: Date.now().toString(),
                text: '',
                sender: 'agent',
                timestamp: formatTime(),
                date: getDateStr(),
                status: 'delivered',
                componentUrl: data.url,
                componentTitle: data.title || 'Generated UI',
              },
            ]);
            setIsTyping(false);
          }
          break;
        case 'clear':
          setMessages([]);
          setIsTyping(false);
          break;
      }
    };

    window.addEventListener('ggui:agent-data', handler);
    return () => window.removeEventListener('ggui:agent-data', handler);
  }, []);

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;

    const message: ChatMessage = {
      id: Date.now().toString(),
      text,
      sender: 'user',
      timestamp: formatTime(),
      date: getDateStr(),
      status: 'sent',
    };

    setMessages((prev) => [...prev, message]);
    setInputValue('');
    setIsAtBottom(true);
    onSubmit?.({ text, sender: currentUser, timestamp: message.timestamp });
  }, [inputValue, currentUser, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // Group messages by date
  const dateGroups = useMemo(() => {
    const groups: { date: string; label: string; messages: ChatMessage[] }[] = [];
    let currentDate = '';
    for (const msg of messages) {
      const d = msg.date || getDateStr();
      if (d !== currentDate) {
        currentDate = d;
        groups.push({ date: d, label: dateLabel(d), messages: [msg] });
      } else {
        groups[groups.length - 1].messages.push(msg);
      }
    }
    return groups;
  }, [messages]);

  return (
    <Container
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        maxWidth: 640,
        margin: '0 auto',
        backgroundColor: 'var(--ggui-color-neutral-50, #f9fafb)',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        position: 'relative',
        color: 'var(--ggui-color-neutral-800, #1f2937)',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '14px 20px',
          background:
            'linear-gradient(135deg, var(--ggui-color-primary-600, #0284c7), var(--ggui-color-primary-700, #0369a1))',
          color: '#ffffff',
          flexShrink: 0,
          boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        }}
      >
        <Row align="center" gap="sm">
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 16,
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            AI
          </div>
          <div style={{ flex: 1 }}>
            <div
              style={{
                color: '#ffffff',
                margin: 0,
                fontSize: 16,
                fontWeight: 600,
                lineHeight: 1.3,
              }}
            >
              {title}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginTop: 2,
              }}
            >
              <div
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  backgroundColor: '#4ade80',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>
                {isTyping ? 'Typing…' : 'Online'}
              </span>
            </div>
          </div>
        </Row>
      </div>

      {/* Messages Area */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 16px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {dateGroups.map((group) => (
          <div key={group.date}>
            {/* Date separator */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                margin: '16px 0 12px',
              }}
            >
              <div
                style={{
                  flex: 1,
                  height: 1,
                  backgroundColor: 'var(--ggui-color-neutral-200, #e5e7eb)',
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--ggui-color-neutral-400, #9ca3af)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  flexShrink: 0,
                }}
              >
                {group.label}
              </span>
              <div
                style={{
                  flex: 1,
                  height: 1,
                  backgroundColor: 'var(--ggui-color-neutral-200, #e5e7eb)',
                }}
              />
            </div>

            {/* Messages in this date group */}
            {group.messages.map((msg, index) => {
              const sent = msg.sender === 'user';
              const prevMsg = index > 0 ? group.messages[index - 1] : null;
              const isGrouped = prevMsg?.sender === msg.sender;

              return (
                <div
                  key={msg.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: sent ? 'flex-end' : 'flex-start',
                    maxWidth: '80%',
                    alignSelf: sent ? 'flex-end' : 'flex-start',
                    marginTop: isGrouped ? 2 : 10,
                    animation: 'ggui-chat-msgIn 0.25s ease-out',
                  }}
                >
                  {/* Component embed (iframe) */}
                  {msg.componentUrl ? (
                    <div
                      style={{
                        borderRadius: 12,
                        overflow: 'hidden',
                        border: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
                        backgroundColor: 'var(--ggui-color-neutral-50, #ffffff)',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                        width: '100%',
                        minWidth: 280,
                      }}
                    >
                      {msg.componentTitle && (
                        <div
                          style={{
                            padding: '8px 12px',
                            backgroundColor: 'var(--ggui-color-neutral-50, #f9fafb)',
                            borderBottom: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
                            fontSize: 12,
                            fontWeight: 600,
                            color: 'var(--ggui-color-neutral-600, #4b5563)',
                          }}
                        >
                          {msg.componentTitle}
                        </div>
                      )}
                      <iframe
                        src={msg.componentUrl}
                        style={{
                          width: '100%',
                          height: 300,
                          border: 'none',
                          display: 'block',
                        }}
                        title={msg.componentTitle || 'Embedded component'}
                        sandbox="allow-scripts allow-same-origin"
                      />
                    </div>
                  ) : (
                    /* Message bubble */
                    <div
                      style={{
                        padding: '10px 14px',
                        borderRadius: sent
                          ? '18px 18px 4px 18px'
                          : '18px 18px 18px 4px',
                        backgroundColor: sent
                          ? 'var(--ggui-color-primary-600, #0284c7)'
                          : 'var(--ggui-color-neutral-50, #ffffff)',
                        color: sent
                          ? '#ffffff'
                          : 'var(--ggui-color-neutral-800, #1f2937)',
                        boxShadow: sent
                          ? '0 1px 3px rgba(2,132,199,0.3)'
                          : '0 1px 2px rgba(0,0,0,0.06)',
                        border: sent
                          ? 'none'
                          : '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
                        lineHeight: 1.55,
                        fontSize: 14,
                        wordBreak: 'break-word',
                      }}
                    >
                      {parseMarkdown(msg.text)}
                    </div>
                  )}

                  {/* Timestamp + delivery status */}
                  {!isGrouped && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        marginTop: 4,
                        paddingLeft: sent ? 0 : 4,
                        paddingRight: sent ? 4 : 0,
                      }}
                    >
                      <span
                        style={{
                          color: 'var(--ggui-color-neutral-400, #9ca3af)',
                          fontSize: 11,
                        }}
                      >
                        {msg.timestamp}
                      </span>
                      {sent && msg.status && msg.status !== 'failed' && (
                        <span
                          style={{
                            fontSize: 11,
                            color: 'var(--ggui-color-primary-500, #0ea5e9)',
                          }}
                        >
                          {msg.status === 'read' ? '✓✓' : '✓'}
                        </span>
                      )}
                      {sent && msg.status === 'failed' && (
                        <span style={{ fontSize: 11, color: '#ef4444' }}>!</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {/* Typing Indicator */}
        {isTyping && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 8,
              marginTop: 10,
              animation: 'ggui-chat-msgIn 0.25s ease-out',
            }}
          >
            <div
              style={{
                padding: '12px 16px',
                borderRadius: '18px 18px 18px 4px',
                backgroundColor: 'var(--ggui-color-neutral-50, #ffffff)',
                border: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
                display: 'flex',
                gap: 5,
                alignItems: 'center',
                boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
              }}
            >
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    backgroundColor: 'var(--ggui-color-neutral-400, #9ca3af)',
                    animation: `ggui-chat-bounce 1.4s ease-in-out ${i * 0.16}s infinite`,
                  }}
                />
              ))}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Scroll to bottom button */}
      {!isAtBottom && (
        <button
          onClick={() => {
            setIsAtBottom(true);
            scrollToBottom();
          }}
          aria-label="Scroll to latest messages"
          style={{
            position: 'absolute',
            bottom: 76,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--ggui-color-neutral-50, #ffffff)',
            border: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
            borderRadius: 20,
            padding: '6px 14px',
            fontSize: 12,
            color: 'var(--ggui-color-neutral-600, #4b5563)',
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            zIndex: 10,
            animation: 'ggui-chat-fadeIn 0.2s ease-out',
          }}
        >
          ↓ New messages
        </button>
      )}

      {/* Input Bar */}
      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
          backgroundColor: 'var(--ggui-color-neutral-50, #ffffff)',
          flexShrink: 0,
        }}
      >
        <Row gap="sm" align="center">
          <div style={{ flex: 1 }} onKeyDown={handleKeyDown}>
            <Input
              placeholder="Type a message…"
              value={inputValue}
              onChange={setInputValue}
              aria-label="Message input"
            />
          </div>
          <Button
            variant="primary"
            onPress={handleSend}
            aria-label="Send message"
          >
            Send
          </Button>
        </Row>
      </div>

      {/* Animations — prefixed to avoid collisions */}
      <style>{`
        @keyframes ggui-chat-bounce {
          0%, 60%, 100% { opacity: 0.4; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-4px); }
        }
        @keyframes ggui-chat-msgIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes ggui-chat-fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </Container>
  );
}
