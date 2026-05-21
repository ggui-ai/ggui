import type { CSSProperties, ReactNode } from 'react';

export interface MakeTabLayoutProps {
  chat: ReactNode;
  canvas: ReactNode;
  chatWidth?: string;
  style?: CSSProperties;
  className?: string;
}

export function MakeTabLayout({
  chat,
  canvas,
  chatWidth = '400px',
  style,
  className,
}: MakeTabLayoutProps) {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        height: '100%',
        minHeight: 0,
        ...style,
      }}
    >
      <div
        style={{
          width: chatWidth,
          minWidth: '320px',
          maxWidth: '50%',
          flexShrink: 0,
          borderRight: '1px solid var(--ggui-color-outlineVariant, #e4e4e7)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {chat}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {canvas}
      </div>
    </div>
  );
}
