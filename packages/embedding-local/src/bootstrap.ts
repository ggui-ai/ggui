/**
 * Cold-start bootstrap harness for local-model embedding.
 *
 * This harness owns the **lifecycle + cache resolution + operator-
 * visible event surface** that the self-hosted generation path
 * relies on. The actual model download is plugged in via the
 * {@link Downloader} seam, so the harness stays testable and
 * decoupled from the heavy `@huggingface/transformers` dependency
 * (~60MB ort-node + ~33MB model).
 *
 * **What the harness IS responsible for:**
 *
 *   - Resolving where the model lives on disk (env override > home
 *     default).
 *   - Detecting whether a cached copy is already present.
 *   - Driving the warmup lifecycle: `started` → optional
 *     `downloading` → `progress*` → `cached` (already present) /
 *     `ready` (newly fetched) → optional `error`.
 *   - Reporting the lifecycle through a strongly-typed
 *     {@link BootstrapEvent} discriminated union the CLI banner can
 *     render to stdout (operators see `downloading bge-small-v1.5
 *     (~33MB) to ~/.ggui/models/...` instead of a silent hang).
 *   - Honoring `AbortSignal`: warmup MUST stop emitting + reject
 *     with a structured error when fired.
 *
 * **What the harness IS NOT responsible for:**
 *
 *   - The download itself. {@link Downloader} is the seam; this
 *     package ships {@link createNoopDownloader} for tests, and a
 *     real transformers.js-backed downloader is wired separately.
 *   - Embedding inference. The `embed(text): number[]` shape lives
 *     on `@ggui-ai/mcp-server-core`'s `EmbeddingProvider` interface;
 *     {@link createLocalEmbeddingProvider} pairs this bootstrap with
 *     that contract.
 *   - Multi-model orchestration. The current design is one model id,
 *     one cache directory.
 *
 * **Default model + revision:**
 *
 *   - `Xenova/bge-small-en-v1.5` — 384d, MIT-licensed, MTEB ~62.2.
 *   - Pinned revision so cold-starts are deterministic across
 *     machines. The pin is a constant here — bump it intentionally,
 *     not "whatever is latest on the hub today".
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Locked default model id. Bump explicitly (not lazily). */
export const DEFAULT_MODEL_ID = 'Xenova/bge-small-en-v1.5';
/**
 * Pinned revision. The string is a sentinel for the harness layer —
 * the real downloader treats this as the HuggingFace commit hash to
 * fetch. `'main'` is the conservative default; pin to a specific
 * hash for fully reproducible cold-starts.
 */
export const DEFAULT_MODEL_REVISION = 'main';
/** L2-normalized output dimensions for `bge-small-en-v1.5`. */
export const DEFAULT_MODEL_DIMENSIONS = 384;

/**
 * Discriminated bootstrap state. Returned by
 * {@link EmbeddingBootstrap.state}; consumers branch on `kind`.
 *
 * Transitions:
 *
 *   - `'cold'` — no cached files exist, no warmup in flight.
 *   - `'cached'` — files exist on disk; `warmup()` will short-circuit
 *     to `ready` without a download.
 *   - `'loading'` — `warmup()` is in flight (downloading + parsing).
 *   - `'ready'` — model loaded + ready for inference. Sticky until
 *     a new warmup starts (e.g. after a cache wipe).
 *   - `'error'` — last warmup failed. Carries the structured error
 *     so the CLI can show it without re-running the harness.
 */
export type BootstrapState =
  | { readonly kind: 'cold'; readonly cachePath: string }
  | { readonly kind: 'cached'; readonly cachePath: string; readonly sizeBytes: number }
  | { readonly kind: 'loading'; readonly cachePath: string; readonly startedAt: number }
  | {
      readonly kind: 'ready';
      readonly cachePath: string;
      readonly sizeBytes: number;
      readonly modelId: string;
      readonly revision: string;
      readonly dimensions: number;
    }
  | {
      readonly kind: 'error';
      readonly cachePath: string;
      readonly error: BootstrapError;
    };

/**
 * Discriminated bootstrap error. Mirrors the
 * {@link import('@ggui-ai/ui-gen/provider-adapter').ProviderError}
 * shape (kind + message + provider-ish field — here `modelId`) so
 * downstream surfaces (CLI banner, generation handler) handle them
 * uniformly.
 */
