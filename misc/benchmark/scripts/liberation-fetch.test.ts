/**
 * ggui#2209 — the judge image's Liberation fetch survives a transient upstream failure and still fails closed.
 *
 * One github.com 504 on the release-attachment URL killed an image build: the fetch had no retry, and the apt layer
 * above it is often uncached, so most builds make the request. These pins run the EXACT `node -e` script the
 * Dockerfile's RUN line carries (read from the Dockerfile text) against a local server: network errors and 5xx retry,
 * with backoff, at most four attempts; a 4xx and a sha256 mismatch fail on the first response, so a changed artifact
 * never installs whatever the retry does.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dockerfile = readFileSync(resolve(import.meta.dirname, "..", "Dockerfile"), "utf8");
const RUN_LINE =
  /^RUN node -e "([^"]*)" "\$LIBERATION_URL" "\$LIBERATION_SHA256" (\/tmp\/liberation\.tgz) (\d+) (\d+) \\$/m;

/** The script exactly as the shell hands it to node: the RUN line's double-quoted `-e` argument. */
function fetchScript(): { script: string; out: string; backoffMs: number; timeoutMs: number } {
  const m = RUN_LINE.exec(dockerfile);
  if (m === null) throw new Error("the Dockerfile's Liberation RUN line no longer has the pinned shape");
  return { script: m[1], out: m[2], backoffMs: Number(m[3]), timeoutMs: Number(m[4]) };
}

const BODY = Buffer.from("liberation-fonts-ttf fixture bytes");
const SHA = createHash("sha256").update(BODY).digest("hex");

/**
 * One scripted response per request: an HTTP status (served with BODY, or `bytes`); "reset" (socket destroyed before
 * any response); "hang" (accepted, never answered); "short" (200 with content-length 1000, 10 bytes, then destroyed).
 */
type Step = number | "reset" | "hang" | "short" | { status: number; bytes: Buffer };

let server: Server | undefined;
let dir: string | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function run(steps: readonly Step[], sha = SHA): Promise<{ rc: number | null; requests: number; stderr: string; out: string }> {
  let requests = 0;
  server = createServer((req, res) => {
    const step = steps[Math.min(requests, steps.length - 1)];
    requests += 1;
    if (step === "reset") {
      req.socket.destroy();
      return;
    }
    if (step === "hang") return;
    if (step === "short") {
      res.writeHead(200, { "content-length": "1000" });
      res.write(BODY.subarray(0, 10));
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    const { status, bytes } = typeof step === "number" ? { status: step, bytes: BODY } : step;
    res.writeHead(status, { "content-type": "application/gzip" });
    res.end(bytes);
  });
  await new Promise<void>((ok) => server?.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  dir = mkdtempSync(join(tmpdir(), "liberation-fetch-"));
  const out = join(dir, "liberation.tgz");
  const { script } = fetchScript();
  // Backoff base 1 ms and a 300 ms per-attempt timeout here; the Dockerfile's own values are pinned below.
  const child = spawn(process.execPath, ["-e", script, `http://127.0.0.1:${port}/l.tgz`, sha, out, "1", "300"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const rc = await new Promise<number | null>((done) => child.on("close", done));
  return { rc, requests, stderr, out };
}

describe("judge image Liberation fetch (ggui#2209)", () => {
  it("the RUN line passes the output path, a 2 s backoff base and a 30 s per-attempt timeout; its script is shell-inert", () => {
    const { script, out, backoffMs, timeoutMs } = fetchScript();
    expect(out).toBe("/tmp/liberation.tgz");
    expect(backoffMs).toBe(2000);
    expect(timeoutMs).toBe(30000);
    // Nothing the shell would expand or unescape inside "…": the test runs exactly what the build runs.
    expect(script).not.toMatch(/[$`\\]/);
    // The tar step reads the same path the fetch writes.
    expect(dockerfile).toContain("tar -xzf /tmp/liberation.tgz");
  });

  it("a 504 then the artifact: retried, verified, written", async () => {
    const r = await run([504, 200]);
    expect(r.rc).toBe(0);
    expect(r.requests).toBe(2);
    expect(readFileSync(r.out)).toEqual(BODY);
    expect(r.stderr).toContain("liberation fetch attempt 1: 504; retrying");
  });

  it("a connection reset then the artifact: retried as a network error", async () => {
    const r = await run(["reset", 200]);
    expect(r.rc).toBe(0);
    expect(r.requests).toBe(2);
    expect(readFileSync(r.out)).toEqual(BODY);
  });

  it("a server that never answers: the attempt times out and is retried", async () => {
    const r = await run(["hang", 200]);
    expect(r.rc).toBe(0);
    expect(r.requests).toBe(2);
    expect(readFileSync(r.out)).toEqual(BODY);
    expect(r.stderr).toMatch(/liberation fetch attempt 1: .*; retrying/);
  });

  it("a body cut short of its content-length: a network error, retried (never handed to the sha check)", async () => {
    const r = await run(["short", 200]);
    expect(r.rc).toBe(0);
    expect(r.requests).toBe(2);
    expect(r.stderr).not.toContain("liberation sha256");
  });

  it("408 and 429 are transient: retried", async () => {
    for (const status of [408, 429]) {
      const r = await run([status, 200]);
      expect(r.rc, `status ${status}`).toBe(0);
      expect(r.requests, `status ${status}`).toBe(2);
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      server = undefined;
    }
  });

  it("5xx on every attempt: fails after exactly four requests, naming the status", async () => {
    const r = await run([503]);
    expect(r.rc).toBe(1);
    expect(r.requests).toBe(4);
    expect(r.stderr).toContain("liberation fetch 503");
    expect(existsSync(r.out)).toBe(false);
  });

  it("any other 4xx: fails on the first response, never retried", async () => {
    const r = await run([404, 200]);
    expect(r.rc).toBe(1);
    expect(r.requests).toBe(1);
    expect(r.stderr).toContain("liberation fetch 404");
    expect(existsSync(r.out)).toBe(false);
  });

  it("the wrong bytes: fails closed on the sha256, never retried, nothing written", async () => {
    const r = await run([{ status: 200, bytes: Buffer.from("not the artifact") }, 200]);
    expect(r.rc).toBe(1);
    expect(r.requests).toBe(1);
    expect(r.stderr).toContain("liberation sha256 ");
    expect(existsSync(r.out)).toBe(false);
  });
});
