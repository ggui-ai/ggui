/**
 * Timing for the host simulator's `ui://` shell reads (ggui#1822).
 *
 * A shell is a ~1.2 MB body. On a slow long-haul path the body can take
 * longer to arrive than a server-side regression would ever cause, so one
 * end-to-end timeout either hides a slow server or fails on a slow path. The
 * read is split into two budgets:
 *
 *   - **first byte**: from sending the request to the first byte of the
 *     response body. This is the server's own latency, and the path barely
 *     moves it. The gate is tight and fixed in code
 *     ({@link FIRST_BYTE_TIMEOUT_MS}).
 *   - **body**: the whole read, including the drain of the body. The default
 *     is 60 s; a workflow can raise it for a runner class with a slow path to
 *     the server through {@link BODY_TIMEOUT_ENV}.
 *
 * Each read is measured (first byte, drain, bytes, content type and
 * encoding) and the numbers are written to stderr and, on a GitHub Actions
 * runner, to the step summary. The drain is recorded, never gated: the size of
 * the body is gated where it is built (the iframe-runtime bundle budget).
 */
import { appendFileSync } from "node:fs";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Env var holding the shell read's whole-read budget, in milliseconds. */
export const BODY_TIMEOUT_ENV = "GGUI_E2E_BODY_TIMEOUT_MS";

/** The whole-read budget when {@link BODY_TIMEOUT_ENV} is unset: the MCP SDK's default request timeout. */
export const DEFAULT_BODY_TIMEOUT_MS = 60_000;

/**
 * The first-byte gate. A shell read's server time is well under a second; 15 s
 * leaves room for a few lost packets on a slow path and still fails a server
 * that stops answering long before the body budget would.
 */
export const FIRST_BYTE_TIMEOUT_MS = 15_000;

/**
 * The whole-read budget from {@link BODY_TIMEOUT_ENV}. Unset means
 * {@link DEFAULT_BODY_TIMEOUT_MS}; any other value must be a positive integer
 * of milliseconds, and anything else throws rather than falling back, so a
 * mistyped workflow value cannot quietly run with the default.
 */
