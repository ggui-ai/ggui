/**
 * ggui#1822 — every MCP POST the simulator makes is timed, and a failed call
 * says how far each request still in flight got.
 *
 * A `-32001` timeout fires on the missing result, so on its own it cannot tell
 * a request that never got an answer (no headers: the path, or a request that
 * never arrived) from an answer that never finished (headers, then no result:
 * the server). The meter records each POST's phases and describes the open
 * ones when a call fails. It records; it never gates.
 */
import { createServer, request, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostSimulator, bootOssServer, type OssFixture } from '../src/index.js';
import { RequestMeter } from '../src/shell-read.js';

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
    });
  });
}

const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });

describe('RequestMeter: an open request is described by the phase it reached (ggui#1822)', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server!.close(() => r()));
    }
    server = null;
  });

  it('headers then nothing reads as an answer that never finished', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    });
    const url = await listen(server);
    const meter = new RequestMeter();
    const res = await meter.fetch(url, { method: 'POST', body: TOOLS_LIST });
    const reader = res.body!.getReader();
    const reading = reader.read();
    await new Promise((r) => setTimeout(r, 50));

    const [line, ...rest] = meter.describeInFlight();
    expect(rest).toEqual([]);
    expect(line).toMatch(/^tools\/list sent \d+ ms ago: headers \+\d+ ms \(text\/event-stream\), no body byte, still open$/);
    await reader.cancel();
    await reading;
  });

  it('a partial body reads with its bytes so far', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message\n');
    });
    const url = await listen(server);
    const meter = new RequestMeter();
    const res = await meter.fetch(url, { method: 'POST', body: TOOLS_LIST });
    const reader = res.body!.getReader();
    await reader.read();

    const [line] = meter.describeInFlight();
    expect(line).toContain('tools/list');
    expect(line).toMatch(/first body byte \+\d+ ms, 15 bytes, last byte \+\d+ ms, still open/);
    await reader.cancel();
  });

  it('a request with no answer at all reads as no headers', async () => {
    server = createServer(() => undefined);
    const url = await listen(server);
    const meter = new RequestMeter();
    const pending = meter.fetch(url, { method: 'POST', body: TOOLS_LIST });
    await new Promise((r) => setTimeout(r, 50));

    expect(meter.describeInFlight()).toEqual([expect.stringMatching(/^tools\/list sent \d+ ms ago: headers none, no body byte, still open$/)]);
    server.closeAllConnections();
    await expect(pending).rejects.toThrow();
    expect(meter.describeInFlight()).toEqual([]);
  });
});

describe('host-simulator: every MCP POST is timed, and a failed call reports what was in flight (ggui#1822)', () => {
  let fixture: OssFixture | null = null;
  let proxy: Server | null = null;
  let host: HostSimulator | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (host) await host.close();
    host = null;
    if (proxy) await new Promise<void>((r) => proxy!.close(() => r()));
    proxy = null;
    if (fixture) await fixture.close();
    fixture = null;
  });

  function captureStderr(): string[] {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: never[]) => {
      lines.push(String(chunk));
      return original(chunk, ...rest);
    }) as typeof process.stderr.write);
    return lines;
  }

  it('logs one timing line per POST, keyed by method', async () => {
    const lines = captureStderr();
    fixture = await bootOssServer();
    host = new HostSimulator({ url: fixture.url, bearer: 'host-simulator-test' });
    await host.connect();
    await host.listTools();

    // An SSE answer resolves the call on its message; the stream closes, and the line is written, just after.
    await vi.waitFor(() => expect(lines.some((l) => l.includes('request timing method=tools/list '))).toBe(true));
    const timing = lines.filter((l) => l.startsWith('[host-simulator] request timing '));
    const list = timing.find((l) => l.includes(' method=tools/list '));
    expect(timing.some((l) => l.includes(' method=initialize '))).toBe(true);
    expect(list).toBeDefined();
    expect(list).toContain('outcome=ok');
    expect(list).toContain(' status=200 ');
    expect(list).toMatch(/ first_byte_ms=\d+ /);
    expect(list).toMatch(/ bytes=[1-9]\d* /);
    expect(list).toContain('content_type=text/event-stream');
  });

  it('a failed tools/list is reported with the requests in flight, and the original error is rethrown', async () => {
    const lines = captureStderr();
    fixture = await bootOssServer();
    const upstream = new URL(fixture.url);
    proxy = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const isPost = req.method === 'POST' && (req.headers['content-type'] ?? '').includes('application/json');
        if (isPost && (JSON.parse(body.toString('utf8')) as { method?: unknown }).method === 'tools/list') {
          res.writeHead(503, { 'content-type': 'text/plain' });
          res.end('injected tools/list failure');
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
    const url = await listen(proxy);
    host = new HostSimulator({ url, bearer: 'host-simulator-test' });
    await host.connect();

    await expect(host.listTools()).rejects.toThrow(/injected tools\/list failure/);
    const failure = lines.find((l) => l.startsWith('[host-simulator] tools/list failed on runner '));
    expect(failure).toBeDefined();
    expect(failure).toContain('in flight:');
    const timing = lines.find((l) => l.includes('request timing method=tools/list '));
    expect(timing).toContain(' status=503 ');
    expect(timing).toMatch(/ headers_ms=\d+ /);
  });
});
