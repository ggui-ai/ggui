import { useState } from 'react';
import { Card, Stack, Row, Text, Input, Button, Checkbox, Tabs, Badge } from '@ggui-ai/design/primitives';

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

const defaultItems: TodoItem[] = [
  { id: '1', text: 'Review project requirements', completed: true },
  { id: '2', text: 'Design database schema', completed: true },
  { id: '3', text: 'Implement authentication flow', completed: false },
  { id: '4', text: 'Write unit tests for API', completed: false },
  { id: '5', text: 'Deploy to staging environment', completed: false },
  { id: '6', text: 'Update documentation', completed: false },
];

type FilterType = 'all' | 'active' | 'completed';

interface TodoListBlueprintProps {
  title?: string;
  initialItems?: TodoItem[];
  placeholder?: string;
  onAdd?: (item: TodoItem) => void;
  onToggle?: (id: string, completed: boolean) => void;
  onDelete?: (id: string) => void;
  onClearCompleted?: () => void;
}

export default function TodoListBlueprint({
  title = 'My Tasks',
  initialItems,
  placeholder = 'Add a new task...',
  onAdd,
  onToggle,
  onDelete,
  onClearCompleted,
}: TodoListBlueprintProps) {
  const [items, setItems] = useState<TodoItem[]>(initialItems ?? defaultItems);
  const [newTask, setNewTask] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');

  const activeCount = items.filter((i) => !i.completed).length;
  const completedCount = items.filter((i) => i.completed).length;

  const filteredItems = items.filter((item) => {
    if (filter === 'active') return !item.completed;
    if (filter === 'completed') return item.completed;
    return true;
  });

  const handleAdd = () => {
    const text = newTask.trim();
    if (!text) return;
    const item: TodoItem = {
      id: Date.now().toString(),
      text,
      completed: false,
    };
    setItems((prev) => [item, ...prev]);
    setNewTask('');
    onAdd?.(item);
  };

  const handleToggle = (id: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, completed: !item.completed } : item
      )
    );
    const item = items.find((i) => i.id === id);
    if (item) onToggle?.(id, !item.completed);
  };

  const handleDelete = (id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    onDelete?.(id);
  };

  const handleClearCompleted = () => {
    setItems((prev) => prev.filter((item) => !item.completed));
    onClearCompleted?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleAdd();
  };

  return (
    <Card
      padding="none"
      style={{
        maxWidth: 560,
        margin: '0 auto',
        border: '1px solid var(--ggui-color-neutral-200, #e5e5e5)',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '20px 24px',
          backgroundColor: 'var(--ggui-color-primary-600, #0284c7)',
          color: '#ffffff',
        }}
      >
        <Row justify="between" align="center">
          <Text variant="h2" style={{ color: '#ffffff', margin: 0 }}>
            {title}
          </Text>
          <Badge variant="default" size="sm">
            {activeCount} remaining
          </Badge>
        </Row>
      </div>

      {/* Add Task Input */}
      <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--ggui-color-neutral-200, #e5e5e5)' }}>
        <Row gap="sm">
          <div style={{ flex: 1 }} onKeyDown={handleKeyDown}>
            <Input
              placeholder={placeholder}
              value={newTask}
              onChange={setNewTask}
              aria-label="New task"
            />
          </div>
          <Button variant="primary" onPress={handleAdd}>
            Add
          </Button>
        </Row>
      </div>

      {/* Filter Tabs */}
      <div style={{ padding: '0 24px' }}>
        <Tabs
          items={[
            {
              key: 'all',
              label: `All (${items.length})`,
              content: null,
            },
            {
              key: 'active',
              label: `Active (${activeCount})`,
              content: null,
            },
            {
              key: 'completed',
              label: `Completed (${completedCount})`,
              content: null,
            },
          ]}
          activeKey={filter}
          onChange={(key) => setFilter(key as FilterType)}
          variant="line"
          size="sm"
          fullWidth
        />
      </div>

      {/* Task List */}
      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
        {filteredItems.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center' }}>
            <Text variant="body" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
              {filter === 'completed'
                ? 'No completed tasks yet'
                : filter === 'active'
                  ? 'All tasks completed!'
                  : 'No tasks yet. Add one above!'}
            </Text>
          </div>
        ) : (
          filteredItems.map((item) => (
            <div
              key={item.id}
              style={{
                padding: '12px 24px',
                borderBottom: '1px solid var(--ggui-color-neutral-100, #f5f5f5)',
                backgroundColor: item.completed
                  ? 'var(--ggui-color-neutral-50, #fafafa)'
                  : 'transparent',
              }}
            >
              <Row align="center" gap="sm">
                <Checkbox
                  checked={item.completed}
                  onChange={() => handleToggle(item.id)}
                  label=""
                />
                <Text
                  variant="body"
                  style={{
                    flex: 1,
                    textDecoration: item.completed ? 'line-through' : 'none',
                    color: item.completed
                      ? 'var(--ggui-color-neutral-400, #a3a3a3)'
                      : 'var(--ggui-color-neutral-800, #262626)',
                  }}
                >
                  {item.text}
                </Text>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => handleDelete(item.id)}
                  aria-label={`Delete ${item.text}`}
                >
                  <span style={{ color: 'var(--ggui-color-error-500, #ef4444)', fontSize: 16 }}>
                    {'\u2715'}
                  </span>
                </Button>
              </Row>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      {completedCount > 0 && (
        <div
          style={{
            padding: '12px 24px',
            borderTop: '1px solid var(--ggui-color-neutral-200, #e5e5e5)',
            backgroundColor: 'var(--ggui-color-neutral-50, #fafafa)',
          }}
        >
          <Row justify="between" align="center">
            <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
              {completedCount} completed task{completedCount !== 1 ? 's' : ''}
            </Text>
            <Button variant="ghost" size="sm" onPress={handleClearCompleted}>
              Clear completed
            </Button>
          </Row>
        </div>
      )}
    </Card>
  );
}
