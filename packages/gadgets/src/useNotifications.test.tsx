import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNotifications } from './useNotifications';

describe('useNotifications', () => {
  let originalNotification: typeof Notification | undefined;
  beforeEach(() => {
    originalNotification = (globalThis as { Notification?: typeof Notification })
      .Notification;
  });
  afterEach(() => {
    if (originalNotification !== undefined) {
      Object.defineProperty(globalThis, 'Notification', {
        value: originalNotification,
        configurable: true,
        writable: true,
      });
    } else {
      delete (globalThis as { Notification?: typeof Notification }).Notification;
    }
  });

  it('errors with not_supported when Notification is undefined', async () => {
    delete (globalThis as { Notification?: typeof Notification }).Notification;
    const { result } = renderHook(() => useNotifications({ title: 'hi' }));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe('not_supported');
  });

  it('errors when title is missing', async () => {
    const NotificationStub = vi.fn();
    Object.assign(NotificationStub, { permission: 'granted', requestPermission: vi.fn() });
    Object.defineProperty(globalThis, 'Notification', {
      value: NotificationStub,
      configurable: true,
      writable: true,
    });
    const { result } = renderHook(() =>
      useNotifications({ title: '' as unknown as string }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toMatch(/title/);
  });

  it('routes denied permission to status=denied', async () => {
    const NotificationStub = vi.fn();
    Object.assign(NotificationStub, {
      permission: 'default',
      requestPermission: vi.fn().mockResolvedValue('denied'),
    });
    Object.defineProperty(globalThis, 'Notification', {
      value: NotificationStub,
      configurable: true,
      writable: true,
    });
    const { result } = renderHook(() => useNotifications({ title: 'hi' }));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('denied');
    expect(result.current.error?.code).toBe('permission_denied');
  });

  it('completes when user clicks the notification (granted permission)', async () => {
    const onclickHolder: { handler?: () => void } = {};
    const NotificationStub = vi.fn().mockImplementation(function (this: {
      onclick?: () => void;
      onclose?: () => void;
    }) {
      onclickHolder.handler = () => this.onclick?.();
    });
    Object.assign(NotificationStub, {
      permission: 'granted',
      requestPermission: vi.fn(),
    });
    Object.defineProperty(globalThis, 'Notification', {
      value: NotificationStub,
      configurable: true,
      writable: true,
    });

    const { result } = renderHook(() =>
      useNotifications({ title: 'hi', tag: 't' }),
    );
    let startPromise: Promise<unknown> | undefined;
    act(() => {
      startPromise = result.current.start();
    });
    // Wait for setStatus(prompting) → granted check → Notification ctor
    await act(async () => {
      await Promise.resolve();
      onclickHolder.handler?.();
    });
    await startPromise;
    expect(result.current.status).toBe('completed');
    expect(result.current.value?.outcome).toBe('clicked');
    expect(result.current.value?.tag).toBe('t');
  });
});
