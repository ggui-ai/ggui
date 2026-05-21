import type { HeaderProps } from './types';
import { colors } from '../tokens/colors';
import { shadow, zIndex } from '../tokens/spacing';

/**
 * Header - A page header with logo, navigation, and actions
 */
export function Header({
  logo,
  navigation,
  actions,
  sticky = false,
  background,
  bordered = true,
  style,
  className,
}: HeaderProps) {
  return (
    <header
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 24px',
        backgroundColor: background || colors.white,
        borderBottom: bordered ? `1px solid ${colors.gray[200]}` : undefined,
        ...(sticky && {
          position: 'sticky',
          top: 0,
          zIndex: zIndex.sticky,
          boxShadow: shadow.sm,
        }),
        ...style,
      }}
    >
      {logo && <div style={{ flexShrink: 0 }}>{logo}</div>}
      {navigation && (
        <nav style={{ display: 'flex', alignItems: 'center', flex: 1, marginLeft: '32px' }}>
          {navigation}
        </nav>
      )}
      {actions && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
          {actions}
        </div>
      )}
    </header>
  );
}
