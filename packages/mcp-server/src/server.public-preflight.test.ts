/**
 * ggui#1231 — the public `*` read routes own their CORS PREFLIGHT.
 *
 * A sandboxed `srcdoc` frame has origin `null`, which no allowlist can
 * name. Its GETs to the runtime bundle, the code/contract modules and
 * the session read endpoints are already answered with
 * `Access-Control-Allow-Origin: *` — but a preflight for the same URL
 * used to be swallowed by the allowlist CORS layer as a bare 204 with
 * no `access-control-*` header, so any request the browser chose to
 * preflight failed as an opaque CORS error while the plain GET worked.
 * Read live on the ingress before this pin existed:
 * `OPTIONS /_ggui/iframe-runtime.js` + `Origin: null` → 204, no CORS
 * header; the route's own GET → 200 + ACAO `*`.
 *
 * This boots the REAL server (mount order is the bug surface — a
 * route-level preflight registered behind a middleware that ends every
 * unlisted-origin OPTIONS is dead code) and sends a `null`-origin
 * preflight to every public route as mounted.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryAuthAdapter,
  InMemoryCodeStore,
  InMemoryGguiSessionStore,
  InMemoryShortCodeIndex,
} from "@ggui-ai/mcp-server-core/in-memory";
import {
  RUNTIME_BUNDLE_FILE,
  RUNTIME_BUNDLE_URL_PATH,
  RUNTIME_SHIMS_URL_PREFIX,
} from "@ggui-ai/iframe-runtime/server";
import { computeRuntimeBundleHash, insertRuntimeBundleHash } from "./runtime-bundle-hash.js";
import { createGguiServer, type GguiServer } from "./server.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

const SECRET = "deterministic-test-secret-" + "x".repeat(32);
const HASH64 = "a".repeat(64);

async function boot(): Promise<{ server: GguiServer; url: string }> {
  const server = createGguiServer({
    logger: silentLogger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    mcpApps: true,
    renderChannel: true,
    renderStore: new InMemoryGguiSessionStore(),
    shortCodeIndex: new InMemoryShortCodeIndex(),
    wsTokenSecret: SECRET,
    codeStore: new InMemoryCodeStore(),
    publicBaseUrl: "https://test.example",
  });
  const httpServer = await server.listen(0, "127.0.0.1");
  const addr = httpServer.address();
  if (!addr || typeof addr === "string")
    throw new Error("server.address() did not return AddressInfo");
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

function preflight(url: string, path: string): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: "OPTIONS",
    headers: {
      Origin: "null",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "x-ggui-probe",
    },
  });
}

/** The mounted `*` routes, exactly as `createGguiServer` registers them. */
function publicRoutePaths(): ReadonlyArray<readonly [label: string, path: string]> {
  const bundle = readFileSync(RUNTIME_BUNDLE_FILE);
  const hash = computeRuntimeBundleHash(bundle);
  const hashedRuntimePath = insertRuntimeBundleHash(
    RUNTIME_BUNDLE_URL_PATH,
    hash,
    RUNTIME_BUNDLE_URL_PATH.slice(RUNTIME_BUNDLE_URL_PATH.lastIndexOf("/") + 1)
  );
  return [
    ["runtime bundle", RUNTIME_BUNDLE_URL_PATH],
    ["runtime bundle (hashed)", hashedRuntimePath],
    ["runtime shim", `${RUNTIME_SHIMS_URL_PREFIX}/${hash}/react.js`],
    ["code module", `/code/${HASH64}.js`],
    ["code module (strict-CSP variant)", `/code/${HASH64}.m${"b".repeat(12)}.js`],
    ["contract bundle", `/contract/${HASH64}.js`],
    ["session state", "/api/sessions/s1/state"],
    ["session events", "/api/sessions/s1/events"],
    ["session stream", "/api/sessions/s1/stream"],
  ];
}

describe("ggui#1231 — null-origin preflight on the public * routes (real mount order)", () => {
  let booted: { server: GguiServer; url: string } | null = null;
  afterEach(async () => {
    if (booted) {
      await booted.server.close();
      booted = null;
    }
  });

  for (const [label, path] of publicRoutePaths()) {
    it(`${label} — OPTIONS ${path} from Origin: null → 204 + ACAO * + GET allowed + requested headers reflected`, async () => {
      booted = await boot();
      const res = await preflight(booted.url, path);
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect((res.headers.get("access-control-allow-methods") ?? "").toLowerCase()).toContain(
        "get"
      );
      expect((res.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain(
        "x-ggui-probe"
      );
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    });
  }

  it("/mcp is NOT a public route: a null-origin preflight gets no access-control-allow-origin", async () => {
    booted = await boot();
    const res = await preflight(booted.url, "/mcp");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
