import { useState, useRef, useEffect } from 'react';
import type { TooltipProps } from './types';
import { zIndex } from '../tokens/spacing';

/**
 * Tooltip - Shows additional information on hover
 */
export function Tooltip({
  children,
  content,
  position = 'top',
  delay = 200,
  style,
  className,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showTooltip = () => {
    timeoutRef.current = setTimeout(() => {
      setVisible(true);
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setVisible(false);
  };

  useEffect(() => {
    if (visible && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const offset = 8;

      let top = 0;
      let left = 0;

      switch (position) {
        case 'top':
          top = rect.top - offset;
          left = rect.left + rect.width / 2;
          break;
        case 'bottom':
          top = rect.bottom + offset;
          left = rect.left + rect.width / 2;
          break;
        case 'left':
          top = rect.top + rect.height / 2;
          left = rect.left - offset;
          break;
        case 'right':
          top = rect.top + rect.height / 2;
          left = rect.right + offset;
          break;
      }

      setCoords({ top, left });
    }
  }, [visible, position]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const getTransform = () => {
    switch (position) {
      case 'top':
        return 'translateX(-50%) translateY(-100%)';
      case 'bottom':
        return 'translateX(-50%)';
      case 'left':
        return 'translateX(-100%) translateY(-50%)';
      case 'right':
        return 'translateY(-50%)';
    }
  };

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        className={className}
        style={{
          display: 'inline-block',
          ...style,
        }}
      >
        {children}
      </div>
      {visible && (
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            transform: getTransform(),
            backgroundColor: 'var(--ggui-color-onSurface, #18181b)',
            color: '#ffffff',
            padding: '6px 10px',
            borderRadius: 'var(--ggui-shape-radius-md, 8px)',
            fontSize: 'var(--ggui-font-size-xs, 12px)',
            zIndex: zIndex.tooltip,
            maxWidth: '200px',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {content}
        </div>
      )}
    </>
  );
}
