import type { CSSProperties, ReactNode } from 'react';

export interface MarketingHeroAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

export interface MarketingHeroProps {
  /** Main headline (h1) */
  headline: string;
  /** Subheadline / description text */
  subheadline?: string;
  /** Primary CTA button */
  primaryAction?: MarketingHeroAction;
  /** Optional secondary CTA button */
  secondaryAction?: MarketingHeroAction;
  /** Background style variant */
  variant?: 'default' | 'gradient' | 'pattern';
  /** Optional media / illustration to the right */
  media?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

/**
 * Marketing Hero — A large, impactful hero section for landing pages.
 *
 * Features generous spacing, bold typography, gradient background option,
 * and responsive stacking on mobile viewports.
 */
export function MarketingHero({
  headline,
  subheadline,
  primaryAction,
  secondaryAction,
  variant = 'default',
  media,
  style,
  className,
}: MarketingHeroProps) {
  const backgroundStyles: Record<string, CSSProperties> = {
    default: {
      backgroundColor: 'var(--ggui-color-surface, #ffffff)',
    },
    gradient: {
      background:
        'linear-gradient(135deg, var(--ggui-color-primary-50, #f0f9ff) 0%, var(--ggui-color-surface, #ffffff) 50%, var(--ggui-color-primary-100, #e0f2fe) 100%)',
    },
    pattern: {
      backgroundColor: 'var(--ggui-color-primary-900, #0c4a6e)',
      backgroundImage:
        'radial-gradient(circle at 20% 50%, rgba(255,255,255,0.08) 0%, transparent 50%), radial-gradient(circle at 80% 20%, rgba(255,255,255,0.06) 0%, transparent 40%)',
    },
  };

  const isPatternVariant = variant === 'pattern';

  return (
    <section
      className={className}
      style={{
        position: 'relative',
        overflow: 'hidden',
        ...backgroundStyles[variant],
        ...style,
      }}
    >
      <div
        style={{
          maxWidth: '1280px',
          margin: '0 auto',
          padding: '96px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: '64px',
          flexWrap: 'wrap',
        }}
      >
        {/* Text content */}
        <div style={{ flex: '1 1 480px', minWidth: 0 }}>
          <h1
            style={{
              fontSize: 'var(--ggui-font-size-5xl, 48px)',
              fontWeight: 'var(--ggui-font-weight-bold, 700)' as unknown as number,
              lineHeight: 1.1,
              letterSpacing: '-0.025em',
              color: isPatternVariant
                ? '#ffffff'
                : 'var(--ggui-color-onSurface, #18181b)',
              margin: '0 0 24px 0',
            }}
          >
            {headline}
          </h1>

          {subheadline && (
            <p
              style={{
                fontSize: 'var(--ggui-font-size-xl, 20px)',
                lineHeight: 1.6,
                color: isPatternVariant
                  ? 'rgba(255, 255, 255, 0.85)'
                  : 'var(--ggui-color-onSurfaceVariant, #52525b)',
                margin: '0 0 40px 0',
                maxWidth: '560px',
              }}
            >
              {subheadline}
            </p>
          )}

          {/* Action buttons */}
          {(primaryAction || secondaryAction) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px' }}>
              {primaryAction && (
                <ActionButton action={primaryAction} variant="primary" dark={isPatternVariant} />
              )}
              {secondaryAction && (
                <ActionButton action={secondaryAction} variant="secondary" dark={isPatternVariant} />
              )}
            </div>
          )}
        </div>

        {/* Media slot */}
        {media && (
          <div
            style={{
              flex: '1 1 400px',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              minWidth: 0,
            }}
          >
            {media}
          </div>
        )}
      </div>
    </section>
  );
}

/** Internal button renderer */
function ActionButton({
  action,
  variant,
  dark,
}: {
  action: MarketingHeroAction;
  variant: 'primary' | 'secondary';
  dark: boolean;
}) {
  const isPrimary = variant === 'primary';

  const baseStyles: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '14px 32px',
    fontSize: 'var(--ggui-font-size-lg, 18px)',
    fontWeight: 600,
    borderRadius: 'var(--ggui-shape-radius-lg, 12px)',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    textDecoration: 'none',
    border: 'none',
    lineHeight: '1.5',
  };

  const primaryStyles: CSSProperties = dark
    ? {
        backgroundColor: '#ffffff',
        color: 'var(--ggui-color-primary-900, #0c4a6e)',
      }
    : {
        backgroundColor: 'var(--ggui-color-primary-600, #0284c7)',
        color: '#ffffff',
      };

  const secondaryStyles: CSSProperties = dark
    ? {
        backgroundColor: 'transparent',
        color: '#ffffff',
        border: '2px solid rgba(255, 255, 255, 0.3)',
      }
    : {
        backgroundColor: 'transparent',
        color: 'var(--ggui-color-onSurface, #18181b)',
        border: '2px solid var(--ggui-color-outline, #d4d4d8)',
      };

  const combined: CSSProperties = {
    ...baseStyles,
    ...(isPrimary ? primaryStyles : secondaryStyles),
  };

  if (action.href) {
    return (
      <a href={action.href} onClick={action.onClick} style={combined} role="button">
        {action.label}
      </a>
    );
  }

  return (
    <button type="button" onClick={action.onClick} style={combined}>
      {action.label}
    </button>
  );
}
