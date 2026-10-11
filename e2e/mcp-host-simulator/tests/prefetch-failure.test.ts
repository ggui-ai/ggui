/**
 * ggui#1822 — a `ui://` shell prefetch that fails is an error, not an empty
 * shell. `listTools()` reads each tool's resourceUri after `tools/list`; when
 * that read fails, the call rejects with the URI, the elapsed time and the
 * underlying error, so a gate says what broke instead of asserting on "".
 *
 * A proxy in front of a real OSS server forwards every request except
 * `resources/read`, which it answers with HTTP 500.
 */
import { createServer, request, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HostSimulator, bootOssServer, type OssFixture } from '../src/index.js';

function failingReadProxy(target: string): Promise<{ server: Server; url: string }> {
  const upstream = new URL(target);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      // Only a JSON-RPC POST carries a method; the stream GET and the like are forwarded as they are.
      const isJsonRpc = req.method === 'POST' && (req.headers['content-type'] ?? '').includes('application/json');
      const method = isJsonRpc ? (JSON.parse(body.toString('utf8')) as { method?: unknown }).method : undefined;
      if (method === 'resources/read') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('injected resources/read failure');
        return;
      }
      const fwd = request(
        { host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      fwd.on('error', () => res.destroy());
      fwd.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('host-simulator: a failed shell prefetch is an error (ggui#1822)', () => {
  let fixture: OssFixture | null = null;
  let proxy: Server | null = null;
  let host: HostSimulator | null = null;

  afterEach(async () => {
    if (host) await host.close();
    host = null;
    if (proxy) await new Promise<void>((r) => proxy!.close(() => r()));
    proxy = null;
    if (fixture) await fixture.close();
    fixture = null;
  });

  it('listTools rejects naming the resource URI and the underlying error, never caching an empty shell', async () => {
    fixture = await bootOssServer();
    const p = await failingReadProxy(fixture.url);
    proxy = p.server;
    host = new HostSimulator({ url: p.url, bearer: 'host-simulator-test' });
    await host.connect();

    const err = await host.listTools().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('ui://');
    expect(message).toMatch(/resources\/read/);
    expect(message).toMatch(/\d+ ms/);
    expect(message).toContain('500');
  });
});