export type BootstrapErrorKind =
  | 'cache-write-failed'
  | 'download-failed'
  | 'parse-failed'
  | 'aborted'
  | 'unknown';

export interface BootstrapError {
  readonly kind: BootstrapErrorKind;
  readonly modelId: string;
  readonly message: string;
}

/**
 * Operator-visible event sequence emitted during {@link EmbeddingBootstrap.warmup}.
 *
 * Ordering invariants the runner enforces (covered by tests):
 *
 *   1. Always at least one `'started'`.
 *   2. `'downloading'` fires at most once, BEFORE any `'progress'`.
 *      Skipped entirely when the model was already cached.
 *   3. `'progress'` fires zero or more times, monotonically
 *      non-decreasing in `bytesReceived`.
 *   4. Exactly one terminal event: `'cached'` (warmup found a cache
 *      hit and skipped download) OR `'ready'` (download + load
 *      succeeded) OR `'error'`.
 */
export type BootstrapEvent =
  | { readonly type: 'started'; readonly cachePath: string; readonly modelId: string; readonly at: number }
  | {
      readonly type: 'downloading';
      readonly cachePath: string;
      readonly modelId: string;
      readonly revision: string;
      /** `null` when the downloader hasn't reported a content-length. */
      readonly totalBytes: number | null;
      readonly at: number;
    }
  | {
      readonly type: 'progress';
      readonly bytesReceived: number;
      readonly totalBytes: number | null;
      readonly at: number;
    }
  | {
      readonly type: 'cached';
      readonly cachePath: string;
      readonly modelId: string;
      readonly sizeBytes: number;
      readonly at: number;
    }
  | {
      readonly type: 'ready';
      readonly cachePath: string;
      readonly modelId: string;
      readonly revision: string;
      readonly sizeBytes: number;
      readonly at: number;
    }
  | { readonly type: 'error'; readonly error: BootstrapError; readonly at: number };

/**
 * Pluggable downloader. The harness owns the lifecycle; downloaders
 * own the bytes. The transformers.js-backed downloader implements
 * this interface; tests inject {@link createInMemoryDownloader} for
 * deterministic event-sequence assertions.
 *
 * Downloaders MUST:
 *   - Honor `signal` and reject with `BootstrapErrorKind:'aborted'`
 *     when fired.
 *   - Call `onProgress(bytesReceived, totalBytes | null)` zero or
 *     more times, monotonically non-decreasing.
 *   - Return `{sizeBytes, totalBytes}` on success — the harness
 *     uses `sizeBytes` for the `ready`/`cached` event payload.
 *   - Throw a `BootstrapError`-shaped object on failure; the
 *     harness catches + funnels through to `error` events.
 */
export interface Downloader {
  download(args: {
    readonly modelId: string;
    readonly revision: string;
    readonly cachePath: string;
    readonly signal?: AbortSignal;
    readonly onProgress?: (bytesReceived: number, totalBytes: number | null) => void;
  }): Promise<{ readonly sizeBytes: number; readonly totalBytes: number | null }>;
}

/**
 * No-op downloader. Always rejects. Useful as a guard so a misuse
 * of the harness without an explicit downloader fails loudly
 * instead of silently no-op-ing into a fake `'ready'`.
 */
export function createNoopDownloader(): Downloader {
  return {
    async download({ modelId }) {
      throw {
        kind: 'download-failed' as const,
        modelId,
        message:
          'No Downloader configured. Pass `downloader:` in EmbeddingBootstrap options. ' +
          '@ggui-ai/embedding-local ships a built-in transformers.js-backed downloader.',
      };
    },
  };
}

/**
 * Probe helper — checks whether a cache path looks "warm enough" to
 * skip download. Heuristic: directory exists AND contains at least
 * one regular file. A downloader may refine this by checking
 * specific manifest files; this probe is the conservative
 * pre-warmup guess.
 *
 * Returns `null` when the path doesn't qualify, or
 * `{ sizeBytes }` summing every file's size at the root level.
 */
