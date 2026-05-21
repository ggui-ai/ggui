import { Container, Card, Stack, Row, Text, Button } from '@ggui-ai/design/primitives';

type EventType = 'create' | 'update' | 'delete' | 'deploy' | 'comment' | 'alert';

interface TimelineEvent {
  id: string;
  title: string;
  description: string;
  timestamp: string;
  type: EventType;
  actor?: string;
}

const defaultEvents: TimelineEvent[] = [
  { id: '1', title: 'Production deployment', description: 'Deployed v2.3.1 to production cluster', timestamp: '10 minutes ago', type: 'deploy', actor: 'CI/CD' },
  { id: '2', title: 'Config updated', description: 'Rate limit increased from 100 to 200 req/s', timestamp: '25 minutes ago', type: 'update', actor: 'Alice' },
  { id: '3', title: 'Alert triggered', description: 'CPU usage exceeded 90% threshold on worker-3', timestamp: '1 hour ago', type: 'alert' },
  { id: '4', title: 'New API key created', description: 'API key created for "Analytics Dashboard" app', timestamp: '2 hours ago', type: 'create', actor: 'Bob' },
  { id: '5', title: 'Comment added', description: 'Reviewed and approved the schema migration plan', timestamp: '3 hours ago', type: 'comment', actor: 'Carol' },
  { id: '6', title: 'Service removed', description: 'Deprecated /v1/legacy endpoint removed', timestamp: '5 hours ago', type: 'delete', actor: 'Dan' },
  { id: '7', title: 'Staging deployment', description: 'Deployed feature branch to staging', timestamp: 'Yesterday', type: 'deploy', actor: 'CI/CD' },
  { id: '8', title: 'Database backup', description: 'Automated daily backup completed successfully', timestamp: 'Yesterday', type: 'create' },
];

const eventTypeColors: Record<EventType, string> = {
  create: 'var(--ggui-color-success-500, #22c55e)',
  update: 'var(--ggui-color-primary-600, #0284c7)',
  delete: 'var(--ggui-color-error-500, #ef4444)',
  deploy: 'var(--ggui-color-primary-600, #0284c7)',
  comment: 'var(--ggui-color-neutral-500, #737373)',
  alert: 'var(--ggui-color-warning-500, #f59e0b)',
};

const eventTypeIcons: Record<EventType, string> = {
  create: '+',
  update: '\u2191',
  delete: '\u2715',
  deploy: '\u2192',
  comment: '\u2026',
  alert: '!',
};

interface TimelineFeedProps {
  events?: TimelineEvent[];
  title?: string;
  onEventClick?: (event: TimelineEvent) => void;
  onLoadMore?: () => void;
}

export default function TimelineFeed({
  events = defaultEvents,
  title = 'Activity',
  onEventClick,
  onLoadMore,
}: TimelineFeedProps) {
  return (
    <Container style={{ maxWidth: 600, margin: '0 auto' }}>
      <Stack gap="md">
        <Text variant="h2">{title}</Text>

        <div style={{ position: 'relative' }}>
          {/* Vertical line */}
          <div
            style={{
              position: 'absolute',
              left: 15,
              top: 0,
              bottom: 0,
              width: 2,
              backgroundColor: 'var(--ggui-color-neutral-200, #e5e5e5)',
            }}
          />

          {/* Events */}
          <Stack gap="none">
            {events.map((event) => {
              const color = eventTypeColors[event.type];
              const icon = eventTypeIcons[event.type];

              return (
                <div
                  key={event.id}
                  style={{
                    display: 'flex',
                    gap: 16,
                    padding: '12px 0',
                    cursor: onEventClick ? 'pointer' : 'default',
                  }}
                  onClick={() => onEventClick?.(event)}
                >
                  {/* Event dot */}
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      backgroundColor: `${color}18`,
                      border: `2px solid ${color}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 14,
                      fontWeight: 700,
                      color,
                      flexShrink: 0,
                      zIndex: 1,
                      position: 'relative',
                    }}
                  >
                    {icon}
                  </div>

                  {/* Event content */}
                  <Card padding="md" style={{ flex: 1 }}>
                    <Stack gap="xs">
                      <Row justify="between" align="center">
                        <Text variant="body" style={{ fontWeight: 600 }}>{event.title}</Text>
                        <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)', whiteSpace: 'nowrap' }}>
                          {event.timestamp}
                        </Text>
                      </Row>
                      <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
                        {event.description}
                      </Text>
                      {event.actor && (
                        <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)' }}>
                          by {event.actor}
                        </Text>
                      )}
                    </Stack>
                  </Card>
                </div>
              );
            })}
          </Stack>
        </div>

        {onLoadMore && (
          <Row justify="center">
            <Button variant="outline" size="sm" onPress={onLoadMore}>
              Load more
            </Button>
          </Row>
        )}
      </Stack>
    </Container>
  );
}
