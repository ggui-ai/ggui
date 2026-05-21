import type { UserProfileCardProps } from './types';
import { Avatar } from '../primitives/Avatar';
import { Card } from '../primitives/Card';
import { colors } from '../tokens/colors';
import { fontSize, fontWeight } from '../tokens/typography';

/**
 * UserProfileCard - A user profile display with avatar, name, bio, and stats
 */
export function UserProfileCard({
  name,
  subtitle,
  avatar,
  coverImage,
  bio,
  stats,
  actions,
  compact,
  style,
  className,
}: UserProfileCardProps) {
  if (compact) {
    return (
      <Card className={className} style={{ padding: '16px', ...style }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Avatar name={name} src={avatar} size="md" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p
              style={{
                margin: 0,
                fontWeight: fontWeight.semibold,
                color: colors.gray[900],
                fontSize: fontSize.sm,
              }}
            >
              {name}
            </p>
            {subtitle && (
              <p
                style={{
                  margin: '2px 0 0',
                  color: colors.gray[500],
                  fontSize: fontSize.xs,
                }}
              >
                {subtitle}
              </p>
            )}
          </div>
          {actions}
        </div>
      </Card>
    );
  }

  return (
    <Card className={className} style={{ padding: 0, overflow: 'hidden', ...style }}>
      {coverImage && (
        <div
          style={{
            height: '120px',
            backgroundImage: `url(${coverImage})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
      )}
      <div
        style={{
          padding: '16px',
          paddingTop: coverImage ? '0' : '16px',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            marginTop: coverImage ? '-40px' : '0',
            marginBottom: '12px',
          }}
        >
          <Avatar
            name={name}
            src={avatar}
            size="xl"
            style={{
              border: `4px solid ${colors.white}`,
              margin: '0 auto',
            }}
          />
        </div>
        <p
          style={{
            margin: 0,
            fontWeight: fontWeight.semibold,
            color: colors.gray[900],
            fontSize: fontSize.lg,
          }}
        >
          {name}
        </p>
        {subtitle && (
          <p
            style={{
              margin: '4px 0 0',
              color: colors.gray[500],
              fontSize: fontSize.sm,
            }}
          >
            {subtitle}
          </p>
        )}
        {bio && (
          <p
            style={{
              margin: '12px 0 0',
              color: colors.gray[600],
              fontSize: fontSize.sm,
              lineHeight: 1.5,
            }}
          >
            {bio}
          </p>
        )}
        {stats && stats.length > 0 && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: '24px',
              marginTop: '16px',
              paddingTop: '16px',
              borderTop: `1px solid ${colors.gray[200]}`,
            }}
          >
            {stats.map((stat, index) => (
              <div key={index} style={{ textAlign: 'center' }}>
                <p
                  style={{
                    margin: 0,
                    fontWeight: fontWeight.semibold,
                    color: colors.gray[900],
                    fontSize: fontSize.lg,
                  }}
                >
                  {stat.value}
                </p>
                <p
                  style={{
                    margin: '2px 0 0',
                    color: colors.gray[500],
                    fontSize: fontSize.xs,
                  }}
                >
                  {stat.label}
                </p>
              </div>
            ))}
          </div>
        )}
        {actions && (
          <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'center', gap: '8px' }}>
            {actions}
          </div>
        )}
      </div>
    </Card>
  );
}
