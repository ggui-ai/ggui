/**
 * Test-only fixture downloader. Writes a synthetic marker file into
 * the cache path + emits scripted progress so the harness's
 * lifecycle can be exercised deterministically.
 *
 * Behavior:
 *   - Creates `cachePath` if missing.
 *   - Writes `cachePath/.ggui-fixture-model.bin` of the requested
 *     `sizeBytes`.
 *   - Emits `progressSteps` evenly-spaced `onProgress` callbacks
 *     between 0 and `sizeBytes`.
 *   - Honors `signal`: if aborted mid-download, throws a
 *     {@link BootstrapError}-shaped object with `kind: 'aborted'`.
 *   - Honors a scripted `failAt` byte threshold: throws a
 *     {@link BootstrapError}-shaped object with the configured kind
 *     (default `'download-failed'`) when reached.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Downloader } from './bootstrap.js';

export interface InMemoryDownloaderOptions {
  /** Total bytes the fixture pretends to download. Default 1024. */
  readonly sizeBytes?: number;
  /** Number of `onProgress` callbacks to emit. Default 4. */
  readonly progressSteps?: number;
  /** Report `totalBytes` to the harness (true) or `null` (false).
   *  Default true. Tests both paths via `false`. */
  readonly reportTotal?: boolean;
  /**
   * Optional scripted failure: throw at this many bytes received.
   * Used to test the `'download-failed'` path.
   */
  readonly failAt?: number;
  /** Override the failure kind. Default `'download-failed'`. */
  readonly failKind?:
    | 'download-failed'
    | 'cache-write-failed'
    | 'parse-failed'
    | 'unknown';
  /** Override the failure message. */
  readonly failMessage?: string;
}

export function createInMemoryDownloader(
  opts: InMemoryDownloaderOptions = {},
): Downloader {
  const sizeBytes = opts.sizeBytes ?? 1024;
  const steps = Math.max(1, opts.progressSteps ?? 4);
  const reportTotal = opts.reportTotal ?? true;
  const failAt = opts.failAt;
  const failKind = opts.failKind ?? 'download-failed';
  const failMessage = opts.failMessage ?? 'fixture-induced failure';

  return {
    async download({ modelId, cachePath, signal, onProgress }) {
      // Step boundary in bytes. Last step lands exactly on
      // `sizeBytes` so consumers get a final 100% callback.
      const stepSize = sizeBytes / steps;

      for (let i = 1; i <= steps; i++) {
        if (signal?.aborted) {
          throw {
            kind: 'aborted' as const,
            modelId,
            message: 'fixture downloader aborted',
          };
        }
        const bytesReceived = Math.round(stepSize * i);
        if (failAt !== undefined && bytesReceived >= failAt) {
          throw {
            kind: failKind,
            modelId,
            message: failMessage,
          };
        }
        onProgress?.(bytesReceived, reportTotal ? sizeBytes : null);
        // Yield once so a caller's `controller.abort()` between
        // steps can be observed.
        await Promise.resolve();
      }

      // Materialize the cache so a follow-up `state()` reports
      // `'cached'` and a follow-up `warmup()` short-circuits.
      try {
        mkdirSync(cachePath, { recursive: true });
        writeFileSync(
          join(cachePath, '.ggui-fixture-model.bin'),
          Buffer.alloc(sizeBytes, 0),
        );
      } catch (err) {
        throw {
          kind: 'cache-write-failed' as const,
          modelId,
          message: err instanceof Error ? err.message : String(err),
        };
      }

      return { sizeBytes, totalBytes: reportTotal ? sizeBytes : null };
    },
  };
}
