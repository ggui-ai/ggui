import type { CSSProperties } from 'react';

export interface MarketingCTAAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

export interface MarketingCTAProps {
  /** Section headline */
  headline: string;
  /** Supporting description */
  description?: string;
  /** Primary action button */
  action: MarketingCTAAction;
  /** Visual variant */
  variant?: 'filled' | 'outlined';
  style?: CSSProperties;
  className?: string;
}

/**
 * Marketing CTA — A focused call-to-action section.
 *
 * Creates a visual break with a background color section,
 * a headline, description, and a prominent action button.
 */
export function MarketingCTA({
  headline,
  description,
  action,
  variant = 'filled',
  style,
  className,
}: MarketingCTAProps) {
  const isFilled = variant === 'filled';

  return (
    <section
      className={className}
      style={{
        backgroundColor: isFilled
          ? 'var(--ggui-color-primary-600, #0284c7)'
          : 'var(--ggui-color-surface, #ffffff)',
        ...(isFilled
          ? {}
          : {
              borderTop: '1px solid var(--ggui-color-outlineVariant, #e4e4e7)',
              borderBottom: '1px solid var(--ggui-color-outlineVariant, #e4e4e7)',
            }),
        ...style,
      }}
    >
      <div
        style={{
          maxWidth: '800px',
          margin: '0 auto',
          padding: '80px 24px',
          textAlign: 'center',
        }}
      >
        <h2
          style={{
            fontSize: 'var(--ggui-font-size-3xl, 30px)',
            fontWeight: 'var(--ggui-font-weight-bold, 700)',
            lineHeight: 1.2,
            color: isFilled ? '#ffffff' : 'var(--ggui-color-onSurface, #18181b)',
            margin: '0 0 16px 0',
          }}
        >
          {headline}
        </h2>

        {description && (
          <p
            style={{
              fontSize: 'var(--ggui-font-size-lg, 18px)',
              lineHeight: 1.6,
              color: isFilled
                ? 'rgba(255, 255, 255, 0.85)'
                : 'var(--ggui-color-onSurfaceVariant, #52525b)',
              margin: '0 0 32px 0',
              maxWidth: '560px',
              marginLeft: 'auto',
              marginRight: 'auto',
            }}
          >
            {description}
          </p>
        )}

        <CTAButton action={action} filled={isFilled} />
      </div>
    </section>
  );
}

/** CTA button with adaptive styling based on background */
function CTAButton({
  action,
  filled,
}: {
  action: MarketingCTAAction;
  filled: boolean;
}) {
  const styles: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '14px 36px',
    fontSize: 'var(--ggui-font-size-lg, 18px)',
    fontWeight: 600,
    borderRadius: 'var(--ggui-shape-radius-lg, 12px)',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    textDecoration: 'none',
    border: 'none',
    lineHeight: '1.5',
    ...(filled
      ? {
          backgroundColor: '#ffffff',
          color: 'var(--ggui-color-primary-700, #0369a1)',
        }
      : {
          backgroundColor: 'var(--ggui-color-primary-600, #0284c7)',
          color: '#ffffff',
        }),
  };

  if (action.href) {
    return (
      <a href={action.href} onClick={action.onClick} style={styles} role="button">
        {action.label}
      </a>
    );
  }

  return (
    <button type="button" onClick={action.onClick} style={styles}>
      {action.label}
    </button>
  );
}
