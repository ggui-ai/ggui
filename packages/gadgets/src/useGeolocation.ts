/**
 * `useGeolocation` — browser-capability hook for reading the user's
 * current location via the Geolocation API. Satisfies
 * `GadgetHook<GeolocationCoords, GeolocationOptions>`.
 *
 * Lifecycle:
 *   - `idle` — initial, no request fired.
 *   - `prompting` — permission prompt visible (browser-controlled).
 *   - `active` — permission granted; for watch mode, position updates
 *     stream as they arrive.
 *   - `completed` — terminal for one-shot mode (`watch: false`) after
 *     a successful read.
 *   - `denied` — user rejected the permission prompt or the request
 *     errored with `PERMISSION_DENIED`.
 *   - `error` — any other failure (`POSITION_UNAVAILABLE`, `TIMEOUT`,
 *     or `Geolocation API unavailable`).
 *
 * Contract authors declare this hook via
 * `clientCapabilities.gadgets['@ggui-ai/gadgets'] = { useGeolocation: {} }`
 * and the UI generator emits the import + call site. Values surface to
 * the agent via `contextSpec` (the component code threads `value` into
 * the relevant slot's setter).
 */

import { useCallback, useRef, useState } from 'react';
import type {
  GadgetError,
  GadgetStatus,
  GadgetHook,
} from '@ggui-ai/protocol';

/** Coordinates returned by the hook. Pure JSON for easy contextSpec
 *  threading. */
export interface GeolocationCoords {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy: number;
  readonly altitude?: number;
  readonly altitudeAccuracy?: number;
  readonly heading?: number;
  readonly speed?: number;
  readonly timestamp: number;
}

/** Options accepted by `useGeolocation`. */
export interface GeolocationOptions {
  /** Continuously stream updates instead of single read. Default: false. */
  readonly watch?: boolean;
  /** Request high-accuracy positioning. Default: false. */
  readonly enableHighAccuracy?: boolean;
  /** Max age (ms) of a cached position the browser may return.
   *  Default: 0 (always fresh). */
  readonly maximumAge?: number;
  /** Request timeout in ms. Default: Infinity. */
  readonly timeout?: number;
}

function toCoords(position: GeolocationPosition): GeolocationCoords {
  const c = position.coords;
  const result: Record<string, number> = {
    latitude: c.latitude,
    longitude: c.longitude,
    accuracy: c.accuracy,
    timestamp: position.timestamp,
  };
  if (c.altitude !== null) result.altitude = c.altitude;
  if (c.altitudeAccuracy !== null) result.altitudeAccuracy = c.altitudeAccuracy;
  if (c.heading !== null) result.heading = c.heading;
  if (c.speed !== null) result.speed = c.speed;
  return result as unknown as GeolocationCoords;
}

function mapGeolocationError(err: GeolocationPositionError): GadgetError {
  if (err.code === err.PERMISSION_DENIED) {
    return { code: 'permission_denied', message: err.message };
  }
  if (err.code === err.TIMEOUT) {
    return { code: 'timeout', message: err.message };
  }
  return { code: 'unknown', message: err.message };
}

export const useGeolocation: GadgetHook<
  GeolocationCoords,
  GeolocationOptions
> = (options) => {
  const [value, setValue] = useState<GeolocationCoords | undefined>(undefined);
  const [status, setStatus] = useState<GadgetStatus>('idle');
  const [error, setError] = useState<GadgetError | undefined>(undefined);
  const watchIdRef = useRef<number | null>(null);

  const start = useCallback(async (): Promise<
    GeolocationCoords | undefined
  > => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.geolocation
    ) {
      const e: GadgetError = {
        code: 'not_supported',
        message: 'Geolocation API unavailable in this environment.',
      };
      setError(e);
      setStatus('error');
      return undefined;
    }

    setStatus('prompting');
    setError(undefined);

    const positionOptions: PositionOptions = {
      enableHighAccuracy: options?.enableHighAccuracy ?? false,
      maximumAge: options?.maximumAge ?? 0,
      timeout: options?.timeout ?? Number.POSITIVE_INFINITY,
    };

    if (options?.watch) {
      return new Promise<GeolocationCoords | undefined>((resolve) => {
        let firstResolved = false;
        watchIdRef.current = navigator.geolocation.watchPosition(
          (position) => {
            const coords = toCoords(position);
            setValue(coords);
            setStatus('active');
            if (!firstResolved) {
              firstResolved = true;
              resolve(coords);
            }
          },
          (err) => {
            const mapped = mapGeolocationError(err);
            setError(mapped);
            setStatus(mapped.code === 'permission_denied' ? 'denied' : 'error');
            if (!firstResolved) {
              firstResolved = true;
              resolve(undefined);
            }
          },
          positionOptions,
        );
      });
    }

    return new Promise<GeolocationCoords | undefined>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const coords = toCoords(position);
          setValue(coords);
          setStatus('completed');
          resolve(coords);
        },
        (err) => {
          const mapped = mapGeolocationError(err);
          setError(mapped);
          setStatus(mapped.code === 'permission_denied' ? 'denied' : 'error');
          resolve(undefined);
        },
        positionOptions,
      );
    });
  }, [options?.enableHighAccuracy, options?.maximumAge, options?.timeout, options?.watch]);

  const stop = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined') {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setStatus('completed');
  }, []);

  return {
    value,
    status,
    ...(error !== undefined ? { error } : {}),
    start,
    stop,
  };
};
