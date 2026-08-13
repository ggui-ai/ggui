import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * Hook to track React Native AppState (active, background, inactive).
 * Useful for pausing/resuming connections and animations.
 */
export function useAppState(): AppStateStatus {
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      appStateRef.current = nextState;
      setAppState(nextState);
    });

    return () => {
      subscription.remove();
    };
  }, []);

  return appState;
}
