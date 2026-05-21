import type { CSSProperties, ReactNode } from 'react';

export interface ChatInterfaceProps {
  header?: ReactNode;
  messages: ReactNode;
  input: ReactNode;
  sidebar?: ReactNode;
  sidebarPosition?: 'left' | 'right';
  sidebarWidth?: string;
  style?: CSSProperties;
  className?: string;
}

export function ChatInterface({
  header,
  messages,
  input,
  sidebar,
  sidebarPosition = 'left',
  sidebarWidth = '280px',
  style,
  className,
}: ChatInterfaceProps) {
  const sidebarEl = sidebar ? (
    <aside
      style={{
        width: sidebarWidth,
        flexShrink: 0,
        borderRight: sidebarPosition === 'left' ? '1px solid var(--ggui-color-neutral-200, #e5e7eb)' : undefined,
        borderLeft: sidebarPosition === 'right' ? '1px solid var(--ggui-color-neutral-200, #e5e7eb)' : undefined,
        overflow: 'auto',
        backgroundColor: 'var(--ggui-color-neutral-50, #f9fafb)',
      }}
    >
      {sidebar}
    </aside>
  ) : null;

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: 'var(--ggui-color-neutral-50, #ffffff)',
        ...style,
      }}
    >
      {header && (
        <div
          style={{
            flexShrink: 0,
            borderBottom: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
          }}
        >
          {header}
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {sidebarPosition === 'left' && sidebarEl}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
          }}
        >
          <div style={{ flex: 1, overflow: 'auto' }}>{messages}</div>
          <div
            style={{
              flexShrink: 0,
              borderTop: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
              padding: 'var(--ggui-spacing-4, 16px)',
            }}
          >
            {input}
          </div>
        </div>
        {sidebarPosition === 'right' && sidebarEl}
      </div>
    </div>
  );
}
