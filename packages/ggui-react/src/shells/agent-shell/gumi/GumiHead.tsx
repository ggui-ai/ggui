import React from 'react';
import type { HeadProps } from '../types';

export function GumiHead({ state, characterUrl }: HeadProps) {
  return (
    <div
      data-ggui-head
      style={{
        position: 'absolute',
        bottom: -60,
        left: 50,
        width: 180,
        height: 120,
        zIndex: 3,
      }}
    >
      {characterUrl ? (
        <img
          src={characterUrl}
          alt="Agent"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            pointerEvents: 'none',
            animation: state === 'thinking' ? 'ggui-head-bob 3s ease-in-out infinite' : 'ggui-head-bob 3s ease-in-out infinite',
            ...(state === 'error' && {
              filter: 'grayscale(0.7) brightness(0.8)',
            }),
          }}
        />
      ) : (
        <div style={{
          display: 'flex', gap: 6, alignItems: 'center',
          padding: '8px 12px',
          background: 'rgba(42, 42, 74, 0.8)',
          borderRadius: 24, backdropFilter: 'blur(4px)',
          height: '100%', justifyContent: 'center',
          animation: 'ggui-head-bob 3s ease-in-out infinite',
        }}>
          <div style={{
            width: 24, height: 24, background: '#2a2a4a', borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              width: 10, height: 10,
              background: state === 'error' ? '#e94560' : '#4fc3f7',
              borderRadius: '50%',
            }} />
          </div>
          <div style={{
            width: 24, height: 24, background: '#2a2a4a', borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              width: 10, height: 10,
              background: state === 'error' ? '#e94560' : '#4fc3f7',
              borderRadius: '50%',
            }} />
          </div>
        </div>
      )}
      <style>{`
        @keyframes ggui-head-bob {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          50% { transform: translateY(-4px) rotate(2deg); }
        }
      `}</style>
    </div>
  );
}