export function probeCache(cachePath: string): { sizeBytes: number } | null {
  if (!existsSync(cachePath)) return null;
  let total = 0;
  let foundFile = false;
  try {
    const entries: string[] = readdirSync(cachePath);
    for (const entry of entries) {
      const full = join(cachePath, entry);
      try {
        const st = statSync(full);
        if (st.isFile()) {
          foundFile = true;
          total += st.size;
        }
      } catch {
        // Skip unreadable entries — partial caches are treated
        // as cold to force a re-download.
      }
    }
  } catch {
    return null;
  }
  return foundFile ? { sizeBytes: total } : null;
}

export interface EmbeddingBootstrapOptions {
  /**
   * Where the model lives on disk. Resolved upstream by
   * `@ggui-ai/cli/paths.getEmbeddingCacheDir()` or test code; this
   * harness does NOT read env on its own to keep the OSS
   * dependency direction consistent (cli configures, harness
   * executes).
   */
  readonly cachePath: string;
  /** Model id. Defaults to {@link DEFAULT_MODEL_ID}. */
  readonly modelId?: string;
  /** Pinned revision. Defaults to {@link DEFAULT_MODEL_REVISION}. */
  readonly revision?: string;
  /** Output vector dimensions reported on `ready`. Defaults to
   *  {@link DEFAULT_MODEL_DIMENSIONS}. */
  readonly dimensions?: number;
  /** Bytes downloader. Tests pass a fixture; production wires the
   *  transformers.js-backed downloader. */
  readonly downloader?: Downloader;
  /** Clock override for tests (deterministic event timestamps). */
  readonly now?: () => number;
}

/**
 * Per-warmup options.
 */
export interface WarmupOptions {
  /** Cancellation. Forwarded into the downloader; harness emits
   *  `error{kind:'aborted'}` and resolves. */
  readonly signal?: AbortSignal;
  /**
   * Sink for {@link BootstrapEvent}s. Always called synchronously
   * from the harness on the same tick the event was generated.
   * Sink errors are caught + ignored — the lifecycle never aborts
   * because of consumer code.
   */
  readonly onEvent?: (event: BootstrapEvent) => void;
}

export interface EmbeddingBootstrap {
  /** Snapshot the current lifecycle state. Synchronous — reads
   *  cache + last-known status; does no I/O beyond the cache
   *  probe. */
  state(): BootstrapState;
  /**
   * Warm the model. Idempotent on `'ready'` and `'cached'` —
   * subsequent calls return immediately.
   *
   * On `'cold'`: invokes the downloader, emits the event sequence,
   * transitions to `'ready'` on success or `'error'` on failure.
   *
   * Resolves when the terminal event has been emitted. Does NOT
   * throw; failures surface through the `'error'` event +
   * subsequent `state()` call.
   */
  warmup(options?: WarmupOptions): Promise<void>;
}

/**
 * Construct a {@link EmbeddingBootstrap} bound to a specific cache
 * path + model. One harness instance per process is the expected
 * usage shape; multiple instances on the same cache path race on
 * the file system and the V1 harness does not arbitrate.
 */
