/**
 * Browser CORS layer (ggui#438b) — enablement for browser-resident MCP
 * clients. Not a conformance requirement: no MCP spec layer mandates
 * CORS, and claude.ai / ChatGPT connect from their backends.
 *
 * Requests use node:http (Origin is a Fetch-forbidden header name).
 */
import { describe, expect, it } from "vitest";
import express from "express";
import { request as httpRequest } from "node:http";
import { buildOriginHostPolicy } from "./origin-validation.js";
import { createBrowserCorsMiddleware } from "./browser-cors.js";

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
  return app;
}

async function call(
  method: string,
  headers: Record<string, string>
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  try {
    return await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: addr.port, method, path: "/mcp", headers },
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

  it("omits CORS headers for an unlisted origin", async () => {
    const { headers } = await call("OPTIONS", {
      Origin: "https://evil.com",
      "Access-Control-Request-Method": "POST",
    });
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
