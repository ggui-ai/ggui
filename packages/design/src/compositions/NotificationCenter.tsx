import type { NotificationCenterProps, Notification } from './types';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { Icon } from '../primitives/Icon';
import { colors } from '../tokens/colors';
import { radius } from '../tokens/spacing';
import { fontSize, fontWeight } from '../tokens/typography';

const variantColors: Record<string, string> = {
  info: colors.info[500],
  success: colors.success[500],
  warning: colors.warning[500],
  error: colors.error[500],
};

function NotificationItem({
  notification,
  onMarkAsRead,
  onDismiss,
}: {
  notification: Notification;
  onMarkAsRead?: (id: string) => void;
  onDismiss?: (id: string) => void;
}) {
  const timestamp =
    notification.timestamp instanceof Date
      ? notification.timestamp.toLocaleString()
      : notification.timestamp;

  const typeColor = variantColors[notification.type || 'info'];

  return (
    <div
      style={{
        display: 'flex',
        gap: '12px',
        padding: '12px',
        backgroundColor: notification.read ? 'transparent' : colors.primary[50],
        borderRadius: radius.md,
        transition: 'background-color 0.15s',
      }}
    >
      <div
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: notification.read ? 'transparent' : typeColor,
          flexShrink: 0,
          marginTop: '6px',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
          <p
            style={{
              margin: 0,
              fontWeight: fontWeight.medium,
              color: colors.gray[900],
              fontSize: fontSize.sm,
            }}
          >
            {notification.title}
          </p>
          <button
            onClick={() => onDismiss?.(notification.id)}
            style={{
              background: 'none',
              border: 'none',
              padding: '2px',
              cursor: 'pointer',
              color: colors.gray[400],
              flexShrink: 0,
            }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        {notification.message && (
          <p
            style={{
              margin: '4px 0 0',
              color: colors.gray[600],
              fontSize: fontSize.xs,
            }}
          >
            {notification.message}
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
          <span style={{ color: colors.gray[400], fontSize: fontSize.xs }}>{timestamp}</span>
          {!notification.read && (
            <button
              onClick={() => onMarkAsRead?.(notification.id)}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                color: colors.primary[600],
                fontSize: fontSize.xs,
                cursor: 'pointer',
              }}
            >
              Mark as read
            </button>
          )}
          {notification.action && (
            <button
              onClick={notification.action.onClick}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                color: colors.primary[600],
                fontSize: fontSize.xs,
                cursor: 'pointer',
              }}
            >
              {notification.action.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * NotificationCenter - A list of notifications with actions
 */
export function NotificationCenter({
  notifications,
  onMarkAsRead,
  onMarkAllAsRead,
  onDismiss,
  onClearAll,
  emptyText = 'No notifications',
  loading,
  style,
  className,
}: NotificationCenterProps) {
  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: `1px solid ${colors.gray[200]}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontWeight: fontWeight.semibold, color: colors.gray[900] }}>
            Notifications
          </span>
          {unreadCount > 0 && (
            <span
              style={{
                padding: '2px 8px',
                borderRadius: '12px',
                backgroundColor: colors.primary[100],
                color: colors.primary[700],
                fontSize: fontSize.xs,
                fontWeight: fontWeight.medium,
              }}
            >
              {unreadCount}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" onClick={onMarkAllAsRead}>
              Mark all read
            </Button>
          )}
          {notifications.length > 0 && (
            <Button variant="ghost" size="sm" onClick={onClearAll}>
              Clear all
            </Button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '32px' }}>
            <Spinner size={24} />
          </div>
        ) : notifications.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px', color: colors.gray[500] }}>
            {emptyText}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {notifications.map((notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                onMarkAsRead={onMarkAsRead}
                onDismiss={onDismiss}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
