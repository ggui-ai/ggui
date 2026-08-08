/**
 * Integration pins for the MCP plane (ggui#438) — every test here
 * boots the REAL `createGguiServer` and exercises the shipped wiring,
 * because the properties pinned (middleware mount order, WS-upgrade
 * validation, CSRF coverage, transport Content-Type gate) live in the
 * wiring, not in any unit-testable function. A pure-function test
 * passes identically whether or not server.ts was ever edited.
 *
 * Requests use node:http / node:net, not fetch — `Host`, `Origin`,
 * and `Cookie` are Fetch-forbidden header names; node:http sends them
 * verbatim.
 */
import { describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { createGguiServer, type CreateGguiServerOptions, type GguiServer } from "./server.js";

export const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

interface BootedServer {
  server: GguiServer;
  port: number;
  close: () => Promise<void>;
}

export async function bootServer(extra: CreateGguiServerOptions = {}): Promise<BootedServer> {
  const server = createGguiServer({ logger: silentLogger, ...extra });
  const httpServer = await server.listen(0, "127.0.0.1");
  const addr = httpServer.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return { server, port: addr.port, close: () => server.close() };
}

export function rawRequest(opts: {
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data })
        );
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Raw WS-upgrade handshake; resolves with the first response bytes. */
export function rawUpgrade(
  port: number,
  path: string,
  hostHeader: string,
  origin?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${hostHeader}\r\n` +
          (origin !== undefined ? `Origin: ${origin}\r\n` : "") +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n\r\n"
      );
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += String(chunk);
      socket.destroy();
      resolve(data);
    });
    socket.on("error", reject);
    socket.on("close", () => {
      if (data === "") resolve("");
    });
  });
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

describe("Origin/Host validation is WIRED (mount order, not just the pure function)", () => {
  it("403s a rebound Host on POST /mcp — proves the middleware is mounted before routes", async () => {
    const { port, close } = await bootServer();
    try {
      const res = await rawRequest({
        port,
        method: "POST",
        path: "/mcp",
        headers: { ...JSON_HEADERS, Host: "evil.com:6781" },
        body: "{}",
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Host header: evil.com:6781" },
        id: null,
      });
    } finally {
      await close();
    }
  });

  it("403s a disallowed Origin on POST /mcp", async () => {
    const { port, close } = await bootServer();
    try {
      const res = await rawRequest({
        port,
        method: "POST",
        path: "/mcp",
        headers: { ...JSON_HEADERS, Host: `127.0.0.1:${port}`, Origin: "https://evil.com" },
        body: "{}",
      });
      expect(res.status).toBe(403);
    } finally {
      await close();
    }
  });

  it("passes a loopback Origin through to the transport (not 403)", async () => {
    const { port, close } = await bootServer();
    try {
      const res = await rawRequest({
        port,
        method: "POST",
        path: "/mcp",
        headers: { ...JSON_HEADERS, Host: `127.0.0.1:${port}`, Origin: "http://localhost:5173" },
        body: "{}",
      });
      expect(res.status).not.toBe(403);
    } finally {
      await close();
    }
  });

  it('rejects "null" Origin on the MCP wire but NOT on public surfaces', async () => {
    // Sandboxed srcdoc iframes (claude.ai's mount path) have the
    // literal `null` origin and legitimately fetch the runtime bundle
    // and /ggui/health-adjacent surfaces. Origin enforcement is scoped
    // to the MCP wire; a `null`-origin GET of a non-MCP route must
    // never be 403'd by validation.
    const { port, close } = await bootServer();
    try {
      const mcp = await rawRequest({
        port,
        method: "POST",
        path: "/mcp",
        headers: { ...JSON_HEADERS, Host: `127.0.0.1:${port}`, Origin: "null" },
        body: "{}",
      });
      expect(mcp.status).toBe(403);

      const health = await rawRequest({
        port,
        method: "GET",
        path: "/ggui/health",
        headers: { Host: `127.0.0.1:${port}`, Origin: "null" },
      });
      expect(health.status).toBe(200);

      // /code is one of the deliberately-public cross-origin routes
      // (ACAO:*). Unknown hash → 404, malformed → 400 — anything but
      // a validation 403.
      const code = await rawRequest({
        port,
        method: "GET",
        path: "/code/0000000000000000000000000000000000000000000000000000000000000000.js",
        headers: { Host: `127.0.0.1:${port}`, Origin: "null" },
      });
      expect(code.status).not.toBe(403);
    } finally {
      await close();
    }
  });

  it("listen(0) with no explicit host still feeds the policy a loopback bind (default stays policy-consistent)", async () => {
    // No `host` in CreateGguiServerOptions AND no host argument to
    // listen() — both fall back to the same "127.0.0.1" default, so
    // the policy and the actual bind cannot diverge for the zero-config
    // path. Pins that fallback chain end-to-end instead of trusting it
    // by inspection.
    const server = createGguiServer({ logger: silentLogger });
    const httpServer = await server.listen(0);
    try {
      const addr = httpServer.address();
      if (addr === null || typeof addr === "string") throw new Error("no port");
      const res = await rawRequest({
        port: addr.port,
        method: "POST",
        path: "/mcp",
        headers: { ...JSON_HEADERS, Host: "evil.com:6781" },
        body: "{}",
      });
      expect(res.status).toBe(403);
    } finally {
      await server.close();
    }
  });
});

describe("WS upgrade ingress runs the same validator", () => {
  it("403s the handshake for a rebound Host; loopback Host proceeds", async () => {
    const { server, port, close } = await bootServer({ renderChannel: true });
    try {
      const channel = server.renderChannel;
      if (channel === null) throw new Error("renderChannel: true did not create a channel");
      const rejected = await rawUpgrade(port, channel.path, "evil.com:6781");
      expect(rejected).toMatch(/^HTTP\/1\.1 403/);
      const allowed = await rawUpgrade(port, channel.path, `127.0.0.1:${port}`);
      // Unauthenticated handshake may 101-then-close or 4xx — anything
      // but the validation 403.
      expect(allowed).not.toMatch(/^HTTP\/1\.1 403/);
    } finally {
      await close();
    }
  });

  it("403s the handshake for a disallowed Origin on an otherwise-valid Host", async () => {
    const { server, port, close } = await bootServer({ renderChannel: true });
    try {
      const channel = server.renderChannel;
      if (channel === null) throw new Error("renderChannel: true did not create a channel");
      const originRejected = await rawUpgrade(
        port,
        channel.path,
        `127.0.0.1:${port}`,
        "https://evil.com"
      );
      expect(originRejected).toMatch(/^HTTP\/1\.1 403/);
    } finally {
      await close();
    }
  });
});
