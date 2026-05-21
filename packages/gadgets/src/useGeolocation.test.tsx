import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useGeolocation } from './useGeolocation';

type GetCurrentPosition = (
  ok: PositionCallback,
  err?: PositionErrorCallback,
  opts?: PositionOptions,
) => void;
type WatchPosition = (
  ok: PositionCallback,
  err?: PositionErrorCallback,
  opts?: PositionOptions,
) => number;

function fakeGeolocation(opts: {
  getCurrentPosition?: GetCurrentPosition;
  watchPosition?: WatchPosition;
  clearWatch?: (id: number) => void;
}) {
  return {
    getCurrentPosition:
      opts.getCurrentPosition ??
      vi.fn().mockImplementation((_ok, _err) => {
        /* no-op default */
      }),
    watchPosition:
      opts.watchPosition ?? vi.fn().mockImplementation(() => 42),
    clearWatch: opts.clearWatch ?? vi.fn(),
  } as unknown as Geolocation;
}

function makePosition(coords: Partial<GeolocationCoordinates>): GeolocationPosition {
  return {
    coords: {
      latitude: 0,
      longitude: 0,
      accuracy: 1,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      ...coords,
    } as GeolocationCoordinates,
    timestamp: 1234567890,
  } as GeolocationPosition;
}

function makeError(code: number, message = 'err'): GeolocationPositionError {
  return {
    code,
    message,
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

describe('useGeolocation', () => {
  let originalNavigator: Navigator | undefined;
  beforeEach(() => {
    originalNavigator = globalThis.navigator;
  });
  afterEach(() => {
    if (originalNavigator !== undefined) {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      });
    }
  });

  it('starts in idle status with no value', () => {
    const { result } = renderHook(() => useGeolocation());
    expect(result.current.status).toBe('idle');
    expect(result.current.value).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });

  it('one-shot read transitions idle → prompting → completed and surfaces coords', async () => {
    const geo = fakeGeolocation({
      getCurrentPosition: (ok) =>
        ok(makePosition({ latitude: 37.7749, longitude: -122.4194 })),
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { geolocation: geo },
      configurable: true,
    });

    const { result } = renderHook(() => useGeolocation());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('completed');
    expect(result.current.value?.latitude).toBe(37.7749);
    expect(result.current.value?.longitude).toBe(-122.4194);
  });

  it('permission denied transitions to status=denied with permission_denied error', async () => {
    const geo = fakeGeolocation({
      getCurrentPosition: (_ok, err) => {
        err?.(makeError(1, 'denied by user'));
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { geolocation: geo },
      configurable: true,
    });

    const { result } = renderHook(() => useGeolocation());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('denied');
    expect(result.current.error?.code).toBe('permission_denied');
  });

  it('timeout error maps to error status with code=timeout', async () => {
    const geo = fakeGeolocation({
      getCurrentPosition: (_ok, err) => {
        err?.(makeError(3, 'timed out'));
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { geolocation: geo },
      configurable: true,
    });

    const { result } = renderHook(() => useGeolocation());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe('timeout');
  });

  it('missing Geolocation API surfaces not_supported error', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
    });
    const { result } = renderHook(() => useGeolocation());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe('not_supported');
  });

  it('watch mode invokes watchPosition and stop() clears it', async () => {
    const clearWatch = vi.fn();
    const watchPosition = vi.fn().mockImplementation((ok: PositionCallback) => {
      ok(makePosition({ latitude: 1, longitude: 2 }));
      return 123;
    });
    const geo = fakeGeolocation({ watchPosition, clearWatch });
    Object.defineProperty(globalThis, 'navigator', {
      value: { geolocation: geo },
      configurable: true,
    });

    const { result } = renderHook(() => useGeolocation({ watch: true }));
    await act(async () => {
      await result.current.start();
    });
    expect(watchPosition).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('active');

    act(() => {
      result.current.stop?.();
    });
    expect(clearWatch).toHaveBeenCalledWith(123);
    expect(result.current.status).toBe('completed');
  });
});
