import { useWireContext } from './context';

export interface AppInfo {
  appId: string;
  appName: string;
  appDescription?: string;
  appIcon?: string;
}

/** Read-only app metadata. */
export function useApp(): AppInfo {
  const { app } = useWireContext();
  return app;
}
