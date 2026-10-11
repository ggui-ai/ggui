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

/**
 * One MCP POST as the fetch wrapper saw it: when the headers, the first body
 * byte and the last body byte arrived, and how many bytes. A probe the
 * simulator arms for a shell read also carries the first-byte gate: it aborts
 * the request when no body byte has arrived in time. Every other request gets
 * a passive probe, which measures and never aborts.
 */
export class RequestProbe {
  readonly abort = new AbortController();
  readonly sentAt = Date.now();
  private headersAt: number | null = null;
  private firstByteAt: number | null = null;
  private lastByteAt: number | null = null;
  private bytes = 0;
  private contentType: string | null = null;
  private contentEncoding: string | null = null;
  private status: number | null = null;
  private endedAt: number | null = null;
  private endError: unknown = undefined;
  private readonly firstByteTimer: ReturnType<typeof setTimeout> | null;

  constructor(
    /** The JSON-RPC method, or `"(unparsed)"` when the body was not one request. */
    readonly method: string,
    /** The first-byte gate in ms, or `null` for a passive probe. */
    readonly firstByteBudgetMs: number | null,
    readonly bodyBudgetMs: number | null,
  ) {
    this.firstByteTimer =
      firstByteBudgetMs === null
        ? null
        : setTimeout(() => {
            this.abort.abort(
              new Error(
                `no response body byte within the ${firstByteBudgetMs} ms first-byte gate` +
                  (this.headersAt === null
                    ? " (no response headers either)"
                    : ` (headers after ${this.headersAt - this.sentAt} ms)`),
              ),
            );
          }, firstByteBudgetMs);
  }

  onHeaders(res: Response): void {
    this.headersAt = Date.now();
    this.status = res.status;
    this.contentType = res.headers.get("content-type");
    this.contentEncoding = res.headers.get("content-encoding");
  }

  onChunk(byteLength: number): void {
    const now = Date.now();
    if (this.firstByteAt === null) {
      this.firstByteAt = now;
      if (this.firstByteTimer !== null) clearTimeout(this.firstByteTimer);
    }
    this.lastByteAt = now;
    this.bytes += byteLength;
  }

  /** The body ended (`error` undefined) or failed. */
  onEnd(error?: unknown): void {
    if (this.endedAt !== null) return;
    this.endedAt = Date.now();
    this.endError = error;
    if (this.firstByteTimer !== null) clearTimeout(this.firstByteTimer);
  }

  get ended(): boolean {
    return this.endedAt !== null;
  }

  get error(): unknown {
    return this.endError;
  }

  /** The HTTP status, or `null` before the headers arrived. */
  get httpStatus(): number | null {
    return this.status;
  }

  /** Stop the first-byte timer and say what was measured. */
  finish(uri: string, runner: string, outcome: "ok" | "failed"): ShellReadRecord {
    if (this.firstByteTimer !== null) clearTimeout(this.firstByteTimer);
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
      firstByteBudgetMs: this.firstByteBudgetMs ?? FIRST_BYTE_TIMEOUT_MS,
      bodyBudgetMs: this.bodyBudgetMs ?? DEFAULT_BODY_TIMEOUT_MS,
    };
  }

  /**
   * How far the request got, on one line: `tools/list +61012 ms: headers +140 ms
   * (text/event-stream), no body byte`. The phase it stopped in is what tells a
   * request that never reached the server from an answer that never finished.
   */
  describeProgress(now: number = Date.now()): string {
    const at = (t: number | null): string => (t === null ? "none" : `+${t - this.sentAt} ms`);
    const body =
      this.firstByteAt === null
        ? "no body byte"
        : `first body byte ${at(this.firstByteAt)}, ${this.bytes} bytes, last byte ${at(this.lastByteAt)}`;
    const end =
      this.endedAt === null
        ? "still open"
        : this.endError === undefined
          ? `ended ${at(this.endedAt)}`
          : `failed ${at(this.endedAt)}`;
    return (
      `${this.method} sent ${now - this.sentAt} ms ago: headers ${at(this.headersAt)}` +
      `${this.contentType === null ? "" : ` (${this.contentType})`}, ${body}, ${end}`
    );
  }
}

/**
 * The fetch the simulator's MCP transport uses. Every POST passes through with
 * its body counted as it streams, and is timed by a probe: the probe armed for
 * the next `resources/read` (with its abort signal and first-byte gate), or a
 * passive one. Each finished POST other than an armed read logs one timing
 * line; the requests still in flight can be described when a call times out.
 */
