/**
 * Origin/Host validation — the DNS-rebinding defense (ggui#438a).
 *
 * Spec: MCP Streamable HTTP 2025-11-25 — "Servers MUST validate the
 * Origin header"; "If the Origin header is present and invalid,
 * servers MUST respond with HTTP 403 Forbidden."
 *
 * Requests here use node:http, not fetch — `Host` and `Origin` are
 * Fetch-forbidden header names and undici's filtering of them has
 * varied across versions; node:http sends them verbatim.
 */
import { describe, expect, it, vi } from "vitest";
import express from "express";
import { request as httpRequest } from "node:http";
import {
  buildOriginHostPolicy,
  createOriginHostValidationMiddleware,
  validateOriginHost,
} from "./origin-validation.js";

// Loopback round-trip suite: every request in this file spins a
// throwaway `app.listen(0)` and awaits one localhost round-trip with no
// timeout of its own. 60s rather than the package-wide 30s — see the
// LOOPBACK ROUND-TRIP CARVE-OUT note in vitest.config.ts (#458).
vi.setConfig({ testTimeout: 60_000 });

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

const LOOPBACK_POLICY = buildOriginHostPolicy({ bindHost: "127.0.0.1" });

describe("validateOriginHost — Host header (DNS rebinding)", () => {
  it("accepts loopback hosts on any port (serve --port 0 assigns one)", () => {
    for (const host of ["localhost:6781", "127.0.0.1:41234", "[::1]:6781", "localhost"]) {
      expect(validateOriginHost(host, undefined, LOOPBACK_POLICY)).toBeNull();
    }
  });

  it("REJECTS a rebound attacker host (the exploit this closes)", () => {
    expect(validateOriginHost("evil.com:6781", undefined, LOOPBACK_POLICY)).toEqual({
      header: "host",
      value: "evil.com:6781",
    });
  });

  it("rejects a missing Host header when the Host check is active", () => {
    expect(validateOriginHost(undefined, undefined, LOOPBACK_POLICY)).toEqual({
      header: "host",
      value: "",
    });
  });

  it("accepts the publicBaseUrl host (tunnel forwarding to a loopback bind)", () => {
    const policy = buildOriginHostPolicy({
      bindHost: "127.0.0.1",
      publicBaseUrl: "https://random-words.trycloudflare.com",
    });
    expect(validateOriginHost("random-words.trycloudflare.com", undefined, policy)).toBeNull();
    expect(validateOriginHost("evil.com", undefined, policy)).not.toBeNull();
  });

  it("keeps the Host check ACTIVE for a bare IPv6 loopback bind (::1)", () => {
    // `::1` IS a loopback bind — exactly the spec's threat model. A
    // naive first-colon slice would return "" and silently disable
    // the whole defense for IPv6 binds.
    const policy = buildOriginHostPolicy({ bindHost: "::1" });
    expect(policy.allowedHosts).not.toBeNull();
    expect(validateOriginHost("[::1]:6781", undefined, policy)).toBeNull();
    expect(validateOriginHost("evil.com:6781", undefined, policy)).not.toBeNull();
  });

  it("disables the Host check when bound to a non-loopback address", () => {
    // The operator explicitly bound wide; rebinding is not the threat
    // model there, and a LAN IP host must not be rejected.
    const policy = buildOriginHostPolicy({ bindHost: "0.0.0.0" });
    expect(policy.allowedHosts).toBeNull();
    expect(validateOriginHost("192.168.1.50:6781", undefined, policy)).toBeNull();
  });
});

describe("validateOriginHost — Origin header", () => {
  it("PASSES when Origin is absent (native/CLI/backend clients send none)", () => {
    expect(validateOriginHost("localhost:6781", undefined, LOOPBACK_POLICY)).toBeNull();
  });

  it("accepts loopback page origins on any port by default", () => {
    for (const origin of ["http://localhost:6890", "http://127.0.0.1:5173", "http://[::1]:8080"]) {
      expect(validateOriginHost("localhost:6781", origin, LOOPBACK_POLICY)).toBeNull();
    }
  });

  it("rejects a present-but-unlisted origin", () => {
    expect(validateOriginHost("localhost:6781", "https://evil.com", LOOPBACK_POLICY)).toEqual({
      header: "origin",
      value: "https://evil.com",
    });
  });

  it("accepts an operator-listed origin, case-insensitively", () => {
    const policy = buildOriginHostPolicy({
      bindHost: "127.0.0.1",
      browserOrigins: ["https://app.guuey.com"],
    });
    expect(validateOriginHost("localhost:6781", "https://APP.guuey.com", policy)).toBeNull();
  });

  it("treats a different port as a different origin", () => {
    const policy = buildOriginHostPolicy({
      bindHost: "127.0.0.1",
      browserOrigins: ["https://app.guuey.com:8443"],
    });
    expect(validateOriginHost("localhost:6781", "https://app.guuey.com", policy)).not.toBeNull();
  });

  it("accepts the publicBaseUrl ORIGIN (the server's own tunnel-served pages)", () => {
    // Pages served from the tunnel origin POST back with that Origin
    // — the console, OAuth consent, /r/<code>. Rejecting it would 403
    // every tunnel deployment's own UI. The proxy may ALSO rewrite
    // the inbound Host to loopback, so this must pass via
    // allowedOrigins, not only via the same-origin allowance.
    const policy = buildOriginHostPolicy({
      bindHost: "127.0.0.1",
      publicBaseUrl: "https://random-words.trycloudflare.com",
    });
    expect(
      validateOriginHost("127.0.0.1:6781", "https://random-words.trycloudflare.com", policy)
    ).toBeNull();
  });

  it("accepts a same-origin request (Origin authority == request Host)", () => {
    // A LAN-bind server's own pages: browser at http://192.168.1.50:6781
    // POSTs to the same address. Origin is always sent on POST/WS; a
    // same-origin request must never 403.
    const policy = buildOriginHostPolicy({ bindHost: "0.0.0.0" });
    expect(validateOriginHost("192.168.1.50:6781", "http://192.168.1.50:6781", policy)).toBeNull();
    // Cross-origin to the same server still rejects (the drive-by shape).
    expect(validateOriginHost("192.168.1.50:6781", "https://evil.com", policy)).not.toBeNull();
  });

  it('rejects the literal "null" origin on the MCP wire (http ingress, the default)', () => {
    // Sandboxed iframes have the `null` origin and ARE legitimate
    // consumers of the runtime-bundle/code routes — but those routes
    // are outside the Origin-enforcement scope (see the middleware).
    // On the MCP HTTP plane itself, `null` still 403s: srcdoc pages
    // have no business POSTing /mcp, so this ingress carries no
    // opaque-origin admission.
    expect(validateOriginHost("localhost:6781", "null", LOOPBACK_POLICY)).toEqual({
      header: "origin",
      value: "null",
    });
  });
});

