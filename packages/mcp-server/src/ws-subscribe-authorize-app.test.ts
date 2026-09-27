/**
 * ggui#1480 — `createGguiServer` hands the live channel the SAME per-app
 * authorization the `/mcp` endpoint runs on a URL-addressed app
 * (`perAppRouting.authorize`), so a bearer subscribe that declares an app
 * other than its identity's own is authorized before it decides the
 * app-scope gate or provisions a row. The channel-level cases live in
 * `ggui-session-channel.test.ts`; this file pins the composition — the
 * forward from the server options to the channel — over a real `ws`
 * client against the real server.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import type { WebSocketMessage } from "@ggui-ai/protocol/transport/websocket";
import { createGguiServer, type CreateGguiServerOptions, type GguiServer } from "./server.js";
import type { Logger } from "./logger.js";

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

const started: GguiServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(started.splice(0).map((s) => s.close().catch(() => undefined)));
});

async function openSubscriber(extra: CreateGguiServerOptions): Promise<WebSocket> {
  const server = createGguiServer({ logger: silentLogger, renderChannel: true, ...extra });
  started.push(server);
  const httpServer = await server.listen(0, "127.0.0.1");
  const addr = httpServer.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  const channel = server.renderChannel;
  if (channel === null) throw new Error("renderChannel: true did not create a channel");
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}${channel.path}`, {
    headers: { authorization: "Bearer authorize-app-test-token" },
  });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

/** The first `ack` or `error` frame — the subscribe's answer, whichever it is. */
function subscribeAnswer(ws: WebSocket, timeoutMs = 3000): Promise<WebSocketMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no ack or error frame")), timeoutMs);
    timer.unref?.();
    const onMsg = (raw: RawData): void => {
      const parsed = JSON.parse(String(raw)) as WebSocketMessage;
      if (parsed.type === "ack" || parsed.type === "error") {
        ws.off("message", onMsg);
        clearTimeout(timer);
        resolve(parsed);
      }
    };
    ws.on("message", onMsg);
  });
}

function subscribe(ws: WebSocket, appId: string): void {
  ws.send(
    JSON.stringify({
      type: "subscribe",
      payload: { sessionId: randomUUID(), appId },
      requestId: randomUUID(),
    })
  );
}

const perAppRouting = (authorize: (appId: string) => Promise<void>) => ({
  paramName: "appId",
  paramPattern: "[a-z0-9-]{2,24}",
  pathPrefix: "/apps",
  authorize,
});

describe("createGguiServer — the live channel runs perAppRouting.authorize on a declared app (ggui#1480)", () => {
  it("a declared app the deployment refuses answers APP_MISMATCH, and the authorization saw that app", async () => {
    const seen: string[] = [];
    const ws = await openSubscriber({
      perAppRouting: perAppRouting(async (appId) => {
        seen.push(appId);
        throw new Error("Unauthorized");
      }),
    });
    subscribe(ws, "someone-elses-app");
    const answer = await subscribeAnswer(ws);
    expect(answer.type).toBe("error");
    expect(answer.type === "error" ? answer.payload.code : undefined).toBe("APP_MISMATCH");
    expect(seen).toEqual(["someone-elses-app"]);
  });

  it("a declared app the deployment authorizes subscribes — control", async () => {
    const ws = await openSubscriber({ perAppRouting: perAppRouting(async () => {}) });
    subscribe(ws, "an-owned-app");
    expect((await subscribeAnswer(ws)).type).toBe("ack");
  });
});
