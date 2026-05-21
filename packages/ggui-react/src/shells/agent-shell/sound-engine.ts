import { useRef, useEffect, useCallback } from 'react';
import type { AgentState, SoundMap, AudioSrc } from './types';

interface UseSoundEngineOptions {
  agentState: AgentState;
  sounds?: false | Partial<SoundMap>;
}

function resolveAudio(src: AudioSrc): HTMLAudioElement {
  if (src instanceof HTMLAudioElement) return src;
  const audio = new Audio(src);
  audio.volume = 0.3;
  return audio;
}

export function useSoundEngine({ agentState, sounds }: UseSoundEngineOptions): void {
  const prevStateRef = useRef<AgentState>(agentState);
  const audioCache = useRef<Map<string, HTMLAudioElement>>(new Map());

  const playSound = useCallback(
    (key: keyof SoundMap) => {
      if (sounds === false) return;
      const src = sounds?.[key];
      if (!src) return;

      let audio = audioCache.current.get(key);
      if (!audio) {
        audio = resolveAudio(src);
        audioCache.current.set(key, audio);
      }
      audio.currentTime = 0;
      audio.play().catch(() => {}); // Ignore autoplay restrictions
    },
    [sounds],
  );

  // Play sound on state transitions
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = agentState;

    if (prev === agentState) return;

    switch (agentState) {
      case 'thinking':
        playSound('thinking');
        break;
      case 'presenting':
        playSound('presenting');
        break;
      case 'error':
        playSound('error');
        break;
    }
  }, [agentState, playSound]);
}
