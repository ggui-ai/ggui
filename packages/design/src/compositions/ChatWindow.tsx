import { useState, useRef, useEffect } from 'react';
import type { ChatWindowProps } from './types';
import { Avatar } from '../primitives/Avatar';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { Icon } from '../primitives/Icon';
import { colors } from '../tokens/colors';
import { radius } from '../tokens/spacing';
import { fontSize } from '../tokens/typography';

/**
 * ChatWindow - A chat interface with messages and input
 */
export function ChatWindow({
  messages,
  currentUserId,
  onSendMessage,
  loading,
  typing,
  placeholder = 'Type a message...',
  header,
  style,
  className,
}: ChatWindowProps) {
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (inputValue.trim()) {
      onSendMessage?.(inputValue);
      setInputValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        border: `1px solid ${colors.gray[200]}`,
        borderRadius: radius.lg,
        backgroundColor: colors.white,
        overflow: 'hidden',
        ...style,
      }}
    >
      {header && (
        <div
          style={{
            padding: '12px 16px',
            borderBottom: `1px solid ${colors.gray[200]}`,
          }}
        >
          {header}
        </div>
      )}

      <div
        style={{
          flex: 1,
          padding: '16px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '24px' }}>
            <Spinner size={24} />
          </div>
        ) : (
          messages.map((message) => {
            const isOwn = message.sender.id === currentUserId;
            const timestamp =
              message.timestamp instanceof Date
                ? message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : message.timestamp;

            return (
              <div
                key={message.id}
                style={{
                  display: 'flex',
                  flexDirection: isOwn ? 'row-reverse' : 'row',
                  alignItems: 'flex-end',
                  gap: '8px',
                }}
              >
                {!isOwn && (
                  <Avatar
                    name={message.sender.name}
                    src={message.sender.avatar}
                    size="xs"
                  />
                )}
                <div
                  style={{
                    maxWidth: '70%',
                    padding: '10px 14px',
                    borderRadius: radius.lg,
                    backgroundColor: isOwn ? colors.primary[600] : colors.gray[100],
                    color: isOwn ? colors.white : colors.gray[900],
                  }}
                >
                  <p style={{ margin: 0, fontSize: fontSize.sm }}>{message.content}</p>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      marginTop: '4px',
                      fontSize: fontSize.xs,
                      opacity: 0.7,
                    }}
                  >
                    <span>{timestamp}</span>
                    {isOwn && message.status && (
                      <span>
                        {message.status === 'sending' && '•'}
                        {message.status === 'sent' && '✓'}
                        {message.status === 'delivered' && '✓✓'}
                        {message.status === 'read' && '✓✓'}
                        {message.status === 'error' && '!'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {typing && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: fontSize.xs, color: colors.gray[500] }}>
              {typing.name} is typing...
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div
        style={{
          padding: '12px 16px',
          borderTop: `1px solid ${colors.gray[200]}`,
          display: 'flex',
          gap: '8px',
        }}
      >
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          style={{
            flex: 1,
            padding: '10px 14px',
            border: `1px solid ${colors.gray[300]}`,
            borderRadius: radius.full,
            fontSize: fontSize.sm,
            outline: 'none',
          }}
        />
        <Button onClick={handleSend} disabled={!inputValue.trim()}>
          <Icon name="chevron-right" size={18} />
        </Button>
      </div>
    </div>
  );
}
