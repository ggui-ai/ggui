import { useState } from 'react';
import { Container, Card, Stack, Row, Text, Button, Input, Avatar, Badge } from '@ggui-ai/design/primitives';

interface KanbanCard {
  id: string;
  title: string;
  description: string;
  assignee?: string;
  column: string;
  priority?: 'low' | 'medium' | 'high';
}

interface Column {
  id: string;
  title: string;
}

const defaultColumns: Column[] = [
  { id: 'todo', title: 'To Do' },
  { id: 'in-progress', title: 'In Progress' },
  { id: 'done', title: 'Done' },
];

const defaultCards: KanbanCard[] = [
  { id: '1', title: 'Design landing page', description: 'Create mockups for the new marketing landing page', assignee: 'Alice Chen', column: 'todo', priority: 'high' },
  { id: '2', title: 'Set up CI/CD pipeline', description: 'Configure GitHub Actions for automated testing and deployment', assignee: 'Bob Smith', column: 'todo', priority: 'medium' },
  { id: '3', title: 'API rate limiting', description: 'Implement rate limiting middleware for public endpoints', assignee: 'Carol Davis', column: 'in-progress', priority: 'high' },
  { id: '4', title: 'User onboarding flow', description: 'Build step-by-step onboarding for new users', assignee: 'Alice Chen', column: 'in-progress', priority: 'medium' },
  { id: '5', title: 'Database indexing', description: 'Add indexes to frequently queried columns', assignee: 'Bob Smith', column: 'done', priority: 'low' },
  { id: '6', title: 'Fix auth token refresh', description: 'Resolve token expiration edge case in OAuth flow', assignee: 'Carol Davis', column: 'done', priority: 'high' },
];

const priorityColors: Record<string, string> = {
  high: 'var(--ggui-color-error-500, #ef4444)',
  medium: 'var(--ggui-color-warning-500, #f59e0b)',
  low: 'var(--ggui-color-success-500, #22c55e)',
};

interface KanbanBoardBlueprintProps {
  title?: string;
  initialCards?: KanbanCard[];
  columns?: Column[];
  onAddCard?: (card: KanbanCard) => void;
  onMoveCard?: (cardId: string, toColumn: string) => void;
  onDeleteCard?: (cardId: string) => void;
}

