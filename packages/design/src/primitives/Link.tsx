import type { LinkProps } from './types';
import { resolveToneCss } from './color-slots';

/**
 * Link - An anchor element with consistent styling
 */
export function Link({
  children,
  href,
  external,
  tone,
  underline = 'hover',
  style,
  className,
  ...rest
}: LinkProps) {
  const linkColor = tone
    ? resolveToneCss(tone)
    : 'var(--ggui-color-primary-600, #0284c7)';

  const underlineStyle = {
    always: 'underline',
    hover: 'none',
    none: 'none',
  }[underline];

  return (
    <a
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      className={className}
      style={{
        color: linkColor,
        textDecoration: underlineStyle,
        cursor: 'pointer',
        transition: 'color 0.2s',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (underline === 'hover') {
          (e.target as HTMLAnchorElement).style.textDecoration = 'underline';
        }
      }}
      onMouseLeave={(e) => {
        if (underline === 'hover') {
          (e.target as HTMLAnchorElement).style.textDecoration = 'none';
        }
      }}
      {...rest}
    >
      {children}
      {external && (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ marginLeft: '4px', verticalAlign: 'middle' }}
        >
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      )}
    </a>
  );
}