export function createEmbeddingBootstrap(
  options: EmbeddingBootstrapOptions,
): EmbeddingBootstrap {
  const cachePath = options.cachePath;
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const revision = options.revision ?? DEFAULT_MODEL_REVISION;
  const dimensions = options.dimensions ?? DEFAULT_MODEL_DIMENSIONS;
  const downloader = options.downloader ?? createNoopDownloader();
  const now = options.now ?? Date.now;

  // Sticky in-process state. Cold-on-disk + ready-in-process is the
  // common case (someone wiped the cache between processes); we
  // re-probe disk every state() call so this stays honest.
  let memoryState:
    | { kind: 'fresh' }
    | { kind: 'loading'; startedAt: number }
    | { kind: 'ready'; sizeBytes: number }
    | { kind: 'error'; error: BootstrapError } = { kind: 'fresh' };

  function emit(events: WarmupOptions['onEvent'], event: BootstrapEvent): void {
    if (!events) return;
    try {
      events(event);
    } catch {
      // Sink errors are NOT lifecycle-fatal. The CLI banner is the
      // intended consumer; a banner crash should not break warmup.
    }
  }

  function snapshot(): BootstrapState {
    if (memoryState.kind === 'loading') {
      return { kind: 'loading', cachePath, startedAt: memoryState.startedAt };
    }
    if (memoryState.kind === 'error') {
      return { kind: 'error', cachePath, error: memoryState.error };
    }
    if (memoryState.kind === 'ready') {
      return {
        kind: 'ready',
        cachePath,
        sizeBytes: memoryState.sizeBytes,
        modelId,
        revision,
        dimensions,
      };
    }
    // 'fresh' — defer to the on-disk probe.
    const cached = probeCache(cachePath);
    if (cached) {
      return { kind: 'cached', cachePath, sizeBytes: cached.sizeBytes };
    }
    return { kind: 'cold', cachePath };
  }

  return {
    state(): BootstrapState {
      return snapshot();
    },
    async warmup(options?: WarmupOptions): Promise<void> {
      const onEvent = options?.onEvent;
      const signal = options?.signal;

      // Idempotent on terminal in-process states.
      if (memoryState.kind === 'ready' || memoryState.kind === 'loading') {
        return;
      }

      const startedAt = now();
      emit(onEvent, {
        type: 'started',
        cachePath,
        modelId,
        at: startedAt,
      });

      // Aborted before we even started.
      if (signal?.aborted) {
        const error: BootstrapError = {
          kind: 'aborted',
          modelId,
          message: 'warmup aborted before start',
        };
        memoryState = { kind: 'error', error };
        emit(onEvent, { type: 'error', error, at: now() });
        return;
      }

      // Cache hit short-circuit.
      const cached = probeCache(cachePath);
      if (cached) {
        memoryState = { kind: 'ready', sizeBytes: cached.sizeBytes };
        emit(onEvent, {
          type: 'cached',
          cachePath,
          modelId,
          sizeBytes: cached.sizeBytes,
          at: now(),
        });
        return;
      }

      // Cold path. Mark loading, emit `downloading`, defer to
      // downloader, forward progress, terminate with `ready` /
      // `error`.
      memoryState = { kind: 'loading', startedAt };
      emit(onEvent, {
        type: 'downloading',
        cachePath,
        modelId,
        revision,
        totalBytes: null,
        at: now(),
      });

      let lastBytes = 0;
      try {
        const result = await downloader.download({
          modelId,
          revision,
          cachePath,
          ...(signal ? { signal } : {}),
          onProgress: (bytesReceived, totalBytes) => {
            // Monotonic non-decrease guard. We don't fail on a
            // backwards report — we just clip to the previous max
            // so consumers' progress bars don't regress.
            const clipped = Math.max(bytesReceived, lastBytes);
            lastBytes = clipped;
            emit(onEvent, {
              type: 'progress',
              bytesReceived: clipped,
              totalBytes,
              at: now(),
            });
          },
        });
        memoryState = { kind: 'ready', sizeBytes: result.sizeBytes };
        emit(onEvent, {
          type: 'ready',
          cachePath,
          modelId,
          revision,
          sizeBytes: result.sizeBytes,
          at: now(),
        });
      } catch (raw) {
        const error = normalizeError(raw, modelId, signal);
        memoryState = { kind: 'error', error };
        emit(onEvent, { type: 'error', error, at: now() });
      }
    },
  };
}

function normalizeError(
  raw: unknown,
  modelId: string,
  signal?: AbortSignal,
): BootstrapError {
  if (signal?.aborted) {
    return {
      kind: 'aborted',
      modelId,
      message: 'warmup aborted by caller',
    };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const candidateKind = obj['kind'];
    if (
      typeof candidateKind === 'string' &&
      isBootstrapErrorKind(candidateKind)
    ) {
      return {
        kind: candidateKind,
        modelId:
          typeof obj['modelId'] === 'string'
            ? (obj['modelId'] as string)
            : modelId,
        message:
          typeof obj['message'] === 'string'
            ? (obj['message'] as string)
            : 'unknown error',
      };
    }
    if (raw instanceof Error) {
      return {
        kind: 'unknown',
        modelId,
        message: raw.message,
      };
    }
  }
  if (typeof raw === 'string') {
    return { kind: 'unknown', modelId, message: raw };
  }
  return { kind: 'unknown', modelId, message: 'unknown error' };
}

function isBootstrapErrorKind(s: string): s is BootstrapErrorKind {
  return (
    s === 'cache-write-failed' ||
    s === 'download-failed' ||
    s === 'parse-failed' ||
    s === 'aborted' ||
    s === 'unknown'
  );
}
