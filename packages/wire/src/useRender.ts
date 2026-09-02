import { useSyncExternalStore } from 'react';
import { useWireContext } from './context';
import { connectionStore } from './connection-store';

export interface GguiSessionInfo {
  sessionId: string;
  isConnected: boolean;
}

/** Read-only render context with connection status. */
export function useRender(): GguiSessionInfo {
  const { render } = useWireContext();
  // `isConnected` is LIVE (ggui#670): the document's connection store
  // is written by the runtime at the relay latch's edges; the static
  // config field is not consulted. Presentational truth only —
  // readers MUST NOT suppress dispatch on `false`.
  const isConnected = useSyncExternalStore(
    connectionStore.subscribe,
    connectionStore.getSnapshot,
    connectionStore.getSnapshot,
  );
  return { sessionId: render.sessionId, isConnected };
}
