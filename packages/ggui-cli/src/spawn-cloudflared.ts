/**
 * `spawnCloudflaredTunnel` — auto-tunnel helper for `ggui serve --public`.
 *
 * The local-dev → claude.ai integration loop has a well-known trap:
 * every demo session would otherwise need to manually run
 * `cloudflared tunnel --url http://localhost:6781`, grep the URL from
 * its noisy stderr, then restart `ggui serve --public-base-url <url>`
 * with that value pinned. `runtimeUrl` is auto-derived from
 * `X-Forwarded-Host` and no longer depends on `publicBaseUrl`, but
 * production deployments still need the URL pinned for OAuth callbacks
 * and email magic-links. This helper closes the gap: one `--public`
 * flag spawns cloudflared, parses its URL, and threads it into the
 * boot config.
 *
 * **Trust posture.** This helper does NOT mask the public exposure. It
 * is the operator's explicit opt-in (`--public`); when combined with
 * `--dev-allow-all` the CLI front-end requires a second flag
 * (`--i-know-its-public`) to prevent accidentally serving any-bearer
 * auth over the internet.
 *
 * **Process management.** The spawned child is the operator's only
 * dependency on the host's `cloudflared` binary; we don't bundle it.
 * On `close()`, SIGTERM → SIGKILL fallback after 5s. AbortSignal
 * support lets the CLI lifecycle (Ctrl-C handler in `runServe`)
 * tear down cloudflared in lockstep with the server.
 */

import { spawn, type ChildProcess } from 'node:child_process';

/** Configured upper bound on how long we wait for cloudflared to
 *  print its public URL. Cold quick-tunnel typically takes 2-5s;
 *  setting too low surfaces a flaky "no URL detected" error to the
 *  operator before the tunnel actually fails. 30s is generous. */
const DEFAULT_URL_TIMEOUT_MS = 30_000;

/** Matcher for the trycloudflare URL inside cloudflared's stderr.
 *  cloudflared's exact log format has been stable since 2023; if it
 *  changes, this regex is the single point of impact. */
const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export interface SpawnCloudflaredOptions {
  /** Local port the tunnel forwards to. */
  readonly port: number;
  /** Optional override of the binary path. Defaults to `cloudflared`
   *  on PATH; operators wrap with `--cloudflared-bin <path>` when
   *  installed outside PATH. */
  readonly binary?: string;
  /** Optional AbortSignal — fires SIGTERM on the child when aborted. */
  readonly signal?: AbortSignal;
  /** Optional logger seam. Default no-op. */
  readonly onLog?: (line: string) => void;
  /** URL-detection timeout. */
  readonly urlTimeoutMs?: number;
}

export interface SpawnCloudflaredResult {
  /** Public `https://<random>.trycloudflare.com` URL extracted from
   *  cloudflared's stderr. */
  readonly url: string;
  /** Tear down the tunnel. Idempotent; safe to call multiple times. */
  close(): Promise<void>;
}

/**
 * Spawn `cloudflared tunnel --url http://localhost:<port>` and resolve
 * with the assigned trycloudflare URL. Rejects when:
 *
 *   - The binary can't be spawned (cloudflared not installed / wrong
 *     path / permission denied). Error message includes the install
 *     hint.
 *   - cloudflared exits before printing a URL. Error includes any
 *     captured stderr tail.
 *   - URL detection times out. Error includes elapsed time + last
 *     ~10 lines of stderr so the operator can diagnose.
 */
export function spawnCloudflaredTunnel(
  opts: SpawnCloudflaredOptions,
): Promise<SpawnCloudflaredResult> {
  const binary = opts.binary ?? 'cloudflared';
  const port = opts.port;
  const timeout = opts.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS;
  const log = opts.onLog ?? (() => {});

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(
        binary,
        ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      reject(
        new Error(
          `Failed to spawn ${binary}: ${(err as Error).message}. ` +
            `Install cloudflared from https://github.com/cloudflare/cloudflared/releases.`,
        ),
      );
      return;
    }

    // Tail buffer for error context — cap so a chatty cloudflared
    // version doesn't balloon memory.
    const stderrTail: string[] = [];
    const MAX_TAIL = 50;

    let url: string | undefined;
    let urlResolved = false;
    let closed = false;
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      if (!urlResolved) {
        reject(
          new Error(
            `cloudflared did not emit a tunnel URL within ${timeout}ms. ` +
              `Last stderr lines:\n${stderrTail.slice(-10).join('\n')}`,
          ),
        );
        void close();
      }
    }, timeout);

    function handleLine(line: string): void {
      log(line);
      stderrTail.push(line);
      if (stderrTail.length > MAX_TAIL) {
        stderrTail.shift();
      }
      if (urlResolved) return;
      const match = line.match(TRYCLOUDFLARE_URL_RE);
      if (match) {
        url = match[0];
        urlResolved = true;
        clearTimeout(timer);
        resolve({
          url,
          close,
        });
      }
    }

    // cloudflared logs to BOTH stdout and stderr depending on version
    // — wire both through the same line-handler so the regex catches
    // wherever it lands.
    function attachLineReader(stream: NodeJS.ReadableStream): void {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl).trimEnd();
          buf = buf.slice(nl + 1);
          if (line.length > 0) handleLine(line);
          nl = buf.indexOf('\n');
        }
      });
    }
    if (child.stderr) attachLineReader(child.stderr);
    if (child.stdout) attachLineReader(child.stdout);

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!urlResolved) {
        reject(
          new Error(
            `cloudflared spawn error: ${err.message}. ` +
              `Verify the binary is installed and executable.`,
          ),
        );
      }
    });

    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      if (!urlResolved) {
        reject(
          new Error(
            `cloudflared exited (code=${code}, signal=${sig}) before ` +
              `emitting a tunnel URL (elapsed ${Date.now() - startedAt}ms). ` +
              `Last stderr lines:\n${stderrTail.slice(-10).join('\n')}`,
          ),
        );
      }
    });

    function close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolveClose) => {
        if (child.killed || child.exitCode !== null) {
          resolveClose();
          return;
        }
        const killTimer = setTimeout(() => {
          if (!child.killed && child.exitCode === null) {
            child.kill('SIGKILL');
          }
        }, 5000);
        child.once('exit', () => {
          clearTimeout(killTimer);
          resolveClose();
        });
        child.kill('SIGTERM');
      });
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        void close();
      } else {
        opts.signal.addEventListener('abort', () => void close(), {
          once: true,
        });
      }
    }
  });
}
