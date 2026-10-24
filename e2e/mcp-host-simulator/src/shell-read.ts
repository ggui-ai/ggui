/**
 * Timing for the host simulator's `ui://` shell reads (ggui#1822).
 *
 * A shell is a ~1.2 MB body. On a slow long-haul path the body can take
 * longer to arrive than a server-side regression would ever cause, so one
 * end-to-end timeout either hides a slow server or fails on a slow path. The
 * read is split into two budgets:
 *
 *   - **first byte**: from writing the request onto its connection to the
 *     first byte of the response body. This is the server's own latency, and
 *     the path barely moves it. The gate is tight and fixed in code
 *     ({@link FIRST_BYTE_TIMEOUT_MS}). It starts at the write, not when the
 *     request is created: opening a new connection is the path's time, and a
 *     lossy line can spend 10 s or more on it in SYN retransmits (ggui#1935).
 *     The connect has its own budget, the HTTP client's connect timeout.
 *   - **body**: the whole read, including the drain of the body. The default
 *     is 60 s; a workflow can raise it for a runner class with a slow path to
 *     the server through {@link BODY_TIMEOUT_ENV}.
 *
 * Each read is measured (first byte, drain, bytes, content type and
 * encoding) and the numbers are written to stderr and, on a GitHub Actions
 * runner, to the step summary. The drain is recorded, never gated: the size of
 * the body is gated where it is built (the iframe-runtime bundle budget).
 */
import diagnosticsChannel from "node:diagnostics_channel";
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
 * The request header that ties a POST to undici's diagnostics events, so the
 * meter knows when that request was written and on which connection. Its value
 * is `<meter>.<sequence>`, unique in the process. It changes nothing the server
 * does.
 */
export const REQUEST_TAG_HEADER = "x-ggui-host-sim-request";

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

/**
 * How a request's transfer ended: `ok` when the body ended, `failed` when it
 * broke off or the request never got headers, `cancelled` when the reader
 * stopped reading after the headers: the MCP SDK does for a `202` to a
 * notification, whose body it never reads, and its close() aborts any body
 * still open, often a stream whose answer has already arrived. A body the
 * caller's own signal ended is `cancelled`; the line's bytes and phase times
 * still say how far it got.
 */
export type RequestOutcome = "ok" | "failed" | "cancelled";

/** What one shell read measured. Times are in milliseconds from the send. */
export interface ShellReadRecord {
  readonly uri: string;
  readonly runner: string;
  readonly outcome: RequestOutcome;
  /** Send → the request written onto its connection; `null` when it never was. */
  readonly writtenMs: number | null;
  /** `new` when a connection was opened for this request, `reused` when it rode an open one, `null` when unwritten. */
  readonly connection: "new" | "reused" | null;
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
 * One MCP POST as the fetch wrapper saw it: when it was written onto its
 * connection (and whether that connection was opened for it), when the
 * headers, the first body byte and the last body byte arrived, and how many
 * bytes. A probe the simulator arms for a shell read also carries the
 * first-byte gate: once the request is written, it aborts the request when no
 * body byte arrives in time. Every other request gets a passive probe, which
 * measures and never aborts.
 */
export class RequestProbe {
  readonly abort = new AbortController();
  readonly sentAt = Date.now();
  private writtenAt: number | null = null;
  private connectedAt: number | null = null;
  private headersAt: number | null = null;
  private firstByteAt: number | null = null;
  private lastByteAt: number | null = null;
  private bytes = 0;
  private contentType: string | null = null;
  private contentEncoding: string | null = null;
  private status: number | null = null;
  private endedAt: number | null = null;
  private endError: unknown = undefined;
  private cancelled = false;
  private firstByteTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly headerWaiters: Array<(arrived: boolean) => void> = [];

  constructor(
    /** The JSON-RPC method, or `"(unparsed)"` when the body was not one request. */
    readonly method: string,
    /** The first-byte gate in ms, or `null` for a passive probe. */
    readonly firstByteBudgetMs: number | null,
    readonly bodyBudgetMs: number | null,
    /** For `tools/call`, the tool's name; `null` otherwise. */
    readonly toolName: string | null = null,
  ) {}

