/**
 * `useMicrophone` — browser-capability hook for capturing audio via
 * `MediaDevices.getUserMedia({audio: true})` + MediaRecorder.
 *
 * Lifecycle: idle → prompting → active (recording) → completed
 * (with the captured blob). `stop()` ends the recording; without it,
 * the recording continues until the user revokes mic access or the
 * tab loses focus.
 *
 * Returns the captured audio as a Blob + duration metadata so
 * component code can thread the URL or upload-handle into a
 * contextSpec slot or actionSpec payload.
 */

import { useCallback, useRef, useState } from 'react';
import type {
  GadgetError,
  GadgetStatus,
  GadgetHook,
} from '@ggui-ai/protocol';

export interface MicrophoneOptions {
  /** MIME type for the recorder. Defaults to whatever the browser supports. */
  readonly mimeType?: string;
}

export interface MicrophoneResult {
  readonly blob: Blob;
  readonly durationMs: number;
  readonly mimeType: string;
}

function mapGetUserMediaError(err: unknown): GadgetError {
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

export const useMicrophone: GadgetHook<
  MicrophoneResult,
  MicrophoneOptions
> = (options) => {
  const [value, setValue] = useState<MicrophoneResult | undefined>(undefined);
  const [status, setStatus] = useState<GadgetStatus>('idle');
  const [error, setError] = useState<GadgetError | undefined>(undefined);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef<number>(0);
  const resolveRef = useRef<
    ((r: MicrophoneResult | undefined) => void) | null
  >(null);

  const start = useCallback(async (): Promise<
    MicrophoneResult | undefined
  > => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function' ||
      typeof MediaRecorder === 'undefined'
    ) {
      const e: GadgetError = {
        code: 'not_supported',
        message: 'MediaRecorder / getUserMedia unavailable.',
      };
      setError(e);
      setStatus('error');
      return undefined;
    }

    setStatus('prompting');
    setError(undefined);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const mapped = mapGetUserMediaError(err);
      setError(mapped);
      setStatus(mapped.code === 'permission_denied' ? 'denied' : 'error');
      return undefined;
    }
    streamRef.current = stream;

    const mimeType = options?.mimeType ?? 'audio/webm';
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch {
      // Fallback: let the browser pick mimeType.
      recorder = new MediaRecorder(stream);
    }
    recorderRef.current = recorder;

    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };

    return new Promise<MicrophoneResult | undefined>((resolve) => {
      resolveRef.current = resolve;
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const durationMs = Date.now() - startedAtRef.current;
        const result: MicrophoneResult = {
          blob,
          durationMs,
          mimeType: recorder.mimeType,
        };
        setValue(result);
        setStatus('completed');
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        recorderRef.current = null;
        resolveRef.current = null;
        resolve(result);
      };
      startedAtRef.current = Date.now();
      recorder.start();
      setStatus('active');
    });
  }, [options?.mimeType]);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.stop();
    } else {
      // Already stopped — ensure status reflects that.
      setStatus('completed');
    }
  }, []);

  return {
    value,
    status,
    ...(error !== undefined ? { error } : {}),
    start,
    stop,
  };
};
