import { Container, Card, Stack, Row, Text } from '@ggui-ai/design/primitives';

type Trend = 'up' | 'down' | 'flat';

interface Metric {
  label: string;
  value: string;
  change?: number;
  trend?: Trend;
  sparkline?: number[];
}

const defaultMetrics: Metric[] = [
  { label: 'Total Sessions', value: '12,847', change: 12.5, trend: 'up', sparkline: [20, 25, 22, 30, 28, 35, 42, 38, 45, 50, 48, 55] },
  { label: 'Active Users', value: '3,241', change: 8.3, trend: 'up', sparkline: [100, 110, 105, 120, 115, 130, 125, 140, 138, 145, 150, 155] },
  { label: 'Avg Latency', value: '342ms', change: -15.2, trend: 'down', sparkline: [500, 480, 450, 420, 400, 380, 370, 360, 350, 345, 340, 342] },
  { label: 'Error Rate', value: '0.12%', change: -23.1, trend: 'down', sparkline: [0.3, 0.28, 0.25, 0.22, 0.2, 0.18, 0.16, 0.15, 0.14, 0.13, 0.12, 0.12] },
  { label: 'Blueprint Hit Rate', value: '67.3%', change: 5.8, trend: 'up', sparkline: [55, 57, 58, 60, 61, 63, 62, 64, 65, 66, 67, 67.3] },
  { label: 'Cost / Session', value: '$0.023', change: -8.4, trend: 'down', sparkline: [0.035, 0.033, 0.031, 0.03, 0.028, 0.027, 0.026, 0.025, 0.024, 0.024, 0.023, 0.023] },
  { label: 'Gen Success', value: '98.7%', change: 0.3, trend: 'up', sparkline: [97, 97.5, 97.8, 98, 98.1, 98.2, 98.3, 98.4, 98.5, 98.6, 98.6, 98.7] },
  { label: 'Agents Connected', value: '156', change: 0, trend: 'flat', sparkline: [150, 152, 153, 154, 155, 156, 156, 155, 156, 156, 156, 156] },
];

const trendColors: Record<Trend, string> = {
  up: 'var(--ggui-color-success-500, #22c55e)',
  down: 'var(--ggui-color-error-500, #ef4444)',
  flat: 'var(--ggui-color-neutral-500, #737373)',
};

const trendArrows: Record<Trend, string> = {
  up: '\u2191',
  down: '\u2193',
  flat: '\u2192',
};

/** Simple SVG sparkline */
function Sparkline({ data, color, width = 80, height = 24 }: { data: number[]; color: string; width?: number; height?: number }) {
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface MetricCardsProps {
  metrics?: Metric[];
  columns?: number;
  onMetricClick?: (metric: Metric) => void;
}

export default function MetricCards({
  metrics = defaultMetrics,
  columns = 4,
  onMetricClick,
}: MetricCardsProps) {
  // Determine if change is "good" (positive for growth metrics, negative for cost/error metrics)
  const getChangeColor = (metric: Metric): string => {
    if (!metric.trend || metric.trend === 'flat') return trendColors.flat;
    // For metrics where "down" is good (latency, error rate, cost), invert the color
    const inverseLabels = ['latency', 'error', 'cost'];
    const isInverse = inverseLabels.some((l) => metric.label.toLowerCase().includes(l));
    if (isInverse) {
      return metric.trend === 'down' ? trendColors.up : trendColors.down;
    }
    return trendColors[metric.trend];
  };

  return (
    <Container style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: 16,
        }}
      >
        {metrics.map((metric) => {
          const changeColor = getChangeColor(metric);

          return (
            <Card
              key={metric.label}
              padding="md"
              style={{
                cursor: onMetricClick ? 'pointer' : 'default',
              }}
              onClick={() => onMetricClick?.(metric)}
            >
              <Stack gap="sm">
                <Text
                  variant="small"
                  style={{
                    color: 'var(--ggui-color-neutral-500, #737373)',
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    fontSize: 11,
                  }}
                >
                  {metric.label}
                </Text>

                <Row justify="between" align="end">
                  <Text
                    variant="h2"
                    style={{
                      margin: 0,
                      fontSize: 24,
                      fontWeight: 700,
                      lineHeight: 1,
                    }}
                  >
                    {metric.value}
                  </Text>

                  {metric.sparkline && (
                    <Sparkline
                      data={metric.sparkline}
                      color={changeColor}
                    />
                  )}
                </Row>

                {metric.change !== undefined && metric.trend && (
                  <Row align="center" gap="xs">
                    <span
                      style={{
                        color: changeColor,
                        fontWeight: 600,
                        fontSize: 13,
                      }}
                    >
                      {trendArrows[metric.trend]} {Math.abs(metric.change)}%
                    </span>
                    <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)' }}>
                      vs last period
                    </Text>
                  </Row>
                )}
              </Stack>
            </Card>
          );
        })}
      </div>
    </Container>
  );
}
