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

describe("invariant: CSRF covers /mcp (booted server, real wiring)", () => {
  /**
   * `cookieAuthMiddleware` promotes the `ggui_user_session` cookie to
   * `Authorization: Bearer` on every route, so /mcp is implicitly
   * cookie-authed. What stops a hostile origin from riding that cookie
   * is the CSRF middleware — NOT the never-Allow-Credentials rule,
   * which only blocks response READS, never request execution. The
   * CSRF layer keys on cookie PRESENCE, so a garbage session value
   * still exercises it. If /mcp is ever added to the CSRF skipPaths,
   * this 403 disappears — that regression must fail loudly here.
   */
  it("403s a cookie-session POST to /mcp with no X-Ggui-CSRF header", async () => {
    const { port, close } = await bootServer();
    try {
      const res = await rawRequest({
        port,
        method: "POST",
        path: "/mcp",
        headers: {
          ...JSON_HEADERS,
          Host: `127.0.0.1:${port}`,
          Cookie: "ggui_user_session=some-session-value",
        },
        body: "{}",
      });
      expect(res.status).toBe(403);
    } finally {
      await close();
    }
  });

  it("does not CSRF-block a cookie-less request (claude.ai's connector path)", async () => {
    const { port, close } = await bootServer();
    try {
      const res = await rawRequest({
        port,
        method: "POST",
        path: "/mcp",
        headers: { ...JSON_HEADERS, Host: `127.0.0.1:${port}` },
        body: "{}",
      });
      // Reaches the transport; a bare "{}" is not a valid JSON-RPC
      // message so the SDK answers 4xx-other — anything but the CSRF
      // 403 proves CSRF stayed out of the way.
      expect(res.status).not.toBe(403);
    } finally {
      await close();
    }
  });
});

describe("invariant: /mcp rejects non-JSON Content-Type before dispatch", () => {
  /**
   * A cross-origin page can POST `text/plain` with NO preflight; the
   * SDK transport must answer 415 before any JSON-RPC dispatch
   * (webStandardStreamableHttp.js — Content-Type gate at ~line 479).
   * NOTE the Accept header: the SDK validates Accept BEFORE
   * Content-Type, so the request must pass the Accept gate
   * ("application/json, text/event-stream") to actually exercise the
   * 415 branch — an Accept-less request 406s first.
   */
  it("415s a text/plain POST that passes the Accept gate", async () => {
    const { port, close } = await bootServer();
    try {
      const res = await rawRequest({
        port,
        method: "POST",
        path: "/mcp",
        headers: {
          "Content-Type": "text/plain",
          Accept: "application/json, text/event-stream",
          Host: `127.0.0.1:${port}`,
        },
        body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
      });
      expect(res.status).toBe(415);
    } finally {
      await close();
    }
  });

  it("406s the Accept-less drive-by shape (the status a browser fetch actually gets)", async () => {
    const { port, close } = await bootServer();
    try {
      const res = await rawRequest({
        port,
        method: "POST",
        path: "/mcp",
        headers: {
          "Content-Type": "application/json",
          Accept: "*/*",
          Host: `127.0.0.1:${port}`,
        },
        body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
      });
      expect(res.status).toBe(406);
    } finally {
      await close();
    }
  });
});

describe("wired CORS: preflight is answered by the mounted layer, before auth", () => {
  it("204s an OPTIONS /mcp with ACAO for an allowlisted origin and NO Authorization", async () => {
    // Preflights carry NO Authorization by spec. This runs against the
    // BOOTED server, so it pins the mount itself: if the CORS layer
    // were mounted after route registration (or not at all), Express
    // answers OPTIONS itself with 200 + Allow and no ACAO — and this
    // fails. That is the regression a unit test of the middleware in
    // isolation can never catch.
    const { port, close } = await bootServer({ browserOrigins: ["https://app.guuey.com"] });
    try {
      const res = await rawRequest({
        port,
        method: "OPTIONS",
        path: "/mcp",
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: "https://app.guuey.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("https://app.guuey.com");
    } finally {
      await close();
    }
  });

  it("204s an OPTIONS /mcp with a MALFORMED JSON body — proves the mount precedes express.json, not just that a CORS layer exists", async () => {
    // /mcp is registered method-specifically (app.post/app.get/app.delete,
    // no app.all/app.options), so OPTIONS /mcp matches no route handler —
    // Express's built-in auto-OPTIONS only fires after the ENTIRE
    // middleware/route stack is exhausted with no match. That means a
    // CORS layer mounted ANYWHERE before that point (even after
    // express.json, even after the routes) would still be the one
    // answering this preflight with 204 + ACAO — the previous test in
    // this block cannot distinguish "mounted before body parsing" from
    // "mounted anywhere before the fallback". A malformed JSON body
    // breaks that ambiguity: if the CORS layer truly precedes
    // express.json, this OPTIONS request is answered (204) before the
    // body is ever parsed. If the mount ever migrates below
    // express.json, the parser sees the malformed body first and 400s
    // with a SyntaxError — this test goes red, which is the point: it
    // test-locks mount ORDER, not just mount existence.
    //
    // Content-Length is set explicitly: node:http silently drops a
    // body written via req.write()/req.end() on an OPTIONS request
    // unless Content-Length (or Transfer-Encoding) is present, so
    // without it the malformed body never reaches the wire at all and
    // the probe can't discriminate anything.
    const { port, close } = await bootServer({ browserOrigins: ["https://app.guuey.com"] });
    try {
      const malformedBody = "{";
      const res = await rawRequest({
        port,
        method: "OPTIONS",
        path: "/mcp",
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: "https://app.guuey.com",
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(malformedBody)),
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
        body: malformedBody,
      });
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("https://app.guuey.com");
    } finally {
      await close();
    }
  });
});
