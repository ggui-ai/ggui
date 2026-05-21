import { useState } from 'react';
import { Card, Stack, Row, Text, Button } from '@ggui-ai/design/primitives';

type NotificationType = 'info' | 'success' | 'warning' | 'error';

interface NotificationItem {
  id: string;
  title: string;
  description?: string;
  timestamp: string;
  read?: boolean;
  type?: NotificationType;
  icon?: string;
}

interface NotificationListProps {
  notifications: NotificationItem[];
  title?: string;
  emptyMessage?: string;
  showMarkAllRead?: boolean;
  onNotificationClick?: (notification: NotificationItem) => void;
  onMarkRead?: (id: string) => void;
  onMarkAllRead?: () => void;
  onDismiss?: (id: string) => void;
}

const TYPE_COLORS: Record<NotificationType, string> = {
  info: 'var(--ggui-color-primary-500, #3b82f6)',
  success: 'var(--ggui-color-success-500, #22c55e)',
  warning: 'var(--ggui-color-warning-500, #f59e0b)',
  error: 'var(--ggui-color-error-500, #ef4444)',
};

const TYPE_BG: Record<NotificationType, string> = {
  info: 'var(--ggui-color-primary-50, #eff6ff)',
  success: 'var(--ggui-color-success-50, #f0fdf4)',
  warning: 'var(--ggui-color-warning-50, #fffbeb)',
  error: 'var(--ggui-color-error-50, #fef2f2)',
};

const DEFAULT_ICONS: Record<NotificationType, string> = {
  info: '\u2139\uFE0F',
  success: '\u2705',
  warning: '\u26A0\uFE0F',
  error: '\u274C',
};

export default function NotificationList({
  notifications: initialNotifications,
  title = 'Notifications',
  emptyMessage = 'No notifications yet',
  showMarkAllRead = true,
  onNotificationClick,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
}: NotificationListProps) {
  const [notifications, setNotifications] = useState(initialNotifications);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const handleMarkRead = (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
    onMarkRead?.(id);
  };

  const handleMarkAllRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    onMarkAllRead?.();
  };

  const handleDismiss = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    onDismiss?.(id);
  };

  const handleClick = (notification: NotificationItem) => {
    if (!notification.read) {
      handleMarkRead(notification.id);
    }
    onNotificationClick?.(notification);
  };

  return (
    <Card padding="none" style={{ maxWidth: 480 }}>
      {/* Header */}
      <Row
        justify="between"
        align="center"
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--ggui-color-neutral-200, #e5e5e5)',
        }}
      >
        <Row gap="sm" align="center">
          <Text variant="h3">{title}</Text>
          {unreadCount > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 22,
                height: 22,
                borderRadius: 11,
                backgroundColor: 'var(--ggui-color-primary-500, #3b82f6)',
                color: '#ffffff',
                fontSize: 12,
                fontWeight: 600,
                padding: '0 6px',
              }}
            >
              {unreadCount}
            </span>
          )}
        </Row>
        {showMarkAllRead && unreadCount > 0 && (
          <Button variant="ghost" onPress={handleMarkAllRead}>
            <Text variant="small" style={{ color: 'var(--ggui-color-primary-500, #3b82f6)' }}>
              Mark all read
            </Text>
          </Button>
        )}
      </Row>

      {/* Notifications */}
      {notifications.length === 0 ? (
        <Stack
          gap="sm"
          style={{
            padding: 40,
            alignItems: 'center',
            color: 'var(--ggui-color-neutral-500, #737373)',
          }}
        >
          <span style={{ fontSize: 32 }}>{'\uD83D\uDD14'}</span>
          <Text variant="body" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
            {emptyMessage}
          </Text>
        </Stack>
      ) : (
        <div style={{ maxHeight: 480, overflowY: 'auto' }}>
          {notifications.map((notification) => {
            const type = notification.type ?? 'info';
            const icon = notification.icon ?? DEFAULT_ICONS[type];

            return (
              <div
                key={notification.id}
                onClick={() => handleClick(notification)}
                onKeyDown={(e) => e.key === 'Enter' && handleClick(notification)}
                role="button"
                tabIndex={0}
                aria-label={`${notification.read ? '' : 'Unread: '}${notification.title}`}
                style={{
                  padding: '14px 20px',
                  backgroundColor: notification.read
                    ? 'transparent'
                    : 'var(--ggui-color-neutral-50, #fafafa)',
                  borderBottom: '1px solid var(--ggui-color-neutral-100, #f5f5f5)',
                  cursor: 'pointer',
                  transition: 'background-color 0.15s',
                }}
              >
                <Row gap="md" align="start">
                  {/* Icon */}
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      backgroundColor: TYPE_BG[type],
                      fontSize: 16,
                      flexShrink: 0,
                    }}
                  >
                    {icon}
                  </span>

                  {/* Content */}
                  <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
                    <Row justify="between" align="start" gap="sm">
                      <Text
                        variant="body"
                        style={{
                          fontWeight: notification.read ? 400 : 600,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {notification.title}
                      </Text>
                      {!notification.read && (
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            backgroundColor: TYPE_COLORS[type],
                            flexShrink: 0,
                            marginTop: 6,
                          }}
                        />
                      )}
                    </Row>
                    {notification.description && (
                      <Text
                        variant="small"
                        style={{
                          color: 'var(--ggui-color-neutral-500, #737373)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                        }}
                      >
                        {notification.description}
                      </Text>
                    )}
                    <Row justify="between" align="center">
                      <Text
                        variant="small"
                        style={{
                          color: 'var(--ggui-color-neutral-400, #a3a3a3)',
                          fontSize: 11,
                        }}
                      >
                        {notification.timestamp}
                      </Text>
                      <Button
                        variant="ghost"
                        onPress={(e?: { stopPropagation?: () => void }) => {
                          e?.stopPropagation?.();
                          handleDismiss(notification.id);
                        }}
                        aria-label={`Dismiss ${notification.title}`}
                        style={{ padding: '2px 8px', fontSize: 12 }}
                      >
                        Dismiss
                      </Button>
                    </Row>
                  </Stack>
                </Row>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
