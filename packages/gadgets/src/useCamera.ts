/**
 * `useCamera` — browser-capability hook for capturing a still photo
 * via `MediaDevices.getUserMedia({video: true})` + canvas drawing.
 *
 * Lifecycle: idle → prompting → active (camera live) → completed
 * (with the captured photo as a data URL). The hook returns a single
 * snapshot per `start()` — call `stop()` to release the camera
 * without taking a photo.
 *
 * Component code threads the data URL into a contextSpec slot or
 * actionSpec payload. For continuous video / multi-frame capture, a
 * different hook would be needed (out of v1 scope).
 */

import { useCallback, useRef, useState } from 'react';
import type {
  GadgetError,
  GadgetStatus,
  GadgetHook,
} from '@ggui-ai/protocol';

export interface CameraOptions {
  /** Prefer front ('user') or rear ('environment') camera. Optional. */
  readonly facingMode?: 'user' | 'environment';
  /** MIME type for the encoded snapshot. Default: 'image/png'. */
  readonly mimeType?: string;
  /** JPEG quality 0–1. Only used when mimeType is image/jpeg. */
  readonly quality?: number;
}

export interface CameraResult {
  /** Encoded snapshot as a data URL. */
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly mimeType: string;
}

function mapCameraError(err: unknown): GadgetError {
  if (err instanceof Error) {
    if (err.name === 'NotAllowedError') {
      return { code: 'permission_denied', message: err.message };
    }
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
      return { code: 'not_supported', message: err.message };
    }
    return { code: 'unknown', message: err.message };
  }
  return { code: 'unknown', message: String(err) };
}

export const useCamera: GadgetHook<CameraResult, CameraOptions> = (
  options,
) => {
  const [value, setValue] = useState<CameraResult | undefined>(undefined);
  const [status, setStatus] = useState<GadgetStatus>('idle');
  const [error, setError] = useState<GadgetError | undefined>(undefined);
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setStatus('completed');
  }, []);

  const start = useCallback(async (): Promise<CameraResult | undefined> => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function' ||
      typeof document === 'undefined'
    ) {
      const e: GadgetError = {
        code: 'not_supported',
        message: 'getUserMedia / DOM unavailable.',
      };
      setError(e);
      setStatus('error');
      return undefined;
    }

    setStatus('prompting');
    setError(undefined);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: options?.facingMode
          ? { facingMode: options.facingMode }
          : true,
      });
    } catch (err) {
      const mapped = mapCameraError(err);
      setError(mapped);
      setStatus(mapped.code === 'permission_denied' ? 'denied' : 'error');
      return undefined;
    }
    streamRef.current = stream;
    setStatus('active');

    try {
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      // Allow one frame for the camera to expose proper dimensions.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );

      const canvas = document.createElement('canvas');
      const width = video.videoWidth || 640;
      const height = video.videoHeight || 480;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        const e: GadgetError = {
          code: 'unknown',
          message: '2D canvas context unavailable.',
        };
        setError(e);
        setStatus('error');
        stop();
        return undefined;
      }
      ctx.drawImage(video, 0, 0, width, height);

      const mimeType = options?.mimeType ?? 'image/png';
      const dataUrl =
        options?.quality !== undefined
          ? canvas.toDataURL(mimeType, options.quality)
          : canvas.toDataURL(mimeType);

      const result: CameraResult = { dataUrl, width, height, mimeType };
      setValue(result);
      setStatus('completed');
      stop();
      return result;
    } catch (err) {
      const mapped = mapCameraError(err);
      setError(mapped);
      setStatus('error');
      stop();
      return undefined;
    }
  }, [options?.facingMode, options?.mimeType, options?.quality, stop]);

  return {
    value,
    status,
    ...(error !== undefined ? { error } : {}),
    start,
    stop,
  };
};
