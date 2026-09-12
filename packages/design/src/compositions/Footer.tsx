import type { FooterProps } from './types';
import { fontSize, fontWeight, lineHeight } from '../tokens/typography';

/**
 * Footer - A site footer with logo, link columns, and bottom bar
 *
 * Supports multi-column link sections, a brand area, social links,
 * and a bottom bar with copyright text.
 */
export function Footer({
  brand,
  columns,
  socialLinks,
  bottomText,
  bottomLinks,
  background,
  bordered = true,
  style,
  className,
}: FooterProps) {
  return (
    <footer
      className={className}
      role="contentinfo"
      style={{
        backgroundColor: background || 'var(--ggui-color-sunken, #f9fafb)',
        borderTop: bordered ? '1px solid var(--ggui-color-outlineVariant, #e5e7eb)' : undefined,
        ...style,
      }}
    >
      {/* Main footer content */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '48px',
          padding: '48px 24px',
          maxWidth: '1280px',
          margin: '0 auto',
        }}
      >
        {/* Brand column */}
        {brand && (
          <div style={{ flex: '1 1 280px', minWidth: '200px' }}>
            {brand}
          </div>
        )}

        {/* Link columns */}
        {columns?.map((column, colIdx) => (
          <div
            key={colIdx}
            style={{ flex: '0 1 180px', minWidth: '140px' }}
          >
            {column.title && (
              <h4
                style={{
                  fontSize: fontSize.sm,
                  fontWeight: fontWeight.semibold,
                  color: 'var(--ggui-color-onContainer, #111827)',
                  lineHeight: lineHeight.normal,
                  margin: '0 0 16px 0',
                  padding: 0,
                }}
              >
                {column.title}
              </h4>
            )}
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              {column.links.map((link, linkIdx) => (
                <li key={linkIdx}>
                  <a
                    href={link.href}
                    onClick={
                      link.onClick
                        ? (e) => {
                            e.preventDefault();
                            link.onClick?.();
                          }
                        : undefined
                    }
                    style={{
                      fontSize: fontSize.sm,
                      color: 'var(--ggui-color-onSunken, #4b5563)',
                      textDecoration: 'none',
                      transition: 'color 0.15s',
                      lineHeight: lineHeight.normal,
                    }}
                    aria-label={link.label}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Bottom bar */}
      {(bottomText || bottomLinks || socialLinks) && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
            padding: '20px 24px',
            maxWidth: '1280px',
            margin: '0 auto',
            borderTop: '1px solid var(--ggui-color-outlineVariant, #e5e7eb)',
          }}
        >
          {/* Copyright text */}
          {bottomText && (
            <span
              style={{
                fontSize: fontSize.sm,
                color: 'var(--ggui-color-neutral-500, #6b7280)',
                lineHeight: lineHeight.normal,
              }}
            >
              {bottomText}
            </span>
          )}

          {/* Social + bottom links */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            {socialLinks?.map((social, idx) => (
              <a
                key={idx}
                href={social.href}
                aria-label={social.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--ggui-color-neutral-500, #6b7280)',
                  transition: 'color 0.15s',
                }}
              >
                {social.icon}
              </a>
            ))}

            {bottomLinks?.map((link, idx) => (
              <a
                key={idx}
                href={link.href}
                onClick={
                  link.onClick
                    ? (e) => {
                        e.preventDefault();
                        link.onClick?.();
                      }
                    : undefined
                }
                style={{
                  fontSize: fontSize.sm,
                  color: 'var(--ggui-color-neutral-500, #6b7280)',
                  textDecoration: 'none',
                  transition: 'color 0.15s',
                }}
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>
      )}
    </footer>
  );
}
