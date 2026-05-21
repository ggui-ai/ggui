import type { CSSProperties } from 'react';
import type { EmptyStateProps } from './types';
import { Stack } from '../primitives/Stack';
import { Icon } from '../primitives/Icon';
import { Heading } from '../primitives/Heading';
import { Text } from '../primitives/Text';

/**
 * EmptyState — the placeholder for a region that has no data: empty
 * lists, zero search results, an error fallback.
 *
 * It is the demo-vs-real-UI line — a list that renders nothing when
 * its array is empty looks broken. Reach for `EmptyState` whenever a
 * data array could be empty or a fetch could fail.
 *
 * Composes Icon + Heading + Text + an optional action, centered.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  style,
  className,
}: EmptyStateProps) {
  const composedStyle: CSSProperties = {
    textAlign: 'center',
    padding: 'var(--ggui-spacing-xl, 32px)',
    ...style,
  };

  return (
    <Stack
      align="center"
      gap="sm"
      className={className}
      style={composedStyle}
    >
      {icon !== undefined &&
        (typeof icon === 'string' ? (
          <Icon name={icon} size={40} tone="subtle" />
        ) : (
          icon
        ))}
      <Heading level={3}>{title}</Heading>
      {description !== undefined && <Text tone="muted">{description}</Text>}
      {action !== undefined && (
        <div style={{ marginTop: 'var(--ggui-spacing-sm, 8px)' }}>{action}</div>
      )}
    </Stack>
  );
}
