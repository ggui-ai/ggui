import React from 'react';
import type { BubbleProps } from '../types';

export function GumiBubble({ state: _state, message, visible }: BubbleProps) {
  if (!visible || !message) return null;

  return (
    <div
      data-ggui-bubble
      style={{
        position: 'absolute',
        bottom: 18,
        left: 230,
        zIndex: 4,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        pointerEvents: 'none',
      }}
    >
      <div style={{
        background: 'rgba(240, 248, 255, 0.85)',
        borderRadius: 20,
        padding: '12px 20px',
        maxWidth: 300,
        textAlign: 'center',
        fontSize: 13,
        color: 'rgba(15, 30, 60, 0.9)',
        fontWeight: 500,
        lineHeight: 1.5,
        boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
        animation: 'ggui-bubble-float 3s ease-in-out infinite',
      }}>
        {message}
      </div>
      {/* Connecting dots — trail from bubble to character */}
      <div style={{
        position: 'absolute',
        bottom: -35,
        left: -20,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 6,
        alignItems: 'center',
        transform: 'rotate(80deg)',
        transformOrigin: 'top right',
      }}>
        <div style={{
          width: 7, height: 7, borderRadius: '50%',
          background: 'rgba(240, 248, 255, 0.7)',
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.08)',
        }} />
        <div style={{
          width: 11, height: 11, borderRadius: '50%',
          background: 'rgba(240, 248, 255, 0.7)',
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.08)',
        }} />
        <div style={{
          width: 15, height: 15, borderRadius: '50%',
          background: 'rgba(240, 248, 255, 0.7)',
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.08)',
        }} />
      </div>
      <style>{`
        @keyframes ggui-bubble-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
      `}</style>
    </div>
  );
}
