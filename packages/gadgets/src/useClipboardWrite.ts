/**
 * `useClipboardWrite` — browser-capability hook for writing text to
 * the system clipboard via `navigator.clipboard.writeText`. Satisfies
 * `GadgetHook<string, ClipboardWriteOptions>`.
 *
 * One-shot semantics: pass `{text}` at hook-call time and call
 * `start()` to write; status moves
 * `idle → prompting → completed` on success or `idle → prompting →
 * denied/error` on failure. The hook's `value` carries the most
 * recently written text so component code can confirm what landed
 * on the clipboard.
 *
 * `useClipboardPaste` is a separate hook — the read direction has
 * different permission semantics (requires explicit user-gesture
 * activation in most browsers).
 */

import { useCallback, useState } from 'react';
import type {
  GadgetError,
  GadgetStatus,
  GadgetHook,
} from '@ggui-ai/protocol';

export interface ClipboardWriteOptions {
  /** Text to write. Supplied at hook-call time; read when `start()`
   *  fires, so component code re-renders the hook call with the
   *  latest text rather than passing arguments to `start()`. */
  readonly text: string;
}

function mapWriteError(err: unknown): GadgetError {
  if (err instanceof Error) {
    if (err.name === 'NotAllowedError') {
      return { code: 'permission_denied', message: err.message };
    }
    return { code: 'unknown', message: err.message };
  }
  return { code: 'unknown', message: String(err) };
}

export const useClipboardWrite: GadgetHook<
  string,
  ClipboardWriteOptions
> = (options) => {
  const [value, setValue] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<GadgetStatus>('idle');
  const [error, setError] = useState<GadgetError | undefined>(undefined);

  const start = useCallback(async (): Promise<string | undefined> => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== 'function'
    ) {
      const e: GadgetError = {
        code: 'not_supported',
        message: 'Clipboard write API unavailable in this environment.',
      };
      setError(e);
      setStatus('error');
      return undefined;
    }

    const text = options?.text;
    if (typeof text !== 'string') {
      const e: GadgetError = {
        code: 'unknown',
        message:
          'useClipboardWrite: `text` option is required at start() time.',
      };
      setError(e);
      setStatus('error');
      return undefined;
    }

    setStatus('prompting');
    setError(undefined);

    try {
      await navigator.clipboard.writeText(text);
      setValue(text);
      setStatus('completed');
      return text;
    } catch (err) {
      const mapped = mapWriteError(err);
      setError(mapped);
      setStatus(mapped.code === 'permission_denied' ? 'denied' : 'error');
      return undefined;
    }
  }, [options?.text]);

  return {
    value,
    status,
    ...(error !== undefined ? { error } : {}),
    start,
  };
};
