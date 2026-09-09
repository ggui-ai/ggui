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
  // Sits on an `elevated` menu (ggui#987 §2.1): text is onElevated, the
  // hover wash is sunken, the active wash the accent's container tint.
  const baseColor = danger ? 'var(--ggui-color-error-600, #dc2626)' : 'var(--ggui-color-onElevated, #3f3f46)';
  const hoverBg = danger ? 'var(--ggui-color-error-50, #fef2f2)' : 'var(--ggui-color-sunken, #f4f4f5)';
  const activeBg = danger ? 'var(--ggui-color-error-100, #fee2e2)' : 'var(--ggui-color-primary-50, #f0f9ff)';

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
