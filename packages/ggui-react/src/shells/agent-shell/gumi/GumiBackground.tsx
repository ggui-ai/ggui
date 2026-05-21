import React from 'react';
import type { BackgroundProps } from '../types';

const FALLBACK_GRADIENT = 'linear-gradient(180deg, #a8e6cf 0%, #3db8c1 20%, #1a8fa0 40%, #c4956a 85%, #8b6a4a 100%)';

export function GumiBackground({ state, backgroundUrl }: BackgroundProps) {
  return (
    <div
      data-ggui-background
      style={{
        position: 'absolute',
        inset: 0,
        background: backgroundUrl ? `url(${backgroundUrl}) center / cover no-repeat` : FALLBACK_GRADIENT,
        zIndex: 0,
        transition: 'filter 0.5s ease',
        filter: state === 'error' ? 'saturate(0.3) brightness(0.7)' : 'none',
      }}
    />
  );
}