  /**
   * The request was written onto a connection. `socketConnectedAt` is when that
   * connection finished opening: at or after {@link sentAt} means it was opened
   * for this request. The first-byte gate starts here.
   */
  onWritten(socketConnectedAt: number | null): void {
    if (this.writtenAt !== null) return;
    this.writtenAt = Date.now();
    if (socketConnectedAt !== null && socketConnectedAt >= this.sentAt) this.connectedAt = socketConnectedAt;
    const budget = this.firstByteBudgetMs;
    if (budget === null || this.firstByteAt !== null || this.endedAt !== null) return;
    this.firstByteTimer = setTimeout(() => {
      this.abort.abort(
        new Error(
          `no response body byte within the ${budget} ms first-byte gate, counted from the write` +
            ` (${this.describeWrite()}` +
            (this.headersAt === null ? ", no response headers either)" : `, headers after ${this.headersAt - this.sentAt} ms)`),
        ),
      );
    }, budget);
  }

  onHeaders(res: Response): void {
    this.headersAt = Date.now();
    this.status = res.status;
    this.contentType = res.headers.get("content-type");
    this.contentEncoding = res.headers.get("content-encoding");
    this.settleHeaderWaiters(true);
  }

  onChunk(byteLength: number): void {
    const now = Date.now();
    if (this.firstByteAt === null) {
      this.firstByteAt = now;
      this.clearGate();
    }
    this.lastByteAt = now;
    this.bytes += byteLength;
  }

  /** The body ended (`error` undefined), failed, or (`cancelled`) the reader stopped reading it. */
  onEnd(error?: unknown, cancelled = false): void {
    if (this.endedAt !== null) return;
    this.endedAt = Date.now();
    this.endError = error;
    this.cancelled = cancelled;
    this.clearGate();
    this.settleHeaderWaiters(false);
  }

  /**
   * Resolves `true` once the response headers arrived, `false` if the request
   * ended without them. It never rejects. For a streamed answer the server
   * sends its headers as the handler starts, so `true` means the server has
   * the request.
   */
  headersArrived(): Promise<boolean> {
    if (this.headersAt !== null) return Promise.resolve(true);
    if (this.endedAt !== null) return Promise.resolve(false);
    return new Promise((resolve) => this.headerWaiters.push(resolve));
  }

  get ended(): boolean {
    return this.endedAt !== null;
  }

  get error(): unknown {
    return this.endError;
  }

  get outcome(): RequestOutcome {
    if (this.cancelled) return "cancelled";
    return this.endError === undefined && this.endedAt !== null ? "ok" : "failed";
  }

  /** The HTTP status, or `null` before the headers arrived. */
  get httpStatus(): number | null {
    return this.status;
  }

  /** Stop the first-byte timer and say what was measured. */
  finish(uri: string, runner: string, outcome: RequestOutcome): ShellReadRecord {
    this.clearGate();
    const since = (t: number | null): number | null => (t === null ? null : t - this.sentAt);
    return {
      uri,
      runner,
      outcome,
      writtenMs: since(this.writtenAt),
      connection: this.writtenAt === null ? null : this.connectedAt === null ? "reused" : "new",
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
   * How far the request got, on one line: `tools/list sent 61012 ms ago:
   * written +10076 ms (new connection, connected +10075 ms), headers none, no
   * body byte, still open`. The phase it stopped in is what tells a connection
   * that took long to open from a request the server never answered, and both
   * from an answer that never finished.
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
        : this.cancelled
          ? `cancelled by the reader ${at(this.endedAt)}`
          : this.endError === undefined
            ? `ended ${at(this.endedAt)}`
            : `failed ${at(this.endedAt)}`;
    return (
      `${this.method} sent ${now - this.sentAt} ms ago: ${this.describeWrite()}, headers ${at(this.headersAt)}` +
      `${this.contentType === null ? "" : ` (${this.contentType})`}, ${body}, ${end}`
    );
  }

  /** `written +10076 ms (new connection, connected +10075 ms)`, `written +2 ms (reused connection)` or `not written`. */
  private describeWrite(): string {
    if (this.writtenAt === null) return "not written";
    const written = `written +${this.writtenAt - this.sentAt} ms`;
    return this.connectedAt === null
      ? `${written} (reused connection)`
      : `${written} (new connection, connected +${this.connectedAt - this.sentAt} ms)`;
  }

  private clearGate(): void {
    if (this.firstByteTimer !== null) clearTimeout(this.firstByteTimer);
    this.firstByteTimer = null;
  }

  private settleHeaderWaiters(arrived: boolean): void {
    for (const resolve of this.headerWaiters.splice(0)) resolve(arrived);
  }
}

/** Tag → probe, for every tagged POST still open in this process. */
const probesByTag = new Map<string, RequestProbe>();
/** When each socket finished connecting. undici publishes the same socket object on `connected` and `sendHeaders`. */
const socketConnectedAt = new WeakMap<object, number>();
let meterCount = 0;

/** The tag on an undici request's headers (a flat `[name, value, …]` array, or raw `name: value` lines). */
function requestTag(headers: unknown): string | null {
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === REQUEST_TAG_HEADER) return String(headers[i + 1]);
    }
    return null;
  }
  if (typeof headers === "string") {
    const line = headers.split("\r\n").find((l) => l.toLowerCase().startsWith(`${REQUEST_TAG_HEADER}:`));
    return line === undefined ? null : line.slice(REQUEST_TAG_HEADER.length + 1).trim();
  }
  return null;
}

