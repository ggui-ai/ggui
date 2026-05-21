/**
 * Shared hooks for shell components.
 */

import { useRef, useState, useCallback, useMemo } from 'react';
import type { ShellTheme } from './theme';
import { buildShellTheme } from './theme';

/* ── useChatInput ── */

export interface UseChatInputOptions {
  /** Called with trimmed text when user sends a message. */
  onSend: (text: string) => void;
  /** Whether the shell is connected to the agent. */
  isConnected: boolean;
  /** Optional callback when Escape is pressed. */
  onEscape?: () => void;
}

export interface UseChatInputReturn {
  inputText: string;
  setInputText: (text: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  handleSend: () => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  canSend: boolean;
}

/**
 * Manages chat input state, send, and keyboard shortcuts.
 * The `onSend` callback receives trimmed text — the caller handles message
 * state, submitting to the agent, and any shell-specific side effects.
 */
export function useChatInput({ onSend, isConnected, onEscape }: UseChatInputOptions): UseChatInputReturn {
  const [inputText, setInputText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const onSendRef = useRef(onSend);
  const onEscapeRef = useRef(onEscape);
  onSendRef.current = onSend;
  onEscapeRef.current = onEscape;

  const canSend = isConnected && inputText.trim().length > 0;

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || !isConnected) return;
    onSendRef.current(text);
    setInputText('');
    inputRef.current?.focus();
  }, [inputText, isConnected]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape') {
      onEscapeRef.current?.();
    }
  }, [handleSend]);

  return { inputText, setInputText, inputRef, handleSend, handleKeyDown, canSend };
}

/* ── useShellTheme ── */

/**
 * Derive a stable ShellTheme (r, g, b, hex, darkHex) from a primaryColor prop.
 * Only recomputes when primaryColor changes.
 */
export function useShellTheme(primaryColor?: string): ShellTheme {
  return useMemo(() => buildShellTheme(primaryColor), [primaryColor]);
}
