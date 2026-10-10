/**
 * ggui#1772 — the listener's idle timeouts outlive any proxy's upstream
 * keepalive. Node's `http.Server` defaults to `keepAliveTimeout` 5 s, and
 * every proxy in front of a self-hosted server keeps pooled upstream
 * connections longer (ingress-nginx's default `upstream-keepalive-timeout`
 * is 60 s). That is the classic keepalive race: the proxy reuses a
 * connection Node has just idle-closed, the request meets a TCP RST, and a
 * non-idempotent POST — every `tools/call` — comes back to the client as a
 * 502. The rule is the standard one: the upstream's idle timeout must
 * exceed the proxy's, and `headersTimeout` must exceed `keepAliveTimeout`
 * (Node documents that order). `listen()` sets both on the server it
 * returns, so every embedder that calls it inherits the defaults.
 */
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  createGguiServer,
  type GguiServer,
} from './server.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child() {
    return silentLogger;
  },
};

describe('listen() sets idle timeouts that outlive a proxy keepalive (ggui#1772)', () => {
  let server: GguiServer;
  let httpServer: Awaited<ReturnType<GguiServer['listen']>>;

  beforeAll(async () => {
    server = createGguiServer({ logger: silentLogger });
    httpServer = await server.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await server.close();
  });

  it("control: a bare node:http server keeps Node's 5 s keepAliveTimeout, so the assertions below are not vacuous", () => {
    const bare = createServer();
    expect(bare.keepAliveTimeout).toBe(5_000);
    bare.close();
  });

  it('keepAliveTimeout is 65 s — above the 60 s ingress-nginx default upstream keepalive', () => {
    expect(DEFAULT_KEEP_ALIVE_TIMEOUT_MS).toBe(65_000);
    expect(httpServer.keepAliveTimeout).toBe(DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
    expect(httpServer.keepAliveTimeout).toBeGreaterThan(60_000);
  });

  it('headersTimeout sits above keepAliveTimeout, and below requestTimeout, the order Node documents', () => {
    expect(DEFAULT_HEADERS_TIMEOUT_MS).toBe(66_000);
    expect(httpServer.headersTimeout).toBe(DEFAULT_HEADERS_TIMEOUT_MS);
    expect(httpServer.headersTimeout).toBeGreaterThan(httpServer.keepAliveTimeout);
    expect(httpServer.requestTimeout).toBeGreaterThan(httpServer.headersTimeout);
  });
});