diagnosticsChannel.subscribe("undici:client:connected", (message: unknown) => {
  const socket = (message as { socket?: unknown } | null)?.socket;
  if (typeof socket === "object" && socket !== null) socketConnectedAt.set(socket, Date.now());
});
diagnosticsChannel.subscribe("undici:client:sendHeaders", (message: unknown) => {
  const m = message as { request?: { headers?: unknown }; socket?: unknown } | null;
  const tag = requestTag(m?.request?.headers);
  if (tag === null) return;
  const probe = probesByTag.get(tag);
  if (probe === undefined) return;
  const socket = m?.socket;
  probe.onWritten(typeof socket === "object" && socket !== null ? (socketConnectedAt.get(socket) ?? null) : null);
});

/**
 * The fetch the simulator's MCP transport uses. Every POST passes through with
 * its body counted as it streams, and is timed by a probe: the probe armed for
 * the next `resources/read` (with its abort signal and first-byte gate), or a
 * passive one. Each POST carries {@link REQUEST_TAG_HEADER}, so undici's own
 * events say when it was written and whether a connection was opened for it.
 * Each finished POST other than an armed read logs one timing line; the
 * requests still in flight can be described when a call times out.
 */
export class RequestMeter {
  private armed: RequestProbe | null = null;
  private readonly inFlight = new Set<RequestProbe>();
  private readonly watchers: Array<{ method: string; toolName: string | null; resolve: (p: RequestProbe) => void }> = [];
  private readonly id = ++meterCount;
  private sequence = 0;

  /** Arm a probe for the next `resources/read` request. */
  arm(firstByteBudgetMs: number, bodyBudgetMs: number): RequestProbe {
    const probe = new RequestProbe("resources/read", firstByteBudgetMs, bodyBudgetMs);
    this.armed = probe;
    return probe;
  }

  disarm(probe: RequestProbe): void {
    if (this.armed === probe) this.armed = null;
  }

  /**
   * The probe of the next POST of `method` (and, for `tools/call`, of the tool
   * `toolName`) this meter sends. Register it before making the call, and
   * `cancel()` it once the call has settled, so a call that never posted
   * leaves no watcher behind to match a later one.
   */
  watchNext(method: string, toolName: string | null = null): { readonly probe: Promise<RequestProbe>; cancel(): void } {
    let entry: { method: string; toolName: string | null; resolve: (p: RequestProbe) => void } | undefined;
    const probe = new Promise<RequestProbe>((resolve) => {
      entry = { method, toolName, resolve };
      this.watchers.push(entry);
    });
    return {
      probe,
      cancel: () => {
        const at = entry === undefined ? -1 : this.watchers.indexOf(entry);
        if (at !== -1) this.watchers.splice(at, 1);
      },
    };
  }

  /** One line per POST still open, oldest first; empty when none is. */
  describeInFlight(): string[] {
    const now = Date.now();
    return [...this.inFlight].map((p) => p.describeProgress(now));
  }

