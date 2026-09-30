/**
 * ggui#1631 — `GguiServer.close()` is graceful for a bounded time, then ends
 * the connections still open. Node's `http.Server.close()` closes idle
 * connections but waits for active ones, so a client that never finishes
 * its request (or never reads a response) used to hold `close()` open with
 * no bound. The stalled client here is a raw socket that sent half a
 * request: Node counts it active, not idle.
 */
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGguiServer, type GguiServer } from "./server.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

let server: GguiServer | null = null;
let stalled: Socket | null = null;
afterEach(async () => {
  stalled?.destroy();
  stalled = null;
  await server?.close({ graceMs: 0 });
  server = null;
});

async function bootWithStalledClient(): Promise<GguiServer> {
  const s = createGguiServer({ logger: silentLogger });
  const http = await s.listen(0, "127.0.0.1");
  const addr = http.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  const connected = new Promise<void>((resolve) => http.once("connection", () => resolve()));
  stalled = connect(addr.port, "127.0.0.1");
  // Half a request: no terminating blank line, so the server keeps waiting for it.
  stalled.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n");
  await connected;
  return s;
}

const within = <T>(ms: number, p: Promise<T>): Promise<"done" | "pending"> =>
  Promise.race([p.then(() => "done" as const), new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);

describe("GguiServer.close() is bounded (ggui#1631)", () => {
  it("with a stalled client, close({ graceMs }) ends the connection after the grace and resolves", async () => {
    server = await bootWithStalledClient();
    const t0 = Date.now();
    await server.close({ graceMs: 200 });
    expect(Date.now() - t0).toBeLessThan(3000);
    server = null;
  });

  it("control: with graceMs Infinity the same stalled client holds close() open, as an unbounded close did", async () => {
    server = await bootWithStalledClient();
    const closing = server.close({ graceMs: Number.POSITIVE_INFINITY });
    expect(await within(1000, closing)).toBe("pending");
    stalled?.destroy();
    await closing;
    server = null;
  });

  it("the default grace bounds it too", async () => {
    server = await bootWithStalledClient();
    const t0 = Date.now();
    await server.close();
    expect(Date.now() - t0).toBeLessThan(8000);
    server = null;
  }, 15_000);

  it("with no client, close() resolves at once, and a second close() is a no-op", async () => {
    server = createGguiServer({ logger: silentLogger });
    await server.listen(0, "127.0.0.1");
    expect(await within(500, server.close())).toBe("done");
    expect(await within(500, server.close())).toBe("done");
    server = null;
  });
});
