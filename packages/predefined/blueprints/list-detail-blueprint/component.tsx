import { useState, type ReactNode } from 'react';
import {
  Container,
  Card,
  Row,
  Stack,
  Text,
  Input,
  Button,
} from '@ggui-ai/design/primitives';

interface ListItem {
  id: string;
  title: string;
  subtitle?: string;
  preview?: string;
  timestamp?: string;
  unread?: boolean;
}

interface ListDetailBlueprintProps {
  items: ListItem[];
  selectedId?: string;
  listWidth?: number;
  searchable?: boolean;
  emptyMessage?: string;
  onSelect?: (item: ListItem) => void;
  onSearch?: (query: string) => void;
  onItemAction?: (action: string, item: ListItem) => void;
  // Slot content
  listItem?: (item: ListItem, isSelected: boolean) => ReactNode;
  detailView?: (item: ListItem) => ReactNode;
  emptyState?: () => ReactNode;
  listHeader?: () => ReactNode;
  children?: ReactNode;
}

export default function ListDetailBlueprint({
  items,
  selectedId: controlledSelectedId,
  listWidth = 320,
  searchable = true,
  emptyMessage = 'Select an item to view details',
  onSelect,
  onSearch,
  _onItemAction,
  listItem: renderListItem,
  detailView: renderDetailView,
  emptyState: renderEmptyState,
  listHeader,
  children,
}: ListDetailBlueprintProps) {
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

  const selectedId = controlledSelectedId ?? internalSelectedId;
  const selectedItem = items.find((item) => item.id === selectedId);

  const filteredItems = searchQuery
    ? items.filter(
        (item) =>
          item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          item.subtitle?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          item.preview?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : items;

  const handleSelect = (item: ListItem) => {
    setInternalSelectedId(item.id);
    setMobileShowDetail(true);
    onSelect?.(item);
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    onSearch?.(query);
  };

  const handleBack = () => {
    setMobileShowDetail(false);
  };

  const defaultListItem = (item: ListItem, isSelected: boolean) => (
    <div
      style={{
        padding: '12px 16px',
        backgroundColor: isSelected ? 'var(--ggui-color-primary-50, #f0f9ff)' : 'transparent',
        borderLeft: isSelected ? '3px solid var(--ggui-color-primary-600, #0284c7)' : '3px solid transparent',
        cursor: 'pointer',
      }}
    >
      <Row justify="between" align="start">
        <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
          <Row gap="sm" align="center">
            {item.unread && (
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: 'var(--ggui-color-primary-600, #0284c7)',
                  flexShrink: 0,
                }}
              />
            )}
            <Text
              variant="body"
              style={{
                fontWeight: item.unread ? 600 : 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.title}
            </Text>
          </Row>
          {item.subtitle && (
            <Text
              variant="small"
              style={{
                color: 'var(--ggui-color-neutral-500, #6b7280)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.subtitle}
            </Text>
          )}
          {item.preview && (
            <Text
              variant="small"
              style={{
                color: 'var(--ggui-color-neutral-400, #9ca3af)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.preview}
            </Text>
          )}
        </Stack>
        {item.timestamp && (
          <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #9ca3af)', flexShrink: 0, marginLeft: 8 }}>
            {item.timestamp}
          </Text>
        )}
      </Row>
    </div>
  );

  const defaultDetailView = (item: ListItem) => (
    <Stack gap="lg" style={{ padding: 24 }}>
      <div>
        <Text variant="h2">{item.title}</Text>
        {item.subtitle && (
          <Text variant="body" style={{ color: 'var(--ggui-color-neutral-500, #6b7280)', marginTop: 4 }}>
            {item.subtitle}
          </Text>
        )}
        {item.timestamp && (
          <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #9ca3af)', marginTop: 8 }}>
            {item.timestamp}
          </Text>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--ggui-color-neutral-200, #e5e7eb)', paddingTop: 16 }}>
        <Text variant="body">{item.preview || 'No content available.'}</Text>
      </div>
    </Stack>
  );

  const defaultEmptyState = () => (
    <Stack
      gap="md"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--ggui-color-neutral-400, #9ca3af)',
      }}
    >
      <div style={{ fontSize: 48 }}>📄</div>
      <Text variant="body" style={{ color: 'var(--ggui-color-neutral-500, #6b7280)' }}>
        {emptyMessage}
      </Text>
    </Stack>
  );

  return (
    <Container
      style={{
        display: 'flex',
        height: '100vh',
        backgroundColor: 'var(--ggui-color-neutral-50, #f9fafb)',
      }}
    >
      {/* List Panel */}
      <div
        style={{
          width: listWidth,
          minWidth: listWidth,
          backgroundColor: 'var(--ggui-color-neutral-50, #ffffff)',
          borderRight: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
          display: 'flex',
          flexDirection: 'column',
          // Mobile: hide when showing detail
          ...(mobileShowDetail && {
            display: 'none',
          }),
        }}
      >
        {/* List Header */}
        {listHeader ? (
          listHeader()
        ) : (
          <div style={{ padding: 16, borderBottom: '1px solid var(--ggui-color-neutral-200, #e5e7eb)' }}>
            <Text variant="h3">Items</Text>
          </div>
        )}

        {/* Search */}
        {searchable && (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--ggui-color-neutral-200, #e5e7eb)' }}>
            <Input
              type="search"
              placeholder="Search..."
              value={searchQuery}
              onChange={handleSearch}
              aria-label="Search items"
            />
          </div>
        )}

        {/* List Items */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filteredItems.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center' }}>
              <Text variant="body" style={{ color: 'var(--ggui-color-neutral-400, #9ca3af)' }}>
                No items found
              </Text>
            </div>
          ) : (
            filteredItems.map((item) => (
              <div
                key={item.id}
                onClick={() => handleSelect(item)}
                onKeyDown={(e) => e.key === 'Enter' && handleSelect(item)}
                role="button"
                tabIndex={0}
                aria-selected={item.id === selectedId}
              >
                {renderListItem
                  ? renderListItem(item, item.id === selectedId)
                  : defaultListItem(item, item.id === selectedId)}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Detail Panel */}
      <div
        style={{
          flex: 1,
          backgroundColor: 'var(--ggui-color-neutral-50, #ffffff)',
          display: 'flex',
          flexDirection: 'column',
          // Mobile: show full width when selected
          ...(mobileShowDetail && {
            width: '100%',
          }),
        }}
      >
        {/* Mobile Back Button */}
        {mobileShowDetail && selectedItem && (
          <div style={{ padding: 12, borderBottom: '1px solid var(--ggui-color-neutral-200, #e5e7eb)' }}>
            <Button variant="ghost" onPress={handleBack}>
              ← Back
            </Button>
          </div>
        )}

        {/* Detail Content */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {selectedItem ? (
            renderDetailView ? (
              renderDetailView(selectedItem)
            ) : children ? (
              children
            ) : (
              defaultDetailView(selectedItem)
            )
          ) : renderEmptyState ? (
            renderEmptyState()
          ) : (
            defaultEmptyState()
          )}
        </div>
      </div>
    </Container>
  );
}
