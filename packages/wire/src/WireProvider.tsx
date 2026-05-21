import type { ReactNode } from 'react';
import { WireContext, type WireConfig } from './context';

export interface GguiWireProviderProps {
  config: WireConfig;
  children: ReactNode;
}

export function GguiWireProvider({ config, children }: GguiWireProviderProps) {
  return <WireContext.Provider value={config}>{children}</WireContext.Provider>;
}
