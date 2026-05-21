import { useWireContext } from './context';

export interface SessionInfo {
  sessionId: string;
  isConnected: boolean;
}

/** Read-only session context with connection status. */
export function useSession(): SessionInfo {
  const { session } = useWireContext();
  return session;
}
