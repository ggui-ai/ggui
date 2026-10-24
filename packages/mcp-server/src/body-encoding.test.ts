/**
 * Request bodies are read as sent: the JSON and form parsers do not
 * decode a `Content-Encoding`. A compressed body answers 415 and the
 * process keeps serving — nothing about the body's bytes reaches a
 * decoder that could throw outside the request.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createGguiServer, type GguiServer } from './server.js';

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child: () => silentLogger,
};

type Fx = { readonly server: GguiServer; readonly url: string };

/** gzip bytes in a fresh ArrayBuffer, the shape `fetch` accepts as a body. */
function gzip(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(gzipSync(text));
}
async function boot(): Promise<Fx> {
  const server = createGguiServer({ logger: silentLogger, oauth: { issuerUrl: 'https://mcp.example.test' } });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

async function post(fx: Fx, path: string, contentType: string, body: Uint8Array<ArrayBuffer> | string, encoding?: string): Promise<number> {
  const res = await fetch(`${fx.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType, ...(encoding !== undefined ? { 'content-encoding': encoding } : {}) },
    body,
  });
  await res.arrayBuffer();
  return res.status;
}

describe('request bodies are read uncompressed', () => {
  let fx: Fx;
  afterEach(async () => {
    await fx.server.close();
  });

  it('a gzip-encoded form body to /oauth/token answers 415, and the next plain request is served', async () => {
    fx = await boot();
    const form = 'grant_type=authorization_code&code=x';
    expect(await post(fx, '/oauth/token', 'application/x-www-form-urlencoded', gzip(form), 'gzip')).toBe(415);
    const plain = await post(fx, '/oauth/token', 'application/x-www-form-urlencoded', form);
    expect(plain, 'the server still answers, with a non-415 and no 5xx').not.toBe(415);
    expect(plain).toBeLessThan(500);
  });

  it('a gzip-encoded JSON body to /oauth/register answers 415, and the next plain request is served', async () => {
    fx = await boot();
    const json = JSON.stringify({ redirect_uris: ['https://client.example.test/cb'] });
    expect(await post(fx, '/oauth/register', 'application/json', gzip(json), 'gzip')).toBe(415);
    const plain = await post(fx, '/oauth/register', 'application/json', json);
    expect(plain).not.toBe(415);
    expect(plain).toBeLessThan(500);
  });
});