export default function KanbanBoardBlueprint({
  title = 'Project Board',
  initialCards,
  columns = defaultColumns,
  onAddCard,
  onMoveCard,
  onDeleteCard,
}: KanbanBoardBlueprintProps) {
  const [cards, setCards] = useState<KanbanCard[]>(initialCards ?? defaultCards);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [newCardTitle, setNewCardTitle] = useState('');

  const getColumnCards = (columnId: string) =>
    cards.filter((c) => c.column === columnId);

  const handleAddCard = (columnId: string) => {
    const trimmed = newCardTitle.trim();
    if (!trimmed) return;

    const card: KanbanCard = {
      id: Date.now().toString(),
      title: trimmed,
      description: '',
      column: columnId,
      priority: 'medium',
    };

    setCards((prev) => [...prev, card]);
    setNewCardTitle('');
    setAddingTo(null);
    onAddCard?.(card);
  };

  const handleMove = (cardId: string, direction: 'left' | 'right') => {
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;

    const currentIdx = columns.findIndex((col) => col.id === card.column);
    const newIdx = direction === 'right' ? currentIdx + 1 : currentIdx - 1;
    if (newIdx < 0 || newIdx >= columns.length) return;

    const newColumn = columns[newIdx].id;
    setCards((prev) =>
      prev.map((c) => (c.id === cardId ? { ...c, column: newColumn } : c))
    );
    onMoveCard?.(cardId, newColumn);
  };

  const handleDelete = (cardId: string) => {
    setCards((prev) => prev.filter((c) => c.id !== cardId));
    onDeleteCard?.(cardId);
  };

  const handleKeyDown = (e: React.KeyboardEvent, columnId: string) => {
    if (e.key === 'Enter') handleAddCard(columnId);
    if (e.key === 'Escape') {
      setAddingTo(null);
      setNewCardTitle('');
    }
  };

  const columnColors: Record<string, string> = {
    'todo': 'var(--ggui-color-primary-600, #0284c7)',
    'in-progress': 'var(--ggui-color-warning-500, #f59e0b)',
    'done': 'var(--ggui-color-success-500, #22c55e)',
  };

  return (
    <Container
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--ggui-color-neutral-50, #fafafa)',
        padding: 24,
      }}
    >
      <Stack gap="lg">
        {/* Board Header */}
        <Row justify="between" align="center">
          <Text
            variant="h1"
            style={{
              fontWeight: 700,
              color: 'var(--ggui-color-neutral-900, #171717)',
              margin: 0,
            }}
          >
            {title}
          </Text>
          <Badge variant="info" size="sm">
            {cards.length} tasks
          </Badge>
        </Row>

        {/* Columns */}
        <div
          style={{
            display: 'flex',
            gap: 20,
            alignItems: 'flex-start',
            overflowX: 'auto',
            paddingBottom: 16,
          }}
        >
          {columns.map((column) => {
            const columnCards = getColumnCards(column.id);
            const accentColor = columnColors[column.id] ?? 'var(--ggui-color-neutral-500, #737373)';

            return (
              <div
                key={column.id}
                style={{
                  flex: 1,
                  minWidth: 280,
                  maxWidth: 360,
                  backgroundColor: '#ffffff',
                  borderRadius: 12,
                  border: '1px solid var(--ggui-color-neutral-200, #e5e5e5)',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {/* Column Header */}
                <div style={{ padding: '16px 16px 12px' }}>
                  <Row align="center" gap="sm">
                    <div
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: '50%',
                        backgroundColor: accentColor,
                        flexShrink: 0,
                      }}
                    />
                    <Text
                      variant="h3"
                      style={{
                        fontWeight: 600,
                        color: 'var(--ggui-color-neutral-800, #262626)',
                        margin: 0,
                        flex: 1,
                      }}
                    >
                      {column.title}
                    </Text>
                    <Badge variant="default" size="sm">
                      {columnCards.length}
                    </Badge>
                  </Row>
                </div>

                {/* Cards */}
                <div
                  style={{
                    padding: '0 12px 12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    minHeight: 100,
                  }}
                >
                  {columnCards.map((card) => {
                    const colIdx = columns.findIndex((c) => c.id === card.column);
                    const canMoveLeft = colIdx > 0;
                    const canMoveRight = colIdx < columns.length - 1;

                    return (
                      <Card
                        key={card.id}
                        padding="none"
                        style={{
                          borderRadius: 8,
                          border: '1px solid var(--ggui-color-neutral-200, #e5e5e5)',
                          overflow: 'hidden',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                        }}
                      >
                        {/* Priority bar */}
                        {card.priority && (
                          <div
                            style={{
                              height: 3,
                              backgroundColor: priorityColors[card.priority] ?? '#ccc',
                            }}
                          />
                        )}

                        <Stack gap="sm" style={{ padding: 12 }}>
                          <Row justify="between" align="start">
                            <Text
                              variant="body"
                              style={{
                                fontWeight: 600,
                                color: 'var(--ggui-color-neutral-800, #262626)',
                                flex: 1,
                              }}
                            >
                              {card.title}
                            </Text>
                            <Button
                              variant="ghost"
                              size="sm"
                              onPress={() => handleDelete(card.id)}
                              aria-label={`Delete ${card.title}`}
                            >
                              <span style={{ fontSize: 12, color: 'var(--ggui-color-neutral-400, #a3a3a3)' }}>{'\u2715'}</span>
                            </Button>
                          </Row>

                          {card.description && (
                            <Text
                              variant="small"
                              style={{
                                color: 'var(--ggui-color-neutral-500, #737373)',
                                lineHeight: 1.5,
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                              }}
                            >
                              {card.description}
                            </Text>
                          )}

                          <Row justify="between" align="center">
                            {card.assignee ? (
                              <Row align="center" gap="xs">
                                <Avatar name={card.assignee} size="sm" />
                                <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
                                  {card.assignee.split(' ')[0]}
                                </Text>
                              </Row>
                            ) : (
                              <div />
                            )}

                            <Row gap="xs">
                              {canMoveLeft && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onPress={() => handleMove(card.id, 'left')}
                                  aria-label="Move left"
                                >
                                  <span style={{ fontSize: 14 }}>{'\u2190'}</span>
                                </Button>
                              )}
                              {canMoveRight && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onPress={() => handleMove(card.id, 'right')}
                                  aria-label="Move right"
                                >
                                  <span style={{ fontSize: 14 }}>{'\u2192'}</span>
                                </Button>
                              )}
                            </Row>
                          </Row>
                        </Stack>
                      </Card>
                    );
                  })}

                  {/* Add Card */}
                  {addingTo === column.id ? (
                    <div style={{ padding: 4 }} onKeyDown={(e) => handleKeyDown(e, column.id)}>
                      <Stack gap="sm">
                        <Input
                          placeholder="Card title..."
                          value={newCardTitle}
                          onChange={setNewCardTitle}
                          aria-label="New card title"
                        />
                        <Row gap="xs">
                          <Button variant="primary" size="sm" onPress={() => handleAddCard(column.id)}>
                            Add
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onPress={() => {
                              setAddingTo(null);
                              setNewCardTitle('');
                            }}
                          >
                            Cancel
                          </Button>
                        </Row>
                      </Stack>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onPress={() => setAddingTo(column.id)}
                      style={{
                        width: '100%',
                        justifyContent: 'center',
                        color: 'var(--ggui-color-neutral-500, #737373)',
                      }}
                    >
                      + Add card
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Stack>
    </Container>
  );
}
