import { useState } from 'react';
import { Card, Stack, Row, Text, Button, Badge, Tabs } from '@ggui-ai/design/primitives';

type Priority = 'low' | 'medium' | 'high' | 'urgent';
type Status = 'pending' | 'approved' | 'rejected';

interface ApprovalItem {
  id: string;
  title: string;
  requester: string;
  description: string;
  priority: Priority;
  status: Status;
  createdAt: string;
}

const defaultItems: ApprovalItem[] = [
  { id: '1', title: 'Deploy v2.3 to production', requester: 'Alice Chen', description: 'Release includes auth improvements and bug fixes.', priority: 'high', status: 'pending', createdAt: '5 min ago' },
  { id: '2', title: 'Add new API endpoint /users/export', requester: 'Bob Kim', description: 'CSV export endpoint for admin dashboard.', priority: 'medium', status: 'pending', createdAt: '20 min ago' },
  { id: '3', title: 'Upgrade database to r6g.xlarge', requester: 'Carol Wu', description: 'Current instance hitting CPU limits during peak.', priority: 'urgent', status: 'pending', createdAt: '1 hour ago' },
  { id: '4', title: 'Enable feature flag: dark-mode', requester: 'Dan Park', description: 'Dark mode ready for gradual rollout.', priority: 'low', status: 'approved', createdAt: '2 hours ago' },
  { id: '5', title: 'Remove deprecated /v1/auth endpoint', requester: 'Eve Liu', description: 'No traffic in 30 days. Safe to remove.', priority: 'medium', status: 'rejected', createdAt: '3 hours ago' },
];

const priorityColors: Record<Priority, string> = {
  low: 'var(--ggui-color-neutral-500, #737373)',
  medium: 'var(--ggui-color-primary-600, #0284c7)',
  high: 'var(--ggui-color-warning-500, #f59e0b)',
  urgent: 'var(--ggui-color-error-500, #ef4444)',
};

interface ApprovalQueueProps {
  title?: string;
  items?: ApprovalItem[];
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  onItemClick?: (item: ApprovalItem) => void;
}

export default function ApprovalQueue({
  title = 'Approval Queue',
  items: initialItems = defaultItems,
  onApprove,
  onReject,
  onItemClick,
}: ApprovalQueueProps) {
  const [items, setItems] = useState(initialItems);
  const [filter, setFilter] = useState<'all' | Status>('pending');

  const pendingCount = items.filter((i) => i.status === 'pending').length;
  const approvedCount = items.filter((i) => i.status === 'approved').length;
  const rejectedCount = items.filter((i) => i.status === 'rejected').length;

  const filteredItems = items.filter((item) => {
    if (filter === 'all') return true;
    return item.status === filter;
  });

  const handleApprove = (id: string) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'approved' as Status } : i)));
    onApprove?.(id);
  };

  const handleReject = (id: string) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'rejected' as Status } : i)));
    onReject?.(id);
  };

  return (
    <Card
      padding="none"
      style={{
        maxWidth: 680,
        margin: '0 auto',
        border: '1px solid var(--ggui-color-neutral-200, #e5e5e5)',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--ggui-color-neutral-200, #e5e5e5)' }}>
        <Row justify="between" align="center">
          <Text variant="h2" style={{ margin: 0 }}>{title}</Text>
          <Badge variant="default">{pendingCount} pending</Badge>
        </Row>
      </div>

      {/* Filter Tabs */}
      <div style={{ padding: '0 24px' }}>
        <Tabs
          items={[
            { key: 'pending', label: `Pending (${pendingCount})`, content: null },
            { key: 'approved', label: `Approved (${approvedCount})`, content: null },
            { key: 'rejected', label: `Rejected (${rejectedCount})`, content: null },
            { key: 'all', label: `All (${items.length})`, content: null },
          ]}
          activeKey={filter}
          onChange={(key) => setFilter(key as 'all' | Status)}
          variant="line"
          size="sm"
          fullWidth
        />
      </div>

      {/* Items */}
      <div style={{ maxHeight: 500, overflowY: 'auto' }}>
        {filteredItems.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center' }}>
            <Text variant="body" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
              No items in this category
            </Text>
          </div>
        ) : (
          filteredItems.map((item) => (
            <div
              key={item.id}
              style={{
                padding: '16px 24px',
                borderBottom: '1px solid var(--ggui-color-neutral-100, #f5f5f5)',
                cursor: onItemClick ? 'pointer' : 'default',
              }}
              onClick={() => onItemClick?.(item)}
            >
              <Stack gap="sm">
                <Row justify="between" align="start">
                  <Stack gap="xs" style={{ flex: 1 }}>
                    <Row align="center" gap="sm">
                      <Text variant="body" style={{ fontWeight: 600 }}>{item.title}</Text>
                      <Badge
                        size="sm"
                        style={{
                          backgroundColor: `${priorityColors[item.priority]}20`,
                          color: priorityColors[item.priority],
                        }}
                      >
                        {item.priority}
                      </Badge>
                    </Row>
                    <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
                      {item.description}
                    </Text>
                    <Row align="center" gap="sm">
                      <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)' }}>
                        by {item.requester}
                      </Text>
                      <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)' }}>
                        {item.createdAt}
                      </Text>
                    </Row>
                  </Stack>
                  {item.status === 'pending' && (
                    <Row gap="sm" style={{ marginLeft: 16, flexShrink: 0 }}>
                      <Button
                        variant="outline"
                        size="sm"
                        onPress={(e) => { e?.stopPropagation?.(); handleReject(item.id); }}
                        style={{ color: 'var(--ggui-color-error-500, #ef4444)' }}
                      >
                        Reject
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onPress={(e) => { e?.stopPropagation?.(); handleApprove(item.id); }}
                      >
                        Approve
                      </Button>
                    </Row>
                  )}
                  {item.status !== 'pending' && (
                    <Badge
                      size="sm"
                      variant={item.status === 'approved' ? 'success' : 'default'}
                      style={{ marginLeft: 16, flexShrink: 0 }}
                    >
                      {item.status}
                    </Badge>
                  )}
                </Row>
              </Stack>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
