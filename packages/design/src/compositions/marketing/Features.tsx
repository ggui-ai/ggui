import type { CSSProperties, ReactNode } from 'react';

export interface FeatureItem {
  /** Icon or emoji displayed above the title */
  icon?: ReactNode;
  /** Feature title */
  title: string;
  /** Feature description */
  description: string;
}

export interface MarketingFeaturesProps {
  /** Optional section heading */
  heading?: string;
  /** Optional section subheading */
  subheading?: string;
  /** Feature items to display in a grid */
  features: FeatureItem[];
  /** Number of columns on desktop (defaults to 3) */
  columns?: 2 | 3 | 4;
  style?: CSSProperties;
  className?: string;
}

/**
 * Marketing Features — A responsive grid of feature cards.
 *
 * 3-column layout on desktop, single column on mobile.
 * Each card has an icon/emoji, title, and description with hover effects.
 */
export function MarketingFeatures({
  heading,
  subheading,
  features,
  columns = 3,
  style,
  className,
}: MarketingFeaturesProps) {
  return (
    <section
      className={className}
      style={{
        backgroundColor: 'var(--ggui-color-surface, #ffffff)',
        ...style,
      }}
    >
      <div
        style={{
          maxWidth: '1280px',
          margin: '0 auto',
          padding: '80px 24px',
        }}
      >
        {/* Section header */}
        {(heading || subheading) && (
          <div style={{ textAlign: 'center', marginBottom: '64px' }}>
            {heading && (
              <h2
                style={{
                  fontSize: 'var(--ggui-font-size-3xl, 30px)',
                  fontWeight: 'var(--ggui-font-weight-bold, 700)',
                  lineHeight: 1.2,
                  color: 'var(--ggui-color-onSurface, #18181b)',
                  margin: '0 0 16px 0',
                }}
              >
                {heading}
              </h2>
            )}
            {subheading && (
              <p
                style={{
                  fontSize: 'var(--ggui-font-size-lg, 18px)',
                  lineHeight: 1.6,
                  color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
                  margin: 0,
                  maxWidth: '640px',
                  marginLeft: 'auto',
                  marginRight: 'auto',
                }}
              >
                {subheading}
              </p>
            )}
          </div>
        )}

        {/* Feature grid */}
        <div
          className="ggui-features-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, 1fr)`,
            gap: '32px',
          }}
        >
          {features.map((feature, index) => (
            <FeatureCard key={index} feature={feature} />
          ))}
        </div>
      </div>

      {/* Responsive style tag for mobile stacking */}
      <style>{`
        @media (max-width: 768px) {
          .ggui-features-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </section>
  );
}

/** Individual feature card with hover effect */
function FeatureCard({ feature }: { feature: FeatureItem }) {
  return (
    <div
      style={{
        padding: 'var(--ggui-spacing-6, 24px)',
        borderRadius: 'var(--ggui-shape-radius-xl, 16px)',
        backgroundColor: 'var(--ggui-color-surface, #ffffff)',
        border: '1px solid var(--ggui-color-outlineVariant, #e4e4e7)',
        transition: 'box-shadow 0.2s ease, transform 0.2s ease',
        cursor: 'default',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow =
          'var(--ggui-shape-shadow-lg, 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1))';
        e.currentTarget.style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = 'none';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      {/* Icon */}
      {feature.icon && (
        <div
          style={{
            fontSize: '32px',
            marginBottom: 'var(--ggui-spacing-4, 16px)',
            lineHeight: 1,
          }}
        >
          {feature.icon}
        </div>
      )}

      {/* Title */}
      <h3
        style={{
          fontSize: 'var(--ggui-font-size-xl, 20px)',
          fontWeight: 'var(--ggui-font-weight-semibold, 600)',
          lineHeight: 1.3,
          color: 'var(--ggui-color-onSurface, #18181b)',
          margin: '0 0 8px 0',
        }}
      >
        {feature.title}
      </h3>

      {/* Description */}
      <p
        style={{
          fontSize: 'var(--ggui-font-size-base, 16px)',
          lineHeight: 1.6,
          color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
          margin: 0,
        }}
      >
        {feature.description}
      </p>
    </div>
  );
}
