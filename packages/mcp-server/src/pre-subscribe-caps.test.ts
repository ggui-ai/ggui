/**
 * Pre-subscribe live-channel caps (ggui#444) — bound what a NOT-YET-
 * SUBSCRIBED (unauthenticated / unregistered) WebSocket can consume,
 * without touching authenticated subscribed sockets.
 *
 * Every test boots the REAL `createGguiServer` and drives it over a
 * real `ws` client, because the properties pinned live in the wiring:
 * the `CreateGguiServerOptions` → channel forwarding, the per-socket
 * router enforcement, and the `/ggui/health` counter surface. The
 * distinguishing signal throughout is the `subscribe` transition — a
 * socket that has completed a valid subscribe is a legitimate long-
 * lived subscriber and MUST be exempt from every pre-subscribe cap.
 *
 * Three caps, each configurable + disable-able:
 *   - `wsMaxPreSubscribePayloadBytes` — per-frame byte ceiling on
 *     pre-subscribe frames (1009 close on breach).
 *   - `wsPreSubscribeIdleMs` — a socket that never subscribes within
 *     the window is closed (1008).
 *   - `wsMaxPreSubscribeConnections` — pending (pre-subscribe) socket
 *     ceiling; the next upgrade is cleanly closed (1013).
 * Each cap-driven close increments a monotonic counter surfaced under
 * `/ggui/health` → `channel.caps.preSubscribeRejections`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { createGguiServer, type CreateGguiServerOptions, type GguiServer } from "./server.js";
import type { Logger } from "./logger.js";

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

interface HealthBody {
  readonly status: string;
  readonly channel?: {
    readonly path: string;
    readonly subscribers: number;
    readonly renders: number;
    readonly caps?: {
      readonly preSubscribeRejections: {
        readonly payload: number;
        readonly idle: number;
        readonly connection: number;
      };
    };
  };
}

const started: GguiServer[] = [];
const sockets: WebSocket[] = [];

async function boot(extra: CreateGguiServerOptions): Promise<{ server: GguiServer; port: number }> {
  const server = createGguiServer({ logger: silentLogger, ...extra });
  started.push(server);
  const httpServer = await server.listen(0, "127.0.0.1");
  const addr = httpServer.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return { server, port: addr.port };
}

afterEach(async () => {
  // Terminate every client socket first: a still-open PENDING socket
  // keeps Node's httpServer.close() from draining, so tear the TCP
  // down from the client side before closing the server.
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(started.splice(0).map((s) => s.close().catch(() => undefined)));
});

function connect(port: number, server: GguiServer): WebSocket {
  const channel = server.renderChannel;
  if (channel === null) throw new Error("renderChannel: true did not create a channel");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${channel.path}`, {
    headers: { authorization: "Bearer caps-test-token" },
  });
  sockets.push(ws);
  return ws;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitClose(ws: WebSocket, timeoutMs = 2000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket did not close within timeout")), timeoutMs);
    timer.unref?.();
    ws.once("close", (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function nextFrame(ws: WebSocket, type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${type}' frame`)), timeoutMs);
    timer.unref?.();
    const onMsg = (raw: RawData): void => {
      const parsed: unknown = JSON.parse(String(raw));
      if (parsed !== null && typeof parsed === "object" && (parsed as { type?: unknown }).type === type) {
        ws.off("message", onMsg);
        clearTimeout(timer);
        resolve(parsed as Record<string, unknown>);
      }
    };
    ws.on("message", onMsg);
    ws.once("error", reject);
  });
}

function subscribe(ws: WebSocket): void {
  ws.send(
    JSON.stringify({
      type: "subscribe",
      payload: { sessionId: randomUUID(), appId: "caps-app" },
      requestId: randomUUID(),
    })
  );
}

function getHealth(port: number): Promise<HealthBody> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "GET", path: "/ggui/health", headers: { Host: `127.0.0.1:${port}` } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data) as HealthBody));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("pre-subscribe payload cap", () => {
  it("closes a pre-subscribe socket that sends an oversized frame (1009) and counts it on /ggui/health", async () => {
    const { server, port } = await boot({
      renderChannel: true,
      wsMaxPreSubscribePayloadBytes: 256,
      wsPreSubscribeIdleMs: 0,
    });
    const ws = connect(port, server);
    await waitOpen(ws);
    const closed = waitClose(ws);
    // > 256 bytes, sent BEFORE any subscribe.
    ws.send(JSON.stringify({ type: "ping", requestId: "x".repeat(400) }));
    expect(await closed).toBe(1009);
    const health = await getHealth(port);
    expect(health.channel?.caps?.preSubscribeRejections.payload).toBe(1);
  });

  it("does NOT apply the pre-subscribe payload cap to an already-subscribed socket", async () => {
    const { server, port } = await boot({
      renderChannel: true,
      wsMaxPreSubscribePayloadBytes: 256,
      wsPreSubscribeIdleMs: 0,
    });
    const ws = connect(port, server);
    await waitOpen(ws);
    subscribe(ws);
    await nextFrame(ws, "ack");
    // A frame far larger than the pre-subscribe cap, sent AFTER
    // subscribe. A live pong proves the socket accepted it and stayed
    // open — the cap is provably exempt for subscribed sockets.
    const pong = nextFrame(ws, "pong");
    ws.send(JSON.stringify({ type: "ping", requestId: "y".repeat(400) }));
    await pong;
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("pre-subscribe idle timeout", () => {
  it("closes a socket that never subscribes after the idle window (1008) and counts it", async () => {
    const { server, port } = await boot({ renderChannel: true, wsPreSubscribeIdleMs: 250 });
    const ws = connect(port, server);
    await waitOpen(ws);
    expect(await waitClose(ws)).toBe(1008);
    const health = await getHealth(port);
    expect(health.channel?.caps?.preSubscribeRejections.idle).toBe(1);
  });

  it("does NOT idle-close a socket that has completed a valid subscribe", async () => {
    const { server, port } = await boot({ renderChannel: true, wsPreSubscribeIdleMs: 200 });
    const ws = connect(port, server);
    await waitOpen(ws);
    subscribe(ws);
    await nextFrame(ws, "ack");
    let closed = false;
    ws.once("close", () => {
      closed = true;
    });
    await delay(600); // 3x the idle window
    expect(closed).toBe(false);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const health = await getHealth(port);
    expect(health.channel?.caps?.preSubscribeRejections.idle).toBe(0);
  });
});

describe("pre-subscribe connection ceiling", () => {
  it("refuses a pre-subscribe connection beyond the ceiling (1013) and counts it", async () => {
    const { server, port } = await boot({
      renderChannel: true,
      wsMaxPreSubscribeConnections: 1,
      wsPreSubscribeIdleMs: 0,
    });
    const ws1 = connect(port, server);
    await waitOpen(ws1); // stays pending → pre-subscribe count = 1
    const ws2 = connect(port, server);
    expect(await waitClose(ws2)).toBe(1013);
    expect(ws1.readyState).toBe(WebSocket.OPEN);
    const health = await getHealth(port);
    expect(health.channel?.caps?.preSubscribeRejections.connection).toBe(1);
  });

  it("frees a ceiling slot once the pending socket subscribes", async () => {
    const { server, port } = await boot({
      renderChannel: true,
      wsMaxPreSubscribeConnections: 1,
      wsPreSubscribeIdleMs: 0,
    });
    const ws1 = connect(port, server);
    await waitOpen(ws1);
    subscribe(ws1); // transitions out of the pending set → slot freed
    await nextFrame(ws1, "ack");
    const ws2 = connect(port, server);
    await waitOpen(ws2);
    subscribe(ws2);
    // ws2 now gets its own ack rather than a 1013 refusal.
    const ack = await nextFrame(ws2, "ack");
    expect(ack["type"]).toBe("ack");
  });
});

describe("fail-safe: defaults never trip on the honest path", () => {
  it("subscribe → ack → ping/pong still works with default caps, counters all zero", async () => {
    const { server, port } = await boot({ renderChannel: true });
    const ws = connect(port, server);
    await waitOpen(ws);
    subscribe(ws);
    const ack = await nextFrame(ws, "ack");
    expect(ack["type"]).toBe("ack");
    const pong = nextFrame(ws, "pong");
    ws.send(JSON.stringify({ type: "ping", requestId: "p" }));
    await pong;
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const health = await getHealth(port);
    expect(health.channel?.caps?.preSubscribeRejections).toEqual({
      payload: 0,
      idle: 0,
      connection: 0,
    });
  });
});