describe("validateOriginHost — opaque-origin (\"null\") admission on the ws-upgrade ingress (ggui#438a regression)", () => {
  // A document with an OPAQUE origin (srcdoc-mounted, about:-scheme, or
  // similar sandboxed embeddings) has no origin serialization other than
  // the literal string "null" — that is how the Origin header spec
  // requires it be sent, not a client choosing to omit identity.
  //
  // This function's `ingress` param is a POSTURE the caller selects,
  // not a raw "which wire did this arrive on" tag: the WS upgrade
  // handler in server.ts passes `"ws-upgrade"` only for upgrades that
  // already declare bootstrap intent (`?wsToken=` present) — the tests
  // below exercise the pure function's contract for that posture
  // directly, taking the caller's selection as given. Admission here is
  // NOT authentication: an admitted socket still carries only an
  // unverified placeholder identity, and the subscribe handler
  // (`ggui-session-channel/subscribe.ts`) rejects it outright unless the
  // `subscribe` message itself presents a credential that verifies.

  it('admits the literal "null" origin on the ws-upgrade ingress', () => {
    expect(validateOriginHost("localhost:6781", "null", LOOPBACK_POLICY, "ws-upgrade")).toBeNull();
  });

  it('keeps rejecting "null" on the http ingress, explicitly and by default', () => {
    expect(validateOriginHost("localhost:6781", "null", LOOPBACK_POLICY, "http")).toEqual({
      header: "origin",
      value: "null",
    });
    expect(validateOriginHost("localhost:6781", "null", LOOPBACK_POLICY)).toEqual({
      header: "origin",
      value: "null",
    });
  });

  it("passes an absent Origin on both ingresses", () => {
    expect(validateOriginHost("localhost:6781", undefined, LOOPBACK_POLICY, "ws-upgrade")).toBeNull();
    expect(validateOriginHost("localhost:6781", undefined, LOOPBACK_POLICY, "http")).toBeNull();
  });

  it("still 403s a present, non-allowlisted Origin on BOTH ingresses — the admission is null-only, not Origin-open", () => {
    expect(
      validateOriginHost("localhost:6781", "https://evil.example", LOOPBACK_POLICY, "ws-upgrade")
    ).toEqual({
      header: "origin",
      value: "https://evil.example",
    });
    expect(
      validateOriginHost("localhost:6781", "https://evil.example", LOOPBACK_POLICY, "http")
    ).toEqual({
      header: "origin",
      value: "https://evil.example",
    });
  });

  it("keeps the Host check enforced on the ws-upgrade ingress even with an opaque Origin", () => {
    expect(validateOriginHost("evil.com:6781", "null", LOOPBACK_POLICY, "ws-upgrade")).toEqual({
      header: "host",
      value: "evil.com:6781",
    });
  });
});

describe("createOriginHostValidationMiddleware", () => {
  function buildApp(): express.Express {
    const app = express();
    app.use(
      createOriginHostValidationMiddleware({
        policy: LOOPBACK_POLICY,
        enforceOriginPathPrefixes: ["/mcp"],
        logger: silentLogger,
      })
    );
    app.post("/mcp", (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.post("/public", (_req, res) => {
      res.status(200).json({ ok: true });
    });
    return app;
  }

  async function post(
    app: express.Express,
    path: string,
    headers: Record<string, string>
  ): Promise<{ status: number; body: unknown }> {
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    try {
      return await new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: addr.port,
            method: "POST",
            path,
            headers: { "Content-Type": "application/json", ...headers },
          },
          (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
          }
        );
        req.on("error", reject);
        req.end("{}");
      });
    } finally {
      server.close();
    }
  }

  it("403s a disallowed Origin on an MCP path with an id-less JSON-RPC error body", async () => {
    const res = await post(buildApp(), "/mcp", { Origin: "https://evil.com" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid Origin header: https://evil.com" },
      id: null,
    });
  });

  it("does NOT Origin-check paths outside the enforcement scope", async () => {
    // The Host check still ran (loopback Host passes); only the
    // Origin aspect is scoped. This is what keeps the public
    // cross-origin read surfaces (runtime-bundle, /code) alive.
    const res = await post(buildApp(), "/public", { Origin: "https://evil.com" });
    expect(res.status).toBe(200);
  });

  it("still Host-checks paths outside the Origin scope", async () => {
    const res = await post(buildApp(), "/public", { Host: "evil.com:6781" });
    expect(res.status).toBe(403);
  });

  it("passes a request with no Origin through to the route", async () => {
    const res = await post(buildApp(), "/mcp", {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
