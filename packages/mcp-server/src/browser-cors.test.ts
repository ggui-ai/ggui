/**
 * Browser CORS layer (ggui#438b) — enablement for browser-resident MCP
 * clients. Not a conformance requirement: no MCP spec layer mandates
 * CORS, and claude.ai / ChatGPT connect from their backends.
 *
 * Requests use node:http (Origin is a Fetch-forbidden header name).
 */
import { describe, expect, it, vi } from "vitest";
import express from "express";
import { request as httpRequest } from "node:http";
import { buildOriginHostPolicy } from "./origin-validation.js";
import {
  createBrowserCorsMiddleware,
  createPreflightFallback,
  createPublicReadPreflight,
} from "./browser-cors.js";

// Loopback round-trip suite: every request in this file spins a
// throwaway `app.listen(0)` and awaits one localhost round-trip with no
// timeout of its own. 60s rather than the package-wide 30s — see the
// LOOPBACK ROUND-TRIP CARVE-OUT note in vitest.config.ts (#458).
vi.setConfig({ testTimeout: 60_000 });

const POLICY = buildOriginHostPolicy({
  bindHost: "127.0.0.1",
  browserOrigins: ["https://app.guuey.com"],
});

function buildApp(): express.Express {
  const app = express();
  app.use(createBrowserCorsMiddleware({ policy: POLICY }));
  app.post("/mcp", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  // ggui#1231 — a public `*` read route owns its own preflight, the
  // way the runtime-bundle / code / session-read routes do in server.ts.
  app.options("/asset.js", createPublicReadPreflight());
  app.get("/asset.js", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).type("application/javascript").send("export {}");
  });
  // Mounted last, as server.ts does: a preflight nobody owns is a bare 204.
  app.use(createPreflightFallback());
  return app;
}

async function call(
  method: string,
  headers: Record<string, string>,
  path = "/mcp"
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  try {
    return await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: addr.port, method, path, headers },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        }
      );
      req.on("error", reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

function headerString(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v.join(", ") : (v ?? "")).toLowerCase();
}

describe("preflight", () => {
  it("answers OPTIONS 204 with the full header matrix for an allowed origin", async () => {
    const { status, headers } = await call("OPTIONS", {
      Origin: "https://app.guuey.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type,mcp-protocol-version",
    });
    expect(status).toBe(204);
    expect(headers["access-control-allow-origin"]).toBe("https://app.guuey.com");
    expect(headerString(headers["vary"])).toContain("origin");
    // GET/DELETE must be permitted even though ggui 405s them: the SDK
    // client auto-attempts GET (SSE) and DELETE (terminateSession) and
    // treats 405 as benign — but only if it can READ the status.
    expect(headerString(headers["access-control-allow-methods"])).toContain("get");
    expect(headerString(headers["access-control-allow-methods"])).toContain("post");
    expect(headerString(headers["access-control-allow-methods"])).toContain("delete");
    // `*` does NOT cover Authorization per the Fetch spec — it must be
    // named, or every AUTHENTICATED browser session dies at preflight
    // while unauthenticated dev sessions pass.
    expect(headerString(headers["access-control-allow-headers"])).toContain("authorization");
    // Silent-failure guards: the SDK reads both off responses.
    expect(headerString(headers["access-control-expose-headers"])).toContain("mcp-session-id");
    expect(headerString(headers["access-control-expose-headers"])).toContain("www-authenticate");
  });

  it("never sets Allow-Credentials (cookie→Bearer promotion makes it unsafe)", async () => {
    const { headers } = await call("OPTIONS", {
      Origin: "https://app.guuey.com",
      "Access-Control-Request-Method": "POST",
    });
    expect(headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("omits CORS headers for an unlisted origin — a bare 204 from the fallback", async () => {
    const { status, headers } = await call("OPTIONS", {
      Origin: "https://evil.com",
      "Access-Control-Request-Method": "POST",
    });
    expect(status).toBe(204);
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("actual requests", () => {
  it("stamps ACAO on a normal POST from an allowed origin", async () => {
    const { status, headers } = await call("POST", { Origin: "https://app.guuey.com" });
    expect(status).toBe(200);
    expect(headers["access-control-allow-origin"]).toBe("https://app.guuey.com");
  });

  it("stamps ACAO for loopback origins with no configuration", async () => {
    const { headers } = await call("POST", { Origin: "http://localhost:6890" });
    expect(headers["access-control-allow-origin"]).toBe("http://localhost:6890");
  });

  it("leaves origin-less requests untouched", async () => {
    const { status, headers } = await call("POST", {});
    expect(status).toBe(200);
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("ggui#1231 — public * read routes own their preflight", () => {
  const PREFLIGHT_HEADERS = {
    "Access-Control-Request-Method": "GET",
    "Access-Control-Request-Headers": "x-request-id",
  };

  it("answers a null-origin preflight (sandboxed srcdoc frame) with *", async () => {
    const { status, headers } = await call(
      "OPTIONS",
      { Origin: "null", ...PREFLIGHT_HEADERS },
      "/asset.js"
    );
    expect(status).toBe(204);
    expect(headers["access-control-allow-origin"]).toBe("*");
    expect(headerString(headers["access-control-allow-methods"])).toContain("get");
    expect(headerString(headers["access-control-allow-methods"])).toContain("head");
    expect(headerString(headers["access-control-allow-headers"])).toContain("x-request-id");
    expect(headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("answers an unlisted-origin preflight with * — the route is public by design", async () => {
    const { status, headers } = await call(
      "OPTIONS",
      { Origin: "https://evil.example", ...PREFLIGHT_HEADERS },
      "/asset.js"
    );
    expect(status).toBe(204);
    expect(headers["access-control-allow-origin"]).toBe("*");
  });

  it("falls back to the default allow-headers when the preflight names none", async () => {
    const { headers } = await call(
      "OPTIONS",
      { Origin: "null", "Access-Control-Request-Method": "GET" },
      "/asset.js"
    );
    expect(headerString(headers["access-control-allow-headers"])).toContain("content-type");
  });

  it("leaves an allowed origin's preflight to the allowlist layer (specific origin, not *)", async () => {
    const { status, headers } = await call(
      "OPTIONS",
      { Origin: "https://app.guuey.com", ...PREFLIGHT_HEADERS },
      "/asset.js"
    );
    expect(status).toBe(204);
    expect(headers["access-control-allow-origin"]).toBe("https://app.guuey.com");
  });

  it("a preflight on a path nobody owns is a bare 204 (fallback), never *", async () => {
    const { status, headers } = await call(
      "OPTIONS",
      { Origin: "null", ...PREFLIGHT_HEADERS },
      "/nowhere"
    );
    expect(status).toBe(204);
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("an origin-less OPTIONS (non-browser client) still ends as a 204", async () => {
    const { status, headers } = await call("OPTIONS", {}, "/mcp");
    expect(status).toBe(204);
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });
});
