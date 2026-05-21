import { useState } from 'react';
import { Container, Card, Row, Stack, Text, Button, Badge } from '@ggui-ai/design/primitives';

interface Service {
  name: string;
  status: 'operational' | 'degraded' | 'down';
  uptime: number;
  lastChecked: string;
}

interface Incident {
  id: string;
  title: string;
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  timestamp: string;
  description: string;
}

const defaultServices: Service[] = [
  { name: 'API Gateway', status: 'operational', uptime: 99.99, lastChecked: '2 min ago' },
  { name: 'Database', status: 'operational', uptime: 99.95, lastChecked: '1 min ago' },
  { name: 'Auth Service', status: 'degraded', uptime: 98.5, lastChecked: '3 min ago' },
  { name: 'CDN', status: 'operational', uptime: 99.99, lastChecked: '1 min ago' },
  { name: 'WebSocket', status: 'operational', uptime: 99.9, lastChecked: '2 min ago' },
  { name: 'Storage', status: 'down', uptime: 95.2, lastChecked: '30 sec ago' },
];

const defaultIncidents: Incident[] = [
  {
    id: '1',
    title: 'Storage service degradation',
    status: 'investigating',
    timestamp: '10 minutes ago',
    description: 'Elevated error rates on the storage service. Team is investigating.',
  },
  {
    id: '2',
    title: 'Auth service latency increase',
    status: 'monitoring',
    timestamp: '45 minutes ago',
    description: 'Auth latency spiked to 500ms. Root cause identified, fix deployed, monitoring.',
  },
  {
    id: '3',
    title: 'Scheduled maintenance completed',
    status: 'resolved',
    timestamp: '2 hours ago',
    description: 'Database migration completed successfully. All services restored.',
  },
];

const statusColors: Record<string, string> = {
  operational: 'var(--ggui-color-success-500, #22c55e)',
  degraded: 'var(--ggui-color-warning-500, #f59e0b)',
  down: 'var(--ggui-color-error-500, #ef4444)',
};

const incidentStatusColors: Record<string, string> = {
  investigating: 'var(--ggui-color-error-500, #ef4444)',
  identified: 'var(--ggui-color-warning-500, #f59e0b)',
  monitoring: 'var(--ggui-color-primary-600, #0284c7)',
  resolved: 'var(--ggui-color-success-500, #22c55e)',
};

interface StatusDashboardProps {
  title?: string;
  services?: Service[];
  incidents?: Incident[];
  onServiceClick?: (service: Service) => void;
  onRefresh?: () => void;
}

export default function StatusDashboard({
  title = 'System Status',
  services = defaultServices,
  incidents = defaultIncidents,
  onServiceClick,
  onRefresh,
}: StatusDashboardProps) {
  const [refreshing, setRefreshing] = useState(false);

  const allOperational = services.every((s) => s.status === 'operational');
  const overallColor = allOperational
    ? statusColors.operational
    : services.some((s) => s.status === 'down')
      ? statusColors.down
      : statusColors.degraded;

  const handleRefresh = () => {
    setRefreshing(true);
    onRefresh?.();
    setTimeout(() => setRefreshing(false), 1000);
  };

  return (
    <Container style={{ maxWidth: 800, margin: '0 auto' }}>
      <Stack gap="lg">
        {/* Overall Status Header */}
        <Card padding="lg">
          <Row justify="between" align="center">
            <Row align="center" gap="md">
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  backgroundColor: overallColor,
                  boxShadow: `0 0 8px ${overallColor}`,
                }}
              />
              <div>
                <Text variant="h2" style={{ margin: 0 }}>{title}</Text>
                <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
                  {allOperational
                    ? 'All systems operational'
                    : 'Some systems experiencing issues'}
                </Text>
              </div>
            </Row>
            <Button variant="outline" size="sm" onPress={handleRefresh}>
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </Button>
          </Row>
        </Card>

        {/* Service Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
            gap: 12,
          }}
        >
          {services.map((service) => (
            <Card
              key={service.name}
              padding="md"
              style={{ cursor: onServiceClick ? 'pointer' : 'default' }}
              onClick={() => onServiceClick?.(service)}
            >
              <Stack gap="sm">
                <Row justify="between" align="center">
                  <Text variant="body" style={{ fontWeight: 600 }}>{service.name}</Text>
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      backgroundColor: statusColors[service.status],
                    }}
                  />
                </Row>
                <Row justify="between" align="center">
                  <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
                    {service.uptime}% uptime
                  </Text>
                  <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)' }}>
                    {service.lastChecked}
                  </Text>
                </Row>
                <div
                  style={{
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: 'var(--ggui-color-neutral-100, #f5f5f5)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${service.uptime}%`,
                      backgroundColor: statusColors[service.status],
                      borderRadius: 2,
                    }}
                  />
                </div>
              </Stack>
            </Card>
          ))}
        </div>

        {/* Incidents */}
        {incidents.length > 0 && (
          <Card padding="none">
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ggui-color-neutral-200, #e5e5e5)' }}>
              <Text variant="h3" style={{ margin: 0 }}>Recent Incidents</Text>
            </div>
            {incidents.map((incident, i) => (
              <div
                key={incident.id}
                style={{
                  padding: '14px 20px',
                  borderBottom: i < incidents.length - 1
                    ? '1px solid var(--ggui-color-neutral-100, #f5f5f5)'
                    : 'none',
                }}
              >
                <Row justify="between" align="start">
                  <Stack gap="xs" style={{ flex: 1 }}>
                    <Row align="center" gap="sm">
                      <Text variant="body" style={{ fontWeight: 600 }}>{incident.title}</Text>
                      <Badge
                        size="sm"
                        variant={incident.status === 'resolved' ? 'success' : 'default'}
                      >
                        {incident.status}
                      </Badge>
                    </Row>
                    <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
                      {incident.description}
                    </Text>
                  </Stack>
                  <Text
                    variant="small"
                    style={{
                      color: 'var(--ggui-color-neutral-400, #a3a3a3)',
                      whiteSpace: 'nowrap',
                      marginLeft: 16,
                    }}
                  >
                    {incident.timestamp}
                  </Text>
                </Row>
              </div>
            ))}
          </Card>
        )}
      </Stack>
    </Container>
  );
}
