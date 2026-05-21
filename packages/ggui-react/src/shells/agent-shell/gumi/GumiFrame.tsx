import React from 'react';
import type { FrameProps } from '../types';

export function GumiFrame({ state, children }: FrameProps) {
  return (
    <div
      data-ggui-frame
      style={{
        flex: 1,
        minHeight: 0,
        marginTop: 8,
        background: 'rgba(15, 25, 45, 0.7)',
        borderRadius: 20,
        border: '1.5px solid rgba(255, 255, 255, 0.08)',
        backdropFilter: 'blur(12px)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
        ...(state === 'thinking' && {
          borderColor: 'rgba(79, 195, 247, 0.2)',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), 0 0 20px rgba(79, 195, 247, 0.1)',
        }),
        ...(state === 'error' && {
          borderColor: 'rgba(233, 69, 96, 0.3)',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), 0 0 20px rgba(233, 69, 96, 0.1)',
        }),
      }}
    >
      {children}
    </div>
  );
}
