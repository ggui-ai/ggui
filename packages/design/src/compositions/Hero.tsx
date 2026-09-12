import type { HeroProps } from './types';
import { fontSize, fontWeight, lineHeight, letterSpacing } from '../tokens/typography';

/**
 * Hero - A prominent hero section with heading, description, and CTAs
 *
 * Supports centered and left-aligned layouts, optional background image,
 * primary + secondary action buttons, and a media slot.
 */
export function Hero({
  heading,
  description,
  primaryAction,
  secondaryAction,
  media,
  align = 'center',
  size = 'md',
  background,
  backgroundImage,
  overlay = false,
  style,
  className,
}: HeroProps) {
  const sizeStyles: Record<string, { padding: string; headingSize: string; descSize: string }> = {
    sm: { padding: '48px 24px', headingSize: fontSize['3xl'], descSize: fontSize.lg },
    md: { padding: '80px 24px', headingSize: fontSize['4xl'], descSize: fontSize.xl },
    lg: { padding: '120px 24px', headingSize: fontSize['5xl'], descSize: fontSize.xl },
  };

  const sizeConfig = sizeStyles[size] || sizeStyles.md;

  const hasImage = !!backgroundImage;
  const showOverlay = hasImage && overlay;

  return (
    <section
      className={className}
      style={{
        position: 'relative',
        backgroundColor: background || (hasImage ? undefined : 'var(--ggui-color-container, #ffffff)'),
        ...(hasImage && {
          backgroundImage: `url(${backgroundImage})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }),
        overflow: 'hidden',
        ...style,
      }}
    >
      {/* Dark overlay for background images */}
      {showOverlay && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
          }}
        />
      )}

      <div
        style={{
          position: 'relative',
          maxWidth: '1280px',
          margin: '0 auto',
          padding: sizeConfig.padding,
          display: 'flex',
          flexDirection: align === 'center' ? 'column' : 'row',
          alignItems: align === 'center' ? 'center' : 'center',
          gap: '48px',
          textAlign: align === 'center' ? 'center' : 'left',
        }}
      >
        {/* Text content */}
        <div
          style={{
            flex: align === 'left' && media ? '1 1 50%' : undefined,
            maxWidth: align === 'center' ? '800px' : undefined,
          }}
        >
          {heading && (
            <h1
              style={{
                fontSize: sizeConfig.headingSize,
                fontWeight: fontWeight.bold,
                lineHeight: lineHeight.tight,
                letterSpacing: letterSpacing.tight,
                // Over an image scrim the ink is white whatever the theme (the scrim is fixed dark); on the container it is the theme's ink (ggui#1036).
                color: showOverlay ? '#ffffff' : 'var(--ggui-color-onContainer, #111827)',
                margin: '0 0 16px 0',
                padding: 0,
              }}
            >
              {heading}
            </h1>
          )}

          {description && (
            <p
              style={{
                fontSize: sizeConfig.descSize,
                lineHeight: lineHeight.relaxed,
                color: showOverlay ? 'rgba(255,255,255,0.9)' : 'var(--ggui-color-onSunken, #4b5563)',
                margin: '0 0 32px 0',
                padding: 0,
                maxWidth: align === 'center' ? '640px' : undefined,
                ...(align === 'center' && { marginLeft: 'auto', marginRight: 'auto' }),
              }}
            >
              {description}
            </p>
          )}

          {/* Actions */}
          {(primaryAction || secondaryAction) && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '12px',
                justifyContent: align === 'center' ? 'center' : 'flex-start',
              }}
            >
              {primaryAction && (
                <button
                  onClick={primaryAction.onClick}
                  style={{
                    padding: '12px 28px',
                    fontSize: fontSize.base,
                    fontWeight: fontWeight.semibold,
                    color: 'var(--ggui-color-onPrimary, #ffffff)',
                    backgroundColor: 'var(--ggui-color-primary-600, #0284c7)',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    transition: 'background-color 0.15s',
                    lineHeight: lineHeight.normal,
                  }}
                >
                  {primaryAction.label}
                </button>
              )}

              {secondaryAction && (
                <button
                  onClick={secondaryAction.onClick}
                  style={{
                    padding: '12px 28px',
                    fontSize: fontSize.base,
                    fontWeight: fontWeight.semibold,
                    color: showOverlay ? '#ffffff' : 'var(--ggui-color-onContainer, #374151)',
                    backgroundColor: 'transparent',
                    border: `1px solid ${showOverlay ? 'rgba(255,255,255,0.3)' : 'var(--ggui-color-outline, #d1d5db)'}`,
                    borderRadius: '8px',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    lineHeight: lineHeight.normal,
                  }}
                >
                  {secondaryAction.label}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Media slot */}
        {media && (
          <div
            style={{
              flex: align === 'left' ? '1 1 50%' : undefined,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              ...(align === 'center' && { marginTop: '16px' }),
            }}
          >
            {media}
          </div>
        )}
      </div>
    </section>
  );
}