export class RequestMeter {
  private armed: RequestProbe | null = null;
  private readonly inFlight = new Set<RequestProbe>();

  /** Arm a probe for the next `resources/read` request. */
  arm(firstByteBudgetMs: number, bodyBudgetMs: number): RequestProbe {
    const probe = new RequestProbe("resources/read", firstByteBudgetMs, bodyBudgetMs);
    this.armed = probe;
    return probe;
  }

  disarm(probe: RequestProbe): void {
    if (this.armed === probe) this.armed = null;
  }

  /** One line per POST still open, oldest first; empty when none is. */
  describeInFlight(): string[] {
    const now = Date.now();
    return [...this.inFlight].map((p) => p.describeProgress(now));
  }

  readonly fetch: FetchLike = async (url, init) => {
    if (init?.method !== "POST") return fetch(url, init);
    const method = jsonRpcMethod(init.body);
    const armed = method === "resources/read" ? this.armed : null;
    if (armed !== null) this.armed = null;
    const probe = armed ?? new RequestProbe(method, null, null);
    const passive = armed === null;
    const signal =
      armed === null ? init.signal : init.signal ? AbortSignal.any([init.signal, armed.abort.signal]) : armed.abort.signal;
    this.inFlight.add(probe);
    const done = (error?: unknown): void => {
      probe.onEnd(error);
      this.inFlight.delete(probe);
      if (passive) reportRequest(probe);
    };
    let res: Response;
    try {
      res = await fetch(url, { ...init, ...(signal ? { signal } : {}) });
    } catch (err) {
      done(err);
      throw err;
    }
    probe.onHeaders(res);
    if (res.body === null) {
      done();
      return res;
    }
    const reader = res.body.getReader();
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          done(err);
          controller.error(err);
          return;
        }
        if (chunk.done) {
          done();
          controller.close();
          return;
        }
        probe.onChunk(chunk.value.byteLength);
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        done(reason ?? new Error("cancelled"));
        return reader.cancel(reason);
      },
    });
    return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** The JSON-RPC method of a POST body the transport serialized itself; one message per POST. */
function jsonRpcMethod(body: RequestInit["body"]): string {
  if (typeof body !== "string") return "(unparsed)";
  const message: unknown = JSON.parse(body);
  if (typeof message !== "object" || message === null || Array.isArray(message)) return "(batch)";
  const method = (message as { method?: unknown }).method;
  return typeof method === "string" ? method : "(response)";
}

/**
 * One stderr line per finished POST: the method, the HTTP status, the phases'
 * times, the bytes and the content type. `outcome` is the transfer's: `ok` when
 * the body ended, `failed` when it broke off or the request never got headers.
 */
function reportRequest(p: RequestProbe): void {
  const r = p.finish("", process.env["RUNNER_NAME"] ?? "local", p.error === undefined ? "ok" : "failed");
  process.stderr.write(
    `[host-simulator] request timing method=${p.method} runner=${r.runner} outcome=${r.outcome}` +
      ` status=${p.httpStatus ?? "none"} headers_ms=${r.headersMs ?? "none"} first_byte_ms=${r.firstByteMs ?? "none"} drain_ms=${r.drainMs ?? "none"}` +
      ` total_ms=${r.totalMs} bytes=${r.bytes} content_type=${r.contentType ?? "none"}` +
      ` content_encoding=${r.contentEncoding ?? "none"}\n`,
  );
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

/**
 * A failed MCP call and the POSTs still in flight when it failed, on stderr
 * and, on a GitHub Actions runner, in the step summary.
 */
export function reportInFlight(call: string, error: string, inFlight: readonly string[]): void {
  const runner = process.env["RUNNER_NAME"] ?? "local";
  const lines = inFlight.length > 0 ? inFlight : ["(no MCP POST in flight)"];
  process.stderr.write(
    `[host-simulator] ${call} failed on runner ${runner}: ${error}\n` +
      lines.map((l) => `[host-simulator]   in flight: ${l}\n`).join(""),
  );
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") {
    appendFileSync(
      summary,
      `- MCP \`${call}\` failed on ${runner}: ${error}\n` + lines.map((l) => `  - in flight: ${l}\n`).join(""),
    );
  }
}
