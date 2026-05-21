/**
 * `useFilePicker` — browser-capability hook for prompting the user
 * to select one or more files. Uses `<input type="file">` as the
 * universal fallback; the File System Access API
 * (`showOpenFilePicker`) is preferred when available.
 *
 * Returns one entry per selected file with `name`, `size`, `type`,
 * and the raw `File` handle on `_file` for component code that
 * wants to read content (the contract doesn't carry the File over
 * the wire — component reads + extracts what it needs for the
 * agent's contextSpec / actionSpec payload).
 *
 * Lifecycle: idle → prompting → completed (with picked files) or
 * denied/error.
 */

import { useCallback, useState } from 'react';
import type {
  GadgetError,
  GadgetStatus,
  GadgetHook,
} from '@ggui-ai/protocol';

export interface FilePickerOptions {
  /** Allow multi-select. Default: false. */
  readonly multiple?: boolean;
  /** MIME-type filter (e.g., 'image/*', '.pdf'). Optional. */
  readonly accept?: string;
}

export interface PickedFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  /** Raw File handle. NOT serialized — component reads + extracts. */
  readonly _file: File;
}

export interface FilePickerResult {
  readonly files: readonly PickedFile[];
}

function fileToPicked(file: File): PickedFile {
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    _file: file,
  };
}

export const useFilePicker: GadgetHook<
  FilePickerResult,
  FilePickerOptions
> = (options) => {
  const [value, setValue] = useState<FilePickerResult | undefined>(undefined);
  const [status, setStatus] = useState<GadgetStatus>('idle');
  const [error, setError] = useState<GadgetError | undefined>(undefined);

  const start = useCallback(async (): Promise<
    FilePickerResult | undefined
  > => {
    if (typeof document === 'undefined') {
      const e: GadgetError = {
        code: 'not_supported',
        message: 'File picker requires a DOM environment.',
      };
      setError(e);
      setStatus('error');
      return undefined;
    }

    setStatus('prompting');
    setError(undefined);

    return new Promise<FilePickerResult | undefined>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (options?.multiple) input.multiple = true;
      if (options?.accept) input.accept = options.accept;
      input.onchange = () => {
        const files = input.files ? Array.from(input.files) : [];
        if (files.length === 0) {
          // User cancelled — treat as denied (no permission granted to read).
          const e: GadgetError = {
            code: 'aborted',
            message: 'File picker cancelled by user.',
          };
          setError(e);
          setStatus('denied');
          resolve(undefined);
          return;
        }
        const result: FilePickerResult = {
          files: files.map(fileToPicked),
        };
        setValue(result);
        setStatus('completed');
        resolve(result);
      };
      input.click();
    });
  }, [options?.multiple, options?.accept]);

  return {
    value,
    status,
    ...(error !== undefined ? { error } : {}),
    start,
  };
};