  readonly fetch: FetchLike = async (url, init) => {
    if (init?.method !== "POST") return fetch(url, init);
    const { method, toolName } = jsonRpcMethod(init.body);
    const armed = method === "resources/read" ? this.armed : null;
    if (armed !== null) this.armed = null;
    const probe = armed ?? new RequestProbe(method, null, null, toolName);
    const passive = armed === null;
    const watcher = this.watchers.findIndex((w) => w.method === method && (w.toolName === null || w.toolName === toolName));
    if (watcher !== -1) this.watchers.splice(watcher, 1)[0]!.resolve(probe);
    const signal =
      armed === null ? init.signal : init.signal ? AbortSignal.any([init.signal, armed.abort.signal]) : armed.abort.signal;
    const tag = `${this.id}.${++this.sequence}`;
    const headers = new Headers(init.headers);
    headers.set(REQUEST_TAG_HEADER, tag);
    probesByTag.set(tag, probe);
    this.inFlight.add(probe);
    let reported = false;
    const done = (error?: unknown, cancelled = false): void => {
      if (reported) return;
      reported = true;
      probe.onEnd(error, cancelled);
      probesByTag.delete(tag);
      this.inFlight.delete(probe);
      if (passive) reportRequest(probe);
    };
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, ...(signal ? { signal } : {}) });
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
          // The caller's own signal ended the body (the MCP SDK's close()
          // aborts every open POST): the reader stopped, the wire did not fail.
          done(err, init.signal?.aborted === true);
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
        done(reason, true);
        return reader.cancel(reason);
      },
    });
    return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/**
 * The JSON-RPC method of a POST body the transport serialized itself (one
 * message per POST), and for `tools/call` the tool's name.
 */
function jsonRpcMethod(body: RequestInit["body"]): { method: string; toolName: string | null } {
  if (typeof body !== "string") return { method: "(unparsed)", toolName: null };
  const message: unknown = JSON.parse(body);
  if (typeof message !== "object" || message === null || Array.isArray(message)) return { method: "(batch)", toolName: null };
  const method = (message as { method?: unknown }).method;
  if (typeof method !== "string") return { method: "(response)", toolName: null };
  const name = (message as { params?: { name?: unknown } }).params?.name;
  return { method, toolName: method === "tools/call" && typeof name === "string" ? name : null };
}

/**
 * One stderr line per finished POST: the method, the HTTP status, the phases'
 * times, the bytes and the content type. `outcome` is the transfer's
 * ({@link RequestOutcome}).
 */
function reportRequest(p: RequestProbe): void {
  const r = p.finish("", process.env["RUNNER_NAME"] ?? "local", p.outcome);
  process.stderr.write(
    `[host-simulator] request timing method=${p.method} runner=${r.runner} outcome=${r.outcome}` +
      ` status=${p.httpStatus ?? "none"} written_ms=${r.writtenMs ?? "none"} connection=${r.connection ?? "none"} headers_ms=${r.headersMs ?? "none"} first_byte_ms=${r.firstByteMs ?? "none"} drain_ms=${r.drainMs ?? "none"}` +
      ` total_ms=${r.totalMs} bytes=${r.bytes} content_type=${r.contentType ?? "none"}` +
      ` content_encoding=${r.contentEncoding ?? "none"}\n`,
  );
}

/** `written 640 ms (new connection), first byte 912 ms, drain 2140 ms, 1235392 bytes, gzip` — the record on one line. */
export function describeShellRead(r: ShellReadRecord): string {
  const ms = (v: number | null): string => (v === null ? "none" : `${v} ms`);
  const written = r.writtenMs === null ? "not written" : `written ${r.writtenMs} ms (${r.connection} connection)`;
  return (
    `${written}, first byte ${ms(r.firstByteMs)} (gate ${r.firstByteBudgetMs} ms from the write), drain ${ms(r.drainMs)}, ` +
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
      ` written_ms=${r.writtenMs ?? "none"} connection=${r.connection ?? "none"} headers_ms=${r.headersMs ?? "none"} first_byte_ms=${r.firstByteMs ?? "none"} drain_ms=${r.drainMs ?? "none"}` +
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
