import type { CSSProperties, ReactNode } from 'react';

export interface DashboardProps {
  header?: ReactNode;
  sidebar?: ReactNode;
  stats?: ReactNode;
  charts?: ReactNode;
  tables?: ReactNode;
  sidebarWidth?: string;
  sidebarCollapsed?: boolean;
  style?: CSSProperties;
  className?: string;
}

export function Dashboard({
  header,
  sidebar,
  stats,
  charts,
  tables,
  sidebarWidth = '240px',
  sidebarCollapsed = false,
  style,
  className,
}: DashboardProps) {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: 'var(--ggui-color-neutral-50, #f9fafb)',
        ...style,
      }}
    >
      {header && (
        <div
          style={{
            flexShrink: 0,
            borderBottom: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
            backgroundColor: 'var(--ggui-color-neutral-50, #ffffff)',
          }}
        >
          {header}
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {sidebar && (
          <aside
            style={{
              width: sidebarCollapsed ? '64px' : sidebarWidth,
              flexShrink: 0,
              borderRight: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
              backgroundColor: 'var(--ggui-color-neutral-50, #ffffff)',
              overflow: 'auto',
              transition: 'width var(--ggui-motion-duration-normal, 200ms)',
            }}
          >
            {sidebar}
          </aside>
        )}
        <main
          style={{
            flex: 1,
            overflow: 'auto',
            padding: 'var(--ggui-spacing-6, 24px)',
          }}
        >
          {stats && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 'var(--ggui-spacing-4, 16px)',
                marginBottom: 'var(--ggui-spacing-6, 24px)',
              }}
            >
              {stats}
            </div>
          )}
          {charts && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))',
                gap: 'var(--ggui-spacing-4, 16px)',
                marginBottom: 'var(--ggui-spacing-6, 24px)',
              }}
            >
              {charts}
            </div>
          )}
          {tables && <div>{tables}</div>}
        </main>
      </div>
    </div>
  );
}
