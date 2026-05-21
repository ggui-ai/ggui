/**
 * Hook that listens for ggui:agent-stream events and accumulates text chunks
 * into a message list. Works with any shell's message/line state format.
 *
 * While streaming, inserts a message with id 'stream-active' that updates
 * in place. On done, finalizes it with a permanent id.
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

/**
 * Options for the {@link useAgentStream} hook.
 *
 * @typeParam T - The message/line item type used by the consuming shell
 */
export interface UseAgentStreamOptions<T> {
  /** Set state updater for the shell's message/line array. */
  setItems: React.Dispatch<React.SetStateAction<T[]>>;
  /** Build a new streaming item from the current accumulated text. */
  createItem: (text: string) => T;
  /** Called when streaming finishes. */
  onDone?: () => void;
  /** Max items to keep (optional, for FullscreenShell's 50-item cap). */
  maxItems?: number;
}

/**
 * Hook that listens for `ggui:agent-stream` CustomEvents and accumulates
 * text chunks into a shell's message/line state array.
 *
 * On native platforms this is a no-op (streaming is web-only via window events).
 * While streaming, inserts a message with `id: 'stream-active'` that updates
 * in place. When the stream completes, the item is finalized with a permanent ID.
 *
 * @typeParam T - Message item type (must have `id` and optional `text`)
 */
export function useAgentStream<T extends { id: string; text?: string }>({
  setItems,
  createItem,
  onDone,
  maxItems,
}: UseAgentStreamOptions<T>) {
  const bufferRef = useRef('');

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    function handleStream(event: Event) {
      const { chunk, done } = (event as CustomEvent).detail ?? {};

      if (done) {
        const finalText = bufferRef.current;
        bufferRef.current = '';
        if (finalText) {
          setItems(prev => {
            const idx = prev.findIndex(m => m.id === 'stream-active');
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = { ...updated[idx], id: `msg-${Date.now()}`, text: finalText };
              return updated;
            }
            return prev;
          });
        }
        onDone?.();
        return;
      }

      if (typeof chunk === 'string' && chunk) {
        bufferRef.current += chunk;
        const currentText = bufferRef.current;
        setItems(prev => {
          const idx = prev.findIndex(m => m.id === 'stream-active');
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], text: currentText };
            return updated;
          }
          const next = [...prev, createItem(currentText)];
          return maxItems ? next.slice(-maxItems) : next;
        });
      }
    }

    window.addEventListener('ggui:agent-stream', handleStream);
    return () => window.removeEventListener('ggui:agent-stream', handleStream);
  }, [setItems, createItem, onDone, maxItems]);
}
