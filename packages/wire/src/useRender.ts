import { useWireContext } from './context';

export interface RenderInfo {
  renderId: string;
  isConnected: boolean;
}

/** Read-only render context with connection status. */
export function useRender(): RenderInfo {
  const { render } = useWireContext();
  return render;
}
