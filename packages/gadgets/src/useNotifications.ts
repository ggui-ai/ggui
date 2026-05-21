/**
 * `useNotifications` — browser-capability hook for showing system
 * notifications via the Notification API. Satisfies
 * `GadgetHook<NotificationResult, NotificationOptions>`.
 *
 * Permission semantics: the first `start()` call requests permission
 * via `Notification.requestPermission()`; subsequent calls reuse the
 * granted permission. Permission denial is sticky on the browser
 * side — once denied, future `start()` calls error with
 * `permission_denied` without re-prompting.
 *
 * Lifecycle: idle → prompting → completed (after notification
 * dismissed/clicked) or denied/error.
 */

import { useCallback, useState } from 'react';
import type {
  GadgetError,
  GadgetStatus,
  GadgetHook,
} from '@ggui-ai/protocol';

export interface NotificationOptions_ {
  readonly title: string;
  readonly body?: string;
  readonly icon?: string;
  readonly tag?: string;
}

export interface NotificationResult {
  readonly outcome: 'clicked' | 'closed';
  readonly tag?: string;
}

export const useNotifications: GadgetHook<
  NotificationResult,
  NotificationOptions_
> = (options) => {
  const [value, setValue] = useState<NotificationResult | undefined>(
    undefined,
  );
  const [status, setStatus] = useState<GadgetStatus>('idle');
  const [error, setError] = useState<GadgetError | undefined>(undefined);

  const start = useCallback(async (): Promise<
    NotificationResult | undefined
  > => {
    if (typeof Notification === 'undefined') {
      const e: GadgetError = {
        code: 'not_supported',
        message: 'Notification API unavailable in this environment.',
      };
      setError(e);
      setStatus('error');
      return undefined;
    }

    if (!options?.title) {
      const e: GadgetError = {
        code: 'unknown',
        message: 'useNotifications: `title` option required at start().',
      };
      setError(e);
      setStatus('error');
      return undefined;
    }

    setStatus('prompting');
    setError(undefined);

    let permission = Notification.permission;
    if (permission === 'default') {
      try {
        permission = await Notification.requestPermission();
      } catch (err) {
        const e: GadgetError = {
          code: 'unknown',
          message: err instanceof Error ? err.message : String(err),
        };
        setError(e);
        setStatus('error');
        return undefined;
      }
    }

    if (permission !== 'granted') {
      const e: GadgetError = {
        code: 'permission_denied',
        message: 'Notification permission not granted.',
      };
      setError(e);
      setStatus('denied');
      return undefined;
    }

    return new Promise<NotificationResult | undefined>((resolve) => {
      const notif = new Notification(options.title, {
        ...(options.body !== undefined ? { body: options.body } : {}),
        ...(options.icon !== undefined ? { icon: options.icon } : {}),
        ...(options.tag !== undefined ? { tag: options.tag } : {}),
      });
      const finish = (outcome: 'clicked' | 'closed') => {
        const result: NotificationResult = {
          outcome,
          ...(options.tag !== undefined ? { tag: options.tag } : {}),
        };
        setValue(result);
        setStatus('completed');
        resolve(result);
      };
      notif.onclick = () => finish('clicked');
      notif.onclose = () => finish('closed');
    });
  }, [options?.title, options?.body, options?.icon, options?.tag]);

  return {
    value,
    status,
    ...(error !== undefined ? { error } : {}),
    start,
  };
};
