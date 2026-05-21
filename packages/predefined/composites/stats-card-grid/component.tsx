import { Card, Stack, Row, Text } from '@ggui-ai/design/primitives';

interface StatItem {
  id?: string;
  label: string;
  value: string | number;
  change?: number;
  changeLabel?: string;
  trend?: 'up' | 'down' | 'neutral';
  icon?: string;
}

interface StatsCardGridProps {
  stats: StatItem[];
  columns?: number;
  title?: string;
  onStatClick?: (stat: StatItem) => void;
}

function TrendIndicator({ change, trend }: { change?: number; trend?: 'up' | 'down' | 'neutral' }) {
  if (change == null) return null;

  const direction = trend ?? (change > 0 ? 'up' : change < 0 ? 'down' : 'neutral');
  const color =
    direction === 'up'
      ? 'var(--ggui-color-success-500, #22c55e)'
      : direction === 'down'
        ? 'var(--ggui-color-error-500, #ef4444)'
        : 'var(--ggui-color-neutral-500, #737373)';
  const arrow = direction === 'up' ? '\u2191' : direction === 'down' ? '\u2193' : '\u2192';
  const sign = change > 0 ? '+' : '';

  return (
    <Row gap="xs" align="center">
      <Text
        variant="small"
        style={{
          color,
          fontWeight: 500,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
        }}
      >
        <span>{arrow}</span>
        {sign}{change}%
      </Text>
    </Row>
  );
}

function StatCard({
  stat,
  onClick,
}: {
  stat: StatItem;
  onClick?: (stat: StatItem) => void;
}) {
  return (
    <Card
      padding="lg"
      style={{
        cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow 0.2s, transform 0.2s',
        border: '1px solid var(--ggui-color-neutral-200, #e5e5e5)',
      }}
      onClick={() => onClick?.(stat)}
    >
      <Stack gap="sm">
        <Row justify="between" align="center">
          <Text
            variant="small"
            style={{
              color: 'var(--ggui-color-neutral-500, #737373)',
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontSize: 12,
            }}
          >
            {stat.label}
          </Text>
          {stat.icon && (
            <span
              style={{
                fontSize: 20,
                color: 'var(--ggui-color-primary-500, #3b82f6)',
              }}
            >
              {stat.icon}
            </span>
          )}
        </Row>

        <Text
          variant="h2"
          style={{
            fontSize: 28,
            fontWeight: 700,
            color: 'var(--ggui-color-neutral-900, #171717)',
            lineHeight: 1.2,
          }}
        >
          {stat.value}
        </Text>

        {(stat.change != null || stat.changeLabel) && (
          <Row gap="sm" align="center">
            <TrendIndicator change={stat.change} trend={stat.trend} />
            {stat.changeLabel && (
              <Text
                variant="small"
                style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}
              >
                {stat.changeLabel}
              </Text>
            )}
          </Row>
        )}
      </Stack>
    </Card>
  );
}

export default function StatsCardGrid({
  stats,
  columns = 4,
  title,
  onStatClick,
}: StatsCardGridProps) {
  return (
    <Stack gap="lg">
      {title && (
        <Text variant="h3" style={{ color: 'var(--ggui-color-neutral-800, #262626)' }}>
          {title}
        </Text>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: 16,
        }}
      >
        {stats.map((stat, index) => (
          <StatCard
            key={stat.id ?? index}
            stat={stat}
            onClick={onStatClick}
          />
        ))}
      </div>
    </Stack>
  );
}
