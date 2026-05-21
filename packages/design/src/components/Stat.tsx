import type { StatProps } from './types';
import { Stack } from '../primitives/Stack';
import { Row } from '../primitives/Row';
import { Text } from '../primitives/Text';
import { Icon } from '../primitives/Icon';

/**
 * Stat — a single KPI / metric: a label, a large value, an optional
 * trend-coloured delta and icon.
 *
 * Reach for it whenever the UI is "show a number" — dashboards,
 * weather and price cards, analytics tiles. Drop several into a
 * `<Grid>` for a stat grid instead of hand-building label+value pairs.
 */
export function Stat({
  label,
  value,
  delta,
  trend = 'neutral',
  icon,
  style,
  className,
}: StatProps) {
  const deltaTone =
    trend === 'up' ? 'success' : trend === 'down' ? 'error' : 'muted';

  return (
    <Stack gap="xs" className={className} style={style}>
      <Row gap="xs" align="center">
        {icon !== undefined &&
          (typeof icon === 'string' ? (
            <Icon name={icon} size={16} tone="muted" />
          ) : (
            icon
          ))}
        <Text variant="overline" tone="muted">
          {label}
        </Text>
      </Row>
      <Row gap="sm" align="end">
        <Text size="3xl" weight="bold">
          {value}
        </Text>
        {delta !== undefined && (
          <Text size="sm" weight="semibold" tone={deltaTone}>
            {delta}
          </Text>
        )}
      </Row>
    </Stack>
  );
}
