import { useWireContext } from './context';

export interface AuthInfo {
  userId?: string;
  isAuthenticated: boolean;
}

/** Read-only auth context. Token excluded — auth is added server-side. */
export function useAuth(): AuthInfo {
  const { auth } = useWireContext();
  return auth;
}
