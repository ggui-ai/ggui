import { useWireContext } from './context';

export interface GguiSessionInfo {
  renderId: string;
  isConnected: boolean;
}

/** Read-only render context with connection status. */
export function useRender(): GguiSessionInfo {
  const { render } = useWireContext();
  return render;
}
