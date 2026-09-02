import { useSyncExternalStore } from 'react';
import { useWireContext } from './context';

export interface GguiSessionInfo {
  sessionId: string;
  isConnected: boolean;
}

const noopSubscribe = (): (() => void) => () => {};

/** Read-only render context with connection status. */
export function useRender(): GguiSessionInfo {
  const { render } = useWireContext();
  // Live when the renderer supplies the connection store (ggui#670);
  // the static field is the value for hand-built configs.
  const isConnected = useSyncExternalStore(
    render.connection?.subscribe ?? noopSubscribe,
    () => (render.connection ? render.connection.getSnapshot() : render.isConnected),
    () => (render.connection ? render.connection.getSnapshot() : render.isConnected),
  );
  return { sessionId: render.sessionId, isConnected };
}
