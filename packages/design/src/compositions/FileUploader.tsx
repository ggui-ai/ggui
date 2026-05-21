import { useRef, useState } from 'react';
import type { FileUploaderProps } from './types';
import { Button } from '../primitives/Button';
import { Progress } from '../primitives/Progress';
import { Icon } from '../primitives/Icon';
import { colors } from '../tokens/colors';
import { radius } from '../tokens/spacing';
import { fontSize } from '../tokens/typography';

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * FileUploader - A drag-and-drop file upload component
 */
export function FileUploader({
  files = [],
  onFilesSelected,
  onFileRemove,
  accept,
  multiple = true,
  maxSize,
  maxFiles,
  disabled,
  dragDrop = true,
  style,
  className,
}: FileUploaderProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList) return;

    let selectedFiles = Array.from(fileList);

    // Apply max files limit
    if (maxFiles) {
      selectedFiles = selectedFiles.slice(0, maxFiles - files.length);
    }

    // Apply max size filter
    if (maxSize) {
      selectedFiles = selectedFiles.filter((f) => f.size <= maxSize);
    }

    onFilesSelected?.(selectedFiles);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!disabled && dragDrop) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled && dragDrop) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  return (
    <div className={className} style={{ ...style }}>
      <div
        onClick={() => !disabled && inputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        style={{
          border: `2px dashed ${isDragOver ? colors.primary[400] : colors.gray[300]}`,
          borderRadius: radius.lg,
          padding: '32px',
          textAlign: 'center',
          backgroundColor: isDragOver ? colors.primary[50] : colors.gray[50],
          cursor: disabled ? 'not-allowed' : 'pointer',
          transition: 'all 0.2s',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={(e) => handleFiles(e.target.files)}
          disabled={disabled}
          style={{ display: 'none' }}
        />
        <Icon name="plus" size={32} tone="subtle" />
        <p style={{ margin: '12px 0 4px', color: colors.gray[700], fontSize: fontSize.sm }}>
          {dragDrop ? 'Drag and drop files here, or click to browse' : 'Click to browse files'}
        </p>
        <p style={{ margin: 0, color: colors.gray[500], fontSize: fontSize.xs }}>
          {accept && `Accepted: ${accept}`}
          {maxSize && ` • Max size: ${formatFileSize(maxSize)}`}
          {maxFiles && ` • Max files: ${maxFiles}`}
        </p>
      </div>

      {files.length > 0 && (
        <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {files.map((file) => (
            <div
              key={file.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px',
                border: `1px solid ${colors.gray[200]}`,
                borderRadius: radius.md,
                backgroundColor: colors.white,
              }}
            >
              <Icon name="menu" size={20} tone="subtle" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: fontSize.sm,
                    color: colors.gray[900],
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {file.name}
                </p>
                <p style={{ margin: '2px 0 0', fontSize: fontSize.xs, color: colors.gray[500] }}>
                  {formatFileSize(file.size)}
                  {file.error && (
                    <span style={{ color: colors.error[500], marginLeft: '8px' }}>
                      {file.error}
                    </span>
                  )}
                </p>
                {file.status === 'uploading' && file.progress !== undefined && (
                  <Progress value={file.progress} size="sm" style={{ marginTop: '8px' }} />
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onFileRemove?.(file.id)}
              >
                <Icon name="x" size={16} />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
