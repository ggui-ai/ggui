import React from 'react';
import { LUCIDE_ICONS } from './icon-data';
import type { IconProps } from './types';
import { resolveToneCss } from './color-slots';

/**
 * Icon - 185 curated Lucide icons + emoji/unicode passthrough.
 *
 * Accepts icon names in any casing convention:
 *   <Icon name="sun" />           — lowercase
 *   <Icon name="cloud-rain" />    — kebab-case
 *   <Icon name="CloudRain" />     — PascalCase (Lucide native)
 *   <Icon name="cloudRain" />     — camelCase
 *   <Icon name="☀️" />            — emoji passthrough
 *
 * Or with custom SVG children:
 *   <Icon size={20}><svg>...</svg></Icon>
 *
 * Decorative by default (`aria-hidden`) — an icon beside a text label is
 * skipped by screen readers so it is not announced twice. Pass
 * `aria-label` to mark a standalone, meaning-bearing icon.
 *
 * Full curated list in icon-data.ts. Regenerate: node scripts/generate-icon-data.mjs
 * Source: https://lucide.dev/icons (MIT License)
 */

// ---------------------------------------------------------------------------
// Name normalization — convert any casing to Lucide's PascalCase
// ---------------------------------------------------------------------------

const LUCIDE_LOOKUP = new Map<string, string>();
for (const key of Object.keys(LUCIDE_ICONS)) {
  LUCIDE_LOOKUP.set(key.toLowerCase(), key);
}

function resolveLucideName(name: string): string | undefined {
  if (LUCIDE_ICONS[name]) return name;
  const normalized = name.replace(/[-_]/g, '').toLowerCase();
  return LUCIDE_LOOKUP.get(normalized);
}

// ---------------------------------------------------------------------------
// GguiSession Lucide icon from SVG element data
// ---------------------------------------------------------------------------

type IconNode = [string, Record<string, string>][];

function renderLucideIcon(
  data: IconNode,
  size: number,
  color: string,
): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {data.map(([tag, attrs], i) =>
        React.createElement(tag, { key: i, ...attrs }),
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Icon component
// ---------------------------------------------------------------------------

export function Icon({
  name,
  size = 24,
  tone,
  children,
  style,
  className,
  'aria-label': ariaLabel,
}: IconProps) {
  // `tone` is the only color-control prop; the default is
  // `currentColor` so an Icon nested inside themed text inherits that
  // foreground naturally. The `'inherit'` slot resolves to the literal
  // `inherit` keyword which has the same effect for nested `<svg>`.
  const iconColor = tone ? resolveToneCss(tone) : 'currentColor';

  // An Icon is decorative by default: screen readers skip it
  // (`aria-hidden`) so an icon sitting next to a text label is not
  // announced twice. Pass `aria-label` to mark a *standalone*,
  // meaning-bearing icon — it then exposes `role="img"` + that label.
  const a11yProps = ariaLabel
    ? ({ role: 'img', 'aria-label': ariaLabel } as const)
    : ({ 'aria-hidden': true } as const);

  const wrapStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: size,
    height: size,
    color: iconColor,
    ...style,
  };

  // 1. Custom SVG children
  if (children) {
    return (
      <span className={className} style={wrapStyle} {...a11yProps}>
        {children}
      </span>
    );
  }

  // 2. Lucide icon lookup (185 curated icons)
  if (name) {
    const lucideKey = resolveLucideName(name);
    if (lucideKey) {
      return (
        <span className={className} style={wrapStyle} {...a11yProps}>
          {renderLucideIcon(LUCIDE_ICONS[lucideKey] as IconNode, size, iconColor)}
        </span>
      );
    }
  }

  // 3. Emoji / unicode passthrough
  // eslint-disable-next-line no-control-regex
  if (name && /[^\x00-\x7F]/.test(name)) {
    return (
      <span
        className={className}
        {...a11yProps}
        style={{
          ...wrapStyle,
          fontSize: size * 0.75,
          lineHeight: 1,
        }}
      >
        {name}
      </span>
    );
  }

  // 4. Unknown — gray placeholder
  return (
    <span
      className={className}
      {...a11yProps}
      style={{
        ...wrapStyle,
        backgroundColor: 'var(--ggui-color-outlineVariant, #e4e4e7)',
        borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
        color: 'var(--ggui-color-outline, #d4d4d8)',
        fontSize: size * 0.5,
      }}
    >
      ?
    </span>
  );
}
