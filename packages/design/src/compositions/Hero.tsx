import type { HeroProps } from './types';
import { colors } from '../tokens/colors';
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
        backgroundColor: background || (hasImage ? undefined : colors.white),
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
                color: showOverlay ? colors.white : colors.gray[900],
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
                color: showOverlay ? 'rgba(255,255,255,0.9)' : colors.gray[600],
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
                    color: colors.white,
                    backgroundColor: colors.primary[600],
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
                    color: showOverlay ? colors.white : colors.gray[700],
                    backgroundColor: 'transparent',
                    border: `1px solid ${showOverlay ? 'rgba(255,255,255,0.3)' : colors.gray[300]}`,
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
