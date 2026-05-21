import { useEffect, useCallback } from 'react';
import type { ModalProps } from './types';
import { Button } from '../primitives/Button';
import { Icon } from '../primitives/Icon';
import { Heading } from '../primitives/Heading';
import { colors } from '../tokens/colors';
import { radius, shadow, zIndex } from '../tokens/spacing';
import { animation } from '../tokens/motion';

const sizeWidths: Record<string, string> = {
  sm: '400px',
  md: '500px',
  lg: '640px',
  xl: '800px',
  full: '100vw',
};

/**
 * Modal - A dialog overlay with customizable content
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  closeOnOverlayClick = true,
  closeOnEscape = true,
  showCloseButton = true,
  style,
  className,
}: ModalProps) {
  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnEscape) {
        onClose();
      }
    },
    [closeOnEscape, onClose]
  );

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';

      return () => {
        document.removeEventListener('keydown', handleEscape);
        document.body.style.overflow = '';
      };
    }
  }, [open, handleEscape]);

  if (!open) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && closeOnOverlayClick) {
      onClose();
    }
  };

  const isFullscreen = size === 'full';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: zIndex.modal,
        display: 'flex',
        alignItems: isFullscreen ? 'stretch' : 'center',
        justifyContent: 'center',
        padding: isFullscreen ? 0 : '24px',
      }}
    >
      {/* Overlay */}
      <div
        onClick={handleOverlayClick}
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          animation: animation.fadeIn,
        }}
      />

      {/* Modal content */}
      <div
        role="dialog"
        aria-modal="true"
        className={className}
        style={{
          position: 'relative',
          width: sizeWidths[size],
          maxWidth: isFullscreen ? '100%' : 'calc(100vw - 48px)',
          maxHeight: isFullscreen ? '100%' : 'calc(100vh - 48px)',
          backgroundColor: colors.white,
          borderRadius: isFullscreen ? 0 : radius.xl,
          boxShadow: shadow['2xl'],
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: animation.scaleIn,
          ...style,
        }}
      >
        {/* Header */}
        {(title || showCloseButton) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: `1px solid ${colors.gray[200]}`,
            }}
          >
            {title && <Heading level={4}>{title}</Heading>}
            {showCloseButton && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                aria-label="Close modal"
                style={{ marginLeft: 'auto' }}
              >
                <Icon name="x" size={20} />
              </Button>
            )}
          </div>
        )}

        {/* Body */}
        <div
          style={{
            flex: 1,
            padding: '20px',
            overflowY: 'auto',
          }}
        >
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: '8px',
              padding: '16px 20px',
              borderTop: `1px solid ${colors.gray[200]}`,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
