import { useState, useRef } from 'react';
import { Card, Stack, Row, Text, Button, Progress } from '@ggui-ai/design/primitives';

interface UploadFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
}

interface FileUploadCompositeProps {
  accept?: string;
  maxFiles?: number;
  maxSizeMB?: number;
  onUpload?: (files: UploadFile[]) => void;
  onRemove?: (fileId: string) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) return '\ud83d\uddbc\ufe0f';
  if (['pdf'].includes(ext)) return '\ud83d\udcc4';
  if (['doc', 'docx', 'txt', 'md'].includes(ext)) return '\ud83d\udcdd';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '\ud83d\udce6';
  if (['mp4', 'mov', 'avi', 'webm'].includes(ext)) return '\ud83c\udfac';
  return '\ud83d\udcc1';
}

const sampleFiles: UploadFile[] = [
  { id: '1', name: 'design-mockup.png', size: 2457600, progress: 100, status: 'complete' },
  { id: '2', name: 'api-spec.pdf', size: 1843200, progress: 65, status: 'uploading' },
  { id: '3', name: 'meeting-notes.docx', size: 524288, progress: 0, status: 'pending' },
];

export default function FileUploadComposite({
  accept,
  maxFiles = 5,
  maxSizeMB = 10,
  onUpload,
  onRemove,
}: FileUploadCompositeProps) {
  const [files, setFiles] = useState<UploadFile[]>(sampleFiles);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canAddMore = files.length < maxFiles;

  const addFiles = (newFiles: FileList | null) => {
    if (!newFiles) return;
    const available = maxFiles - files.length;
    const toAdd = Array.from(newFiles).slice(0, available);

    const uploadFiles: UploadFile[] = toAdd.map((f) => ({
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      name: f.name,
      size: f.size,
      progress: 0,
      status: 'pending' as const,
    }));

    setFiles((prev) => [...prev, ...uploadFiles]);
  };

  const handleRemove = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    onRemove?.(id);
  };

  const simulateUpload = () => {
    setFiles((prev) =>
      prev.map((f) =>
        f.status === 'pending' || f.status === 'uploading'
          ? { ...f, status: 'uploading' as const }
          : f
      )
    );

    // Simulate progress
    const interval = setInterval(() => {
      setFiles((prev) => {
        const updated = prev.map((f) => {
          if (f.status !== 'uploading') return f;
          const newProgress = Math.min(f.progress + Math.random() * 30 + 10, 100);
          return {
            ...f,
            progress: newProgress,
            status: newProgress >= 100 ? ('complete' as const) : ('uploading' as const),
          };
        });

        if (updated.every((f) => f.status !== 'uploading')) {
          clearInterval(interval);
          onUpload?.(updated);
        }

        return updated;
      });
    }, 500);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (canAddMore) setIsDragOver(true);
  };

  const handleDragLeave = () => setIsDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (canAddMore) addFiles(e.dataTransfer.files);
  };

  const statusColor = (status: UploadFile['status']) => {
    if (status === 'complete') return 'var(--ggui-color-success-500, #22c55e)';
    if (status === 'error') return 'var(--ggui-color-error-500, #ef4444)';
    return 'var(--ggui-color-neutral-500, #737373)';
  };

  const pendingOrUploading = files.some((f) => f.status === 'pending' || f.status === 'uploading');

  return (
    <Card
      padding="lg"
      style={{
        maxWidth: 520,
        margin: '0 auto',
        border: '1px solid var(--ggui-color-neutral-200, #e5e5e5)',
        borderRadius: 12,
      }}
    >
      <Stack gap="lg">
        <Text variant="h3" style={{ margin: 0 }}>Upload Files</Text>

        {/* Drop Zone */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => canAddMore && fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && canAddMore && fileInputRef.current?.click()}
          aria-label="Drop files here or click to browse"
          style={{
            border: `2px dashed ${isDragOver ? 'var(--ggui-color-primary-600, #0284c7)' : 'var(--ggui-color-neutral-300, #d4d4d4)'}`,
            borderRadius: 12,
            padding: '32px 24px',
            textAlign: 'center',
            backgroundColor: isDragOver
              ? 'var(--ggui-color-primary-50, #f0f9ff)'
              : 'var(--ggui-color-neutral-50, #fafafa)',
            cursor: canAddMore ? 'pointer' : 'not-allowed',
            opacity: canAddMore ? 1 : 0.5,
            transition: 'all 0.15s ease',
          }}
        >
          <Stack gap="sm" style={{ alignItems: 'center' }}>
            <div style={{ fontSize: 36 }}>{'\u2601\ufe0f'}</div>
            <Text variant="body" style={{ fontWeight: 500, color: 'var(--ggui-color-neutral-700, #404040)' }}>
              {isDragOver ? 'Drop files here' : 'Drag & drop files here'}
            </Text>
            <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
              or click to browse {accept ? `(${accept})` : ''} {'\u00b7'} Max {maxSizeMB}MB per file
            </Text>
          </Stack>
          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            multiple
            onChange={(e) => addFiles(e.target.files)}
            style={{ display: 'none' }}
          />
        </div>

        {/* File List */}
        {files.length > 0 && (
          <Stack gap="sm">
            <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}>
              {files.length} file{files.length !== 1 ? 's' : ''} selected ({maxFiles - files.length} remaining)
            </Text>

            {files.map((file) => (
              <div
                key={file.id}
                style={{
                  padding: '12px 16px',
                  borderRadius: 8,
                  border: '1px solid var(--ggui-color-neutral-200, #e5e5e5)',
                  backgroundColor: '#ffffff',
                }}
              >
                <Row align="center" gap="sm">
                  <span style={{ fontSize: 24, flexShrink: 0 }}>{getFileIcon(file.name)}</span>
                  <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
                    <Row justify="between" align="center">
                      <Text
                        variant="body"
                        style={{
                          fontWeight: 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {file.name}
                      </Text>
                      <Text variant="small" style={{ color: statusColor(file.status), flexShrink: 0, marginLeft: 8 }}>
                        {file.status === 'complete' ? '\u2713 Done' : file.status === 'uploading' ? `${Math.round(file.progress)}%` : 'Pending'}
                      </Text>
                    </Row>
                    <Row align="center" gap="sm">
                      <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)' }}>
                        {formatFileSize(file.size)}
                      </Text>
                      {(file.status === 'uploading' || file.status === 'complete') && (
                        <div style={{ flex: 1 }}>
                          <Progress
                            value={file.progress}
                            max={100}
                            size="sm"
                            variant={file.status === 'complete' ? 'success' : 'default'}
                          />
                        </div>
                      )}
                    </Row>
                  </Stack>
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={() => handleRemove(file.id)}
                    aria-label={`Remove ${file.name}`}
                  >
                    <span style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)', fontSize: 16 }}>{'\u2715'}</span>
                  </Button>
                </Row>
              </div>
            ))}
          </Stack>
        )}

        {/* Upload Button */}
        {files.length > 0 && pendingOrUploading && (
          <Button variant="primary" onPress={simulateUpload} style={{ width: '100%' }}>
            Upload {files.filter((f) => f.status === 'pending' || f.status === 'uploading').length} file{files.filter((f) => f.status === 'pending' || f.status === 'uploading').length !== 1 ? 's' : ''}
          </Button>
        )}
      </Stack>
    </Card>
  );
}
