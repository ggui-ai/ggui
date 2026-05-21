import { useState } from 'react';
import { Container, Card, Stack, Row, Text, Button, Input } from '@ggui-ai/design/primitives';

type FileType = 'file' | 'folder';

interface FileItem {
  name: string;
  type: FileType;
  size?: string;
  modifiedAt?: string;
  mimeType?: string;
}

const defaultFiles: FileItem[] = [
  { name: 'Documents', type: 'folder', modifiedAt: '2 hours ago' },
  { name: 'Images', type: 'folder', modifiedAt: 'Yesterday' },
  { name: 'Downloads', type: 'folder', modifiedAt: '3 days ago' },
  { name: 'report-2024.pdf', type: 'file', size: '2.4 MB', modifiedAt: '1 hour ago', mimeType: 'application/pdf' },
  { name: 'budget.xlsx', type: 'file', size: '156 KB', modifiedAt: '3 hours ago', mimeType: 'application/vnd.ms-excel' },
  { name: 'presentation.pptx', type: 'file', size: '8.1 MB', modifiedAt: 'Yesterday', mimeType: 'application/vnd.ms-powerpoint' },
  { name: 'notes.md', type: 'file', size: '4 KB', modifiedAt: '2 days ago', mimeType: 'text/markdown' },
  { name: 'photo.jpg', type: 'file', size: '3.2 MB', modifiedAt: '5 days ago', mimeType: 'image/jpeg' },
  { name: 'config.json', type: 'file', size: '1 KB', modifiedAt: '1 week ago', mimeType: 'application/json' },
];

const fileIcons: Record<string, string> = {
  folder: '\uD83D\uDCC1',
  'application/pdf': '\uD83D\uDCC4',
  'text/markdown': '\uD83D\uDCDD',
  'image/jpeg': '\uD83D\uDDBC',
  'image/png': '\uD83D\uDDBC',
  default: '\uD83D\uDCC4',
};

function getIcon(item: FileItem): string {
  if (item.type === 'folder') return fileIcons.folder;
  return fileIcons[item.mimeType || ''] || fileIcons.default;
}

interface FileBrowserProps {
  files?: FileItem[];
  currentPath?: string;
  title?: string;
  onFileClick?: (file: FileItem) => void;
  onFolderOpen?: (folder: FileItem) => void;
  onNavigate?: (path: string) => void;
  onDelete?: (file: FileItem) => void;
}

export default function FileBrowser({
  files = defaultFiles,
  currentPath = '/',
  title = 'Files',
  onFileClick,
  onFolderOpen,
  onNavigate,
  onDelete,
}: FileBrowserProps) {
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [search, setSearch] = useState('');

  const pathParts = currentPath.split('/').filter(Boolean);
  const breadcrumbs = [{ name: 'Home', path: '/' }, ...pathParts.map((part, i) => ({
    name: part,
    path: '/' + pathParts.slice(0, i + 1).join('/'),
  }))];

  // Sort: folders first, then files
  const sorted = [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const filtered = search
    ? sorted.filter((f) => f.name.toLowerCase().includes(search.toLowerCase()))
    : sorted;

  const handleClick = (item: FileItem) => {
    if (item.type === 'folder') {
      onFolderOpen?.(item);
    } else {
      onFileClick?.(item);
    }
  };

  return (
    <Container style={{ maxWidth: 720, margin: '0 auto' }}>
      <Stack gap="md">
        <Text variant="h2">{title}</Text>

        {/* Toolbar */}
        <Card padding="md">
          <Stack gap="sm">
            {/* Breadcrumbs */}
            <Row align="center" gap="xs" style={{ flexWrap: 'wrap' }}>
              {breadcrumbs.map((crumb, i) => (
                <Row key={crumb.path} align="center" gap="xs">
                  {i > 0 && (
                    <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)' }}>/</Text>
                  )}
                  <Text
                    variant="small"
                    style={{
                      color: i === breadcrumbs.length - 1
                        ? 'var(--ggui-color-neutral-800, #262626)'
                        : 'var(--ggui-color-primary-600, #0284c7)',
                      cursor: i < breadcrumbs.length - 1 ? 'pointer' : 'default',
                      fontWeight: i === breadcrumbs.length - 1 ? 600 : 400,
                    }}
                    onClick={() => i < breadcrumbs.length - 1 && onNavigate?.(crumb.path)}
                  >
                    {crumb.name}
                  </Text>
                </Row>
              ))}
            </Row>

            {/* Search + View toggle */}
            <Row gap="sm" align="center">
              <div style={{ flex: 1 }}>
                <Input
                  placeholder="Search files..."
                  value={search}
                  onChange={setSearch}
                  aria-label="Search files"
                />
              </div>
              <Button
                variant={view === 'list' ? 'primary' : 'outline'}
                size="sm"
                onPress={() => setView('list')}
                aria-label="List view"
              >
                {'\u2630'}
              </Button>
              <Button
                variant={view === 'grid' ? 'primary' : 'outline'}
                size="sm"
                onPress={() => setView('grid')}
                aria-label="Grid view"
              >
                {'\u25A6'}
              </Button>
            </Row>
          </Stack>
        </Card>

        {/* File List */}
        {filtered.length === 0 ? (
          <Card padding="lg">
            <Text variant="body" style={{ textAlign: 'center', color: 'var(--ggui-color-neutral-500, #737373)' }}>
              {search ? 'No files match your search' : 'This folder is empty'}
            </Text>
          </Card>
        ) : view === 'list' ? (
          <Card padding="none">
            {filtered.map((item, i) => (
              <div
                key={item.name}
                style={{
                  padding: '10px 20px',
                  borderBottom: i < filtered.length - 1
                    ? '1px solid var(--ggui-color-neutral-100, #f5f5f5)'
                    : 'none',
                  cursor: 'pointer',
                }}
                onClick={() => handleClick(item)}
              >
                <Row align="center" gap="md">
                  <span style={{ fontSize: 20, width: 28, textAlign: 'center' }}>{getIcon(item)}</span>
                  <Text variant="body" style={{ flex: 1, fontWeight: item.type === 'folder' ? 600 : 400 }}>
                    {item.name}
                  </Text>
                  {item.size && (
                    <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)', width: 80, textAlign: 'right' }}>
                      {item.size}
                    </Text>
                  )}
                  <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)', width: 100, textAlign: 'right' }}>
                    {item.modifiedAt}
                  </Text>
                  {onDelete && item.type === 'file' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onPress={(e) => { e?.stopPropagation?.(); onDelete(item); }}
                      aria-label={`Delete ${item.name}`}
                    >
                      <span style={{ color: 'var(--ggui-color-error-500, #ef4444)' }}>{'\u2715'}</span>
                    </Button>
                  )}
                </Row>
              </div>
            ))}
          </Card>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
            {filtered.map((item) => (
              <Card
                key={item.name}
                padding="md"
                style={{ cursor: 'pointer', textAlign: 'center' }}
                onClick={() => handleClick(item)}
              >
                <Stack gap="sm" align="center">
                  <span style={{ fontSize: 36 }}>{getIcon(item)}</span>
                  <Text variant="small" style={{ fontWeight: item.type === 'folder' ? 600 : 400, wordBreak: 'break-all' }}>
                    {item.name}
                  </Text>
                  {item.size && (
                    <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)' }}>
                      {item.size}
                    </Text>
                  )}
                </Stack>
              </Card>
            ))}
          </div>
        )}

        {/* Footer */}
        <Row justify="between" align="center">
          <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
            {filtered.length} item{filtered.length !== 1 ? 's' : ''}
          </Text>
        </Row>
      </Stack>
    </Container>
  );
}
