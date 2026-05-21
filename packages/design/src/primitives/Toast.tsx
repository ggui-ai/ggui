import { useEffect, type ReactElement } from 'react';
import type { CSSProperties } from 'react';
import type { ToastProps } from './types';
import { animation } from '../tokens/motion';

const variantStyles: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  info: {
    bg: 'var(--ggui-color-info-50, #ecfeff)',
    border: 'var(--ggui-color-info-200, #a5f3fc)',
    text: 'var(--ggui-color-info-800, #155e75)',
    icon: 'var(--ggui-color-info-500, #06b6d4)',
  },
  success: {
    bg: 'var(--ggui-color-success-50, #f0fdf4)',
    border: 'var(--ggui-color-success-200, #bbf7d0)',
    text: 'var(--ggui-color-success-800, #166534)',
    icon: 'var(--ggui-color-success-500, #22c55e)',
  },
  warning: {
    bg: 'var(--ggui-color-warning-50, #fffbeb)',
    border: 'var(--ggui-color-warning-200, #fde68a)',
    text: 'var(--ggui-color-warning-800, #92400e)',
    icon: 'var(--ggui-color-warning-500, #f59e0b)',
  },
  error: {
    bg: 'var(--ggui-color-error-50, #fef2f2)',
    border: 'var(--ggui-color-error-200, #fecaca)',
    text: 'var(--ggui-color-error-800, #991b1b)',
    icon: 'var(--ggui-color-error-500, #ef4444)',
  },
};

const defaultIcons: Record<string, ReactElement> = {
  info: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
    </svg>
  ),
  success: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
    </svg>
  ),
  warning: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
    </svg>
  ),
  error: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
    </svg>
  ),
};

/**
 * Toast - A notification toast with auto-dismiss
 */
export function Toast({
  message,
  variant = 'info',
  title,
  duration = 5000,
  onClose,
  visible = true,
  style,
  className,
}: ToastProps) {
  useEffect(() => {
    if (!visible || duration === 0 || !onClose) return;
    const timer = setTimeout(onClose, duration);
    return () => clearTimeout(timer);
  }, [visible, duration, onClose]);

  if (!visible) return null;

  const vs = variantStyles[variant];

  const toastStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--ggui-spacing-2, 8px)',
    padding: 'var(--ggui-spacing-2, 12px) var(--ggui-spacing-4, 16px)',
    borderRadius: 'var(--ggui-shape-radius-lg, 8px)',
    backgroundColor: vs.bg,
    border: `1px solid ${vs.border}`,
    color: vs.text,
    boxShadow: 'var(--ggui-shape-shadow-lg, 0 10px 15px -3px rgba(0,0,0,0.1))',
    minWidth: '280px',
    maxWidth: '420px',
    animation: animation.slideInUp,
    ...style,
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={className}
      style={toastStyle}
    >
      <div style={{ color: vs.icon, flexShrink: 0, marginTop: '2px' }}>
        {defaultIcons[variant]}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {title && (
          <div
            style={{
              fontWeight: 'var(--ggui-font-weight-semibold, 600)' as CSSProperties['fontWeight'],
              fontSize: 'var(--ggui-font-size-sm, 14px)',
            }}
          >
            {title}
          </div>
        )}
        <div style={{ fontSize: 'var(--ggui-font-size-sm, 14px)' }}>
          {message}
        </div>
      </div>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Dismiss notification"
          style={{
            background: 'none',
            border: 'none',
            padding: '4px',
            cursor: 'pointer',
            color: vs.text,
            opacity: 0.7,
            flexShrink: 0,
            lineHeight: 0,
            minWidth: '28px',
            minHeight: '28px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
      )}
    </div>
  );
}
