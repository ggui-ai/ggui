/**
 * Wait for a URL to answer `2xx`, and say why when it never does.
 *
 * The harness boots several local processes (the ggui servers, the todo
 * MCP, a sample agent) and polls each one until it answers. A bare
 * "timed out" cannot tell the three ways a boot fails apart, and each
 * needs a different fix:
 *
 * - nothing ever listened (`connection refused` to the end): the process
 *   crashed or never bound its port;
 * - it listened but answered non-`2xx` (`HTTP 503` to the end): it bound
 *   and was still getting ready;
 * - it accepted the connection and never answered (`no answer within …`):
 *   it hung.
 *
 * So the timeout error carries the last probe's outcome, the attempt
 * count, and when the first HTTP answer of any status came. On success the
 * caller gets the elapsed time and the attempt count, so green runs show
 * how close a boot sits to its limit.
 */

export interface WaitForUrlOptions {
  /** Overall budget, measured from the call. */
  readonly timeoutMs: number;
  /** Pause between probes. */
  readonly pollMs?: number;
  /** Longest a single probe may wait for an answer (capped by what is left of `timeoutMs`). */
  readonly attemptTimeoutMs?: number;
}

export interface UrlReady {
  /** Milliseconds from the call to the `2xx` answer. */
  readonly elapsedMs: number;
  /** Probes sent, the successful one included. */
  readonly attempts: number;
}

/** What one probe saw, as the timeout message words it. */
function describeFailure(err: unknown, attemptLimitMs: number): string {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return `no answer within ${attemptLimitMs}ms`;
  }
  const cause = err instanceof Error ? err.cause : undefined;
  const code =
    cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : undefined;
  if (code === 'ECONNREFUSED') return 'connection refused (ECONNREFUSED)';
  if (code !== undefined) return `fetch failed (${code})`;
  if (err instanceof Error) return `fetch failed (${err.name}: ${err.message})`;
  return `fetch failed (${String(err)})`;
}

export async function waitForUrl(
  url: string,
  opts: WaitForUrlOptions,
): Promise<UrlReady> {
  const pollMs = opts.pollMs ?? 250;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 2_000;
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  let attempts = 0;
  let last = 'no probe ran';
  let firstAnswerMs: number | undefined;

  while (Date.now() < deadline) {
    const limit = Math.max(1, Math.min(attemptTimeoutMs, deadline - Date.now()));
    attempts += 1;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(limit) });
      await resp.body?.cancel();
      firstAnswerMs ??= Date.now() - started;
      if (resp.ok) return { elapsedMs: Date.now() - started, attempts };
      last = `HTTP ${resp.status}`;
    } catch (err) {
      last = describeFailure(err, limit);
    }
    const pause = Math.min(pollMs, deadline - Date.now());
    if (pause > 0) await new Promise((r) => setTimeout(r, pause));
  }

  const answered =
    firstAnswerMs === undefined
      ? 'no HTTP answer'
      : `first HTTP answer at ${firstAnswerMs}ms`;
  throw new Error(
    `Timed out after ${opts.timeoutMs}ms waiting for ${url}: ` +
      `${attempts} attempts, last: ${last}, ${answered}`,
  );
}
