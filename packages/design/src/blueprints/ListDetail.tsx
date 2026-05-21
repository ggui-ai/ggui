import type { CSSProperties, ReactNode } from 'react';

export interface ListDetailProps {
  header?: ReactNode;
  list: ReactNode;
  detail?: ReactNode;
  emptyDetail?: ReactNode;
  listWidth?: string;
  style?: CSSProperties;
  className?: string;
}

export function ListDetail({
  header,
  list,
  detail,
  emptyDetail,
  listWidth = '360px',
  style,
  className,
}: ListDetailProps) {
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
        <div
          style={{
            width: listWidth,
            flexShrink: 0,
            borderRight: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
            overflow: 'auto',
          }}
        >
          {list}
        </div>
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            minWidth: 0,
          }}
        >
          {detail || emptyDetail || (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: 'var(--ggui-color-neutral-400, #9ca3af)',
                fontFamily: 'var(--ggui-font-family-sans, sans-serif)',
                fontSize: 'var(--ggui-font-size-sm, 14px)',
              }}
            >
              Select an item to view details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
