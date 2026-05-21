/**
 * `useClipboardPaste` — browser-capability hook for reading text from
 * the system clipboard via `navigator.clipboard.readText`. Satisfies
 * `GadgetHook<string, void>`.
 *
 * Most browsers require an explicit user gesture (button click) to
 * invoke `start()` — wire this hook to a "paste" button rather than
 * firing on mount.
 *
 * Lifecycle: idle → prompting → completed (with the text in `value`)
 * on success; denied/error on failure.
 */

import { useCallback, useState } from 'react';
import type {
  GadgetError,
  GadgetStatus,
  GadgetHook,
} from '@ggui-ai/protocol';

function mapReadError(err: unknown): GadgetError {
  if (err instanceof Error) {
    if (err.name === 'NotAllowedError') {
      return { code: 'permission_denied', message: err.message };
    }
    return { code: 'unknown', message: err.message };
  }
  return { code: 'unknown', message: String(err) };
}

export const useClipboardPaste: GadgetHook<string> = () => {
  const [value, setValue] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<GadgetStatus>('idle');
  const [error, setError] = useState<GadgetError | undefined>(undefined);

  const start = useCallback(async (): Promise<string | undefined> => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard ||
      typeof navigator.clipboard.readText !== 'function'
    ) {
      const e: GadgetError = {
        code: 'not_supported',
        message: 'Clipboard read API unavailable in this environment.',
      };
      setError(e);
      setStatus('error');
      return undefined;
    }

    setStatus('prompting');
    setError(undefined);

    try {
      const text = await navigator.clipboard.readText();
      setValue(text);
      setStatus('completed');
      return text;
    } catch (err) {
      const mapped = mapReadError(err);
      setError(mapped);
      setStatus(mapped.code === 'permission_denied' ? 'denied' : 'error');
      return undefined;
    }
  }, []);

  return {
    value,
    status,
    ...(error !== undefined ? { error } : {}),
    start,
  };
};
