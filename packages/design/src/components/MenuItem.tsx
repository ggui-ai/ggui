import type { MenuItemProps } from './types';
import { colors } from '../tokens/colors';
import { radius } from '../tokens/spacing';
import { fontSize, fontWeight } from '../tokens/typography';

/**
 * MenuItem - A clickable item for menus and lists
 */
export function MenuItem({
  label,
  icon,
  rightElement,
  onClick,
  disabled,
  active,
  danger,
  style,
  className,
}: MenuItemProps) {
  const baseColor = danger ? colors.error[600] : colors.gray[700];
  const hoverBg = danger ? colors.error[50] : colors.gray[100];
  const activeBg = danger ? colors.error[100] : colors.primary[50];

  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '8px 12px',
        border: 'none',
        borderRadius: radius.md,
        backgroundColor: active ? activeBg : 'transparent',
        color: disabled ? colors.gray[400] : baseColor,
        fontSize: fontSize.sm,
        fontWeight: active ? fontWeight.medium : fontWeight.normal,
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background-color 0.15s',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled && !active) {
          (e.target as HTMLButtonElement).style.backgroundColor = hoverBg;
        }
      }}
      onMouseLeave={(e) => {
        if (!disabled && !active) {
          (e.target as HTMLButtonElement).style.backgroundColor = 'transparent';
        }
      }}
    >
      {icon && (
        <span style={{ display: 'flex', flexShrink: 0 }}>{icon}</span>
      )}
      <span style={{ flex: 1 }}>{label}</span>
      {rightElement && (
        <span style={{ display: 'flex', flexShrink: 0, color: colors.gray[400] }}>
          {rightElement}
        </span>
      )}
    </button>
  );
}