export function readBodyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[BODY_TIMEOUT_ENV];
  if (raw === undefined) return DEFAULT_BODY_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${BODY_TIMEOUT_ENV} must be a positive integer of milliseconds; got "${raw}"`);
  }
  return Number(raw);
}

/** What one shell read measured. Times are in milliseconds from the send. */
export interface ShellReadRecord {
  readonly uri: string;
  readonly runner: string;
  readonly outcome: "ok" | "failed";
  /** Send → response headers; `null` when no headers arrived. */
  readonly headersMs: number | null;
  /** Send → first body byte; `null` when none arrived. */
  readonly firstByteMs: number | null;
  /** First body byte → last body byte received; `null` when no byte arrived. */
  readonly drainMs: number | null;
  /** Send → end of the read (resolved or failed). */
  readonly totalMs: number;
  /** Body bytes received, after any content decoding. */
  readonly bytes: number;
  readonly contentType: string | null;
  /** The response's `content-encoding`; `null` is an uncompressed body. */
  readonly contentEncoding: string | null;
  readonly firstByteBudgetMs: number;
  readonly bodyBudgetMs: number;
}

/** One armed read: the timestamps the fetch wrapper fills in. */
export class ShellReadProbe {
  readonly abort = new AbortController();
  private readonly sentAt = Date.now();
  private headersAt: number | null = null;
  private firstByteAt: number | null = null;
  private lastByteAt: number | null = null;
  private bytes = 0;
  private contentType: string | null = null;
  private contentEncoding: string | null = null;
  private readonly firstByteTimer: ReturnType<typeof setTimeout>;

  constructor(
    readonly firstByteBudgetMs: number,
    readonly bodyBudgetMs: number,
  ) {
    this.firstByteTimer = setTimeout(() => {
      this.abort.abort(
        new Error(
          `no response body byte within the ${firstByteBudgetMs} ms first-byte gate` +
            (this.headersAt === null ? " (no response headers either)" : ` (headers after ${this.headersAt - this.sentAt} ms)`),
        ),
      );
    }, firstByteBudgetMs);
  }

  onHeaders(res: Response): void {
    this.headersAt = Date.now();
    this.contentType = res.headers.get("content-type");
    this.contentEncoding = res.headers.get("content-encoding");
  }

  onChunk(byteLength: number): void {
    const now = Date.now();
    if (this.firstByteAt === null) {
      this.firstByteAt = now;
      clearTimeout(this.firstByteTimer);
    }
    this.lastByteAt = now;
    this.bytes += byteLength;
  }

  /** Stop the first-byte timer and say what was measured. */
  finish(uri: string, runner: string, outcome: "ok" | "failed"): ShellReadRecord {
    clearTimeout(this.firstByteTimer);
    const since = (t: number | null): number | null => (t === null ? null : t - this.sentAt);
    return {
      uri,
      runner,
      outcome,
      headersMs: since(this.headersAt),
      firstByteMs: since(this.firstByteAt),
      drainMs: this.firstByteAt === null || this.lastByteAt === null ? null : this.lastByteAt - this.firstByteAt,
      totalMs: Date.now() - this.sentAt,
      bytes: this.bytes,
      contentType: this.contentType,
      contentEncoding: this.contentEncoding,
      firstByteBudgetMs: this.firstByteBudgetMs,
      bodyBudgetMs: this.bodyBudgetMs,
    };
  }
}

/**
 * The fetch the simulator's MCP transport uses. It passes every request
 * through unchanged, except the one `resources/read` POST a probe is armed for:
 * that one gets the probe's abort signal and a body that is counted as it
 * streams.
 */
export class ShellReadMeter {
  private armed: ShellReadProbe | null = null;

  /** Arm a probe for the next `resources/read` request. */
  arm(firstByteBudgetMs: number, bodyBudgetMs: number): ShellReadProbe {
    const probe = new ShellReadProbe(firstByteBudgetMs, bodyBudgetMs);
    this.armed = probe;
    return probe;
  }

  disarm(probe: ShellReadProbe): void {
    if (this.armed === probe) this.armed = null;
  }

  readonly fetch: FetchLike = async (url, init) => {
    const probe = this.armed;
    if (probe === null || !isResourcesRead(init)) return fetch(url, init);
    this.armed = null;
    const signal = init?.signal ? AbortSignal.any([init.signal, probe.abort.signal]) : probe.abort.signal;
    const res = await fetch(url, { ...init, signal });
    probe.onHeaders(res);
    if (res.body === null) return res;
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          probe.onChunk(chunk.byteLength);
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** The transport sends one JSON-RPC message per POST, serialized by itself. */
function isResourcesRead(init: RequestInit | undefined): boolean {
  if (init?.method !== "POST" || typeof init.body !== "string") return false;
  const message: unknown = JSON.parse(init.body);
  return typeof message === "object" && message !== null && (message as { method?: unknown }).method === "resources/read";
}

/** `first byte 312 ms, drain 2140 ms, 1235392 bytes, gzip` — the record on one line. */
export function describeShellRead(r: ShellReadRecord): string {
  const ms = (v: number | null): string => (v === null ? "none" : `${v} ms`);
  return (
    `first byte ${ms(r.firstByteMs)} (gate ${r.firstByteBudgetMs} ms), drain ${ms(r.drainMs)}, ` +
    `total ${r.totalMs} ms (budget ${r.bodyBudgetMs} ms), ${r.bytes} bytes, ` +
    `${r.contentType ?? "no content-type"}, ${r.contentEncoding ?? "uncompressed"}`
  );
}

/**
 * Write the record: a `key=value` line on stderr, and on a GitHub Actions
 * runner one line in the step summary, so the drain time is a number in the
 * run record without opening the log.
 */
export function reportShellRead(r: ShellReadRecord): void {
  process.stderr.write(
    `[host-simulator] resources/read timing uri=${r.uri} runner=${r.runner} outcome=${r.outcome}` +
      ` headers_ms=${r.headersMs ?? "none"} first_byte_ms=${r.firstByteMs ?? "none"} drain_ms=${r.drainMs ?? "none"}` +
      ` total_ms=${r.totalMs} bytes=${r.bytes} content_type=${r.contentType ?? "none"}` +
      ` content_encoding=${r.contentEncoding ?? "none"} first_byte_gate_ms=${r.firstByteBudgetMs} body_budget_ms=${r.bodyBudgetMs}\n`,
  );
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") {
    appendFileSync(summary, `- shell read \`${r.uri}\` on ${r.runner}, ${r.outcome}: ${describeShellRead(r)}\n`);
  }
}
