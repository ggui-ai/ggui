import React, { useState, useRef, useCallback } from 'react';
import { Send } from 'lucide-react';
import type { InputProps } from '../types';

export function GumiInput({ state: _state, onSubmit, disabled }: InputProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setText('');
  }, [text, disabled, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const expanded = focused || !!text;
  const isDisabled = disabled || !text.trim();

  return (
    <>
      <input
        ref={inputRef}
        data-ggui-input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Ask me anything..."
        disabled={disabled}
        style={{
          width: expanded ? 320 : 280,
          background: focused ? 'rgba(240, 248, 255, 0.75)' : 'rgba(240, 248, 255, 0.6)',
          backdropFilter: 'blur(8px)',
          border: `1px solid ${focused ? 'rgba(255, 255, 255, 0.6)' : 'rgba(255, 255, 255, 0.4)'}`,
          borderRadius: 12,
          padding: '8px 16px',
          fontSize: 12,
          color: 'rgba(15, 30, 60, 0.8)',
          outline: 'none',
          transition: 'width 0.3s ease, border-color 0.2s, background 0.2s',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)',
        }}
      />
      <button
        onClick={handleSend}
        disabled={isDisabled}
        style={{
          width: 36,
          height: 36,
          borderRadius: 12,
          background: isDisabled ? 'rgba(15, 25, 45, 0.65)' : 'rgba(15, 25, 45, 0.85)',
          border: '1.5px solid rgba(255, 255, 255, 0.12)',
          color: isDisabled ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.85)',
          cursor: isDisabled ? 'default' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          transition: 'background 0.2s, border-color 0.2s, opacity 0.2s',
        }}
      >
        <Send size={16} />
      </button>
      <style>{`
        [data-ggui-input]::placeholder { color: rgba(15, 30, 60, 0.35); }
      `}</style>
    </>
  );
}
