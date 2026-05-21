/**
 * useNetworkState — platform-agnostic online/offline hook.
 *
 * Web: reads `navigator.onLine`, subscribes to window online/offline
 * events. RN: no global signal is available in a byte-identical
 * implementation, so it defaults to `true`. RN integrators that want
 * real network-state awareness should override with
 * `useChatThread({ isOnline: ... })` sourced from `@react-native-
 * community/netinfo` in their app code.
 */
import { useEffect, useState } from 'react';

type MaybeWindow = {
  addEventListener?: (type: string, cb: () => void) => void;
  removeEventListener?: (type: string, cb: () => void) => void;
};

function getInitial(): boolean {
  if (typeof navigator === 'undefined') return true;
  if (!('onLine' in navigator)) return true;
  return (navigator as Navigator).onLine;
}

function getWindow(): MaybeWindow | null {
  if (typeof window === 'undefined') return null;
  return window as MaybeWindow;
}

export function useNetworkState(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(getInitial);

  useEffect(() => {
    const w = getWindow();
    if (!w || !w.addEventListener || !w.removeEventListener) return;
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    w.addEventListener('online', onOnline);
    w.addEventListener('offline', onOffline);
    return () => {
      w.removeEventListener!('online', onOnline);
      w.removeEventListener!('offline', onOffline);
    };
  }, []);

  return isOnline;
}
