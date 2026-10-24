/**
 * ggui#1822 — the meter says WHEN each POST went onto the wire and whether a
 * connection was opened for it, the shell read's first-byte gate counts from
 * that write, a reader that stops after the headers is not a failure, and a
 * spec can wait for the server to have a call instead of sleeping.
 *
 * Bought by two P0 reds on a lossy office line (ggui#1935): one connection
 * took 10 s to open, and the 15 s gate, counted from the request's creation,
 * then failed a read that had been on the wire for 5 s as "no response".
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostSimulator, bootOssServer, type OssFixture } from '../src/index.js';
import { RequestMeter, RequestProbe } from '../src/shell-read.js';

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
    });
  });
}

const body = (method: string, params: object = {}): string => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function captureStderr(): string[] {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: never[]) => {
    lines.push(String(chunk));
    return original(chunk, ...rest);
  }) as typeof process.stderr.write);
  return lines;
}

describe('RequestProbe: the first-byte gate counts from the write (ggui#1822)', () => {
  it('does not fire while the request is still unwritten, however long that takes', async () => {
    const probe = new RequestProbe('resources/read', 30, 60_000);
    await sleep(90);
    expect(probe.abort.signal.aborted).toBe(false);
    probe.onWritten(null);
    await sleep(90);
    expect(probe.abort.signal.aborted).toBe(true);
    expect(String((probe.abort.signal.reason as Error).message)).toMatch(
      /^no response body byte within the 30 ms first-byte gate, counted from the write \(written \+\d+ ms \(reused connection\), no response headers either\)$/,
    );
  });

  it('a body byte before the write leaves the gate unarmed', async () => {
    const probe = new RequestProbe('resources/read', 30, 60_000);
    probe.onChunk(1);
    probe.onWritten(null);
    await sleep(90);
    expect(probe.abort.signal.aborted).toBe(false);
  });
});

describe('RequestMeter: the write, the connection and how the transfer ended (ggui#1822)', () => {
  let server: Server | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server!.close(() => r()));
    }
    server = null;
  });

  it("connection=new|reused agrees with the server's own count of the connections it accepted", async () => {
    const lines = captureStderr();
    let accepted = 0;
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
    });
    server.on('connection', () => (accepted += 1));
    const url = await listen(server);
    const meter = new RequestMeter();
    const labels: string[] = [];
    const counts: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const before = accepted;
      await (await meter.fetch(url, { method: 'POST', body: body('tools/list') })).text();
      counts.push(accepted - before);
      const line = lines.filter((l) => l.startsWith('[host-simulator] request timing method=tools/list ')).at(-1)!;
      labels.push(/ connection=(new|reused) /.exec(line)![1]!);
      // Let undici return the socket to its pool, so a later request can ride it.
      await sleep(20);
    }
    expect(labels).toEqual(counts.map((n) => (n === 1 ? 'new' : 'reused')));
    expect(labels[0]).toBe('new');
    expect(labels).toContain('reused');
  });

  it('carries its tag header to the server, and only that header is added', async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    server = createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200).end('{}');
    });
    const url = await listen(server);
    await (await new RequestMeter().fetch(url, { method: 'POST', body: body('tools/list'), headers: { 'x-keep': '1' } })).text();
    expect(seen['x-ggui-host-sim-request']).toMatch(/^\d+\.\d+$/);
    expect(seen['x-keep']).toBe('1');
  });

  it('a reader that stops after the headers is cancelled, not failed, and is reported once', async () => {
    const lines = captureStderr();
    server = createServer((_req, res) => {
      res.writeHead(202, { 'content-type': 'text/plain' });
      res.flushHeaders();
    });
    const url = await listen(server);
    const res = await new RequestMeter().fetch(url, { method: 'POST', body: body('notifications/initialized') });
    await res.body!.cancel();
    const timing = lines.filter((l) => l.includes('request timing method=notifications/initialized '));
    expect(timing).toHaveLength(1);
    expect(timing[0]).toContain(' outcome=cancelled status=202 ');
  });

  it("the caller's own abort mid-body is cancelled, not failed; the line keeps how far the body got", async () => {
    // The MCP SDK's close() aborts every open POST. A spec that ends right
    // after its last answer closes that call's stream before the server's end
    // arrives: every green P0 run printed four `outcome=failed` lines for it.
    const lines = captureStderr();
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    });
    const url = await listen(server);
    const caller = new AbortController();
    const res = await new RequestMeter().fetch(url, { method: 'POST', body: body('tools/call', { name: 'x' }), signal: caller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    caller.abort();
    await expect(reader.read()).rejects.toThrow();
    const timing = lines.filter((l) => l.includes('request timing method=tools/call '));
    expect(timing).toHaveLength(1);
    expect(timing[0]).toContain(' outcome=cancelled status=200 ');
    expect(timing[0]).toMatch(/ bytes=[1-9]\d* /);
  });

  it('a body the server breaks off is still failed', async () => {
    const lines = captureStderr();
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: partial\n\n', () => setTimeout(() => res.socket?.destroy(), 20));
    });
    const url = await listen(server);
    const res = await new RequestMeter().fetch(url, { method: 'POST', body: body('tools/call', { name: 'x' }) });
    await expect(res.text()).rejects.toThrow();
    const timing = lines.filter((l) => l.includes('request timing method=tools/call '));
    expect(timing).toHaveLength(1);
    expect(timing[0]).toContain(' outcome=failed status=200 ');
  });

  it("watchNext hands over the matching call's probe, and headersArrived says when the server has it", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    server = createServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      await held;
      res.end('data: {}\n\n');
    });
    const url = await listen(server);
    const meter = new RequestMeter();
    const other = meter.watchNext('tools/call', 'ggui_other');
    const watch = meter.watchNext('tools/call', 'ggui_consume');
    const pending = meter.fetch(url, { method: 'POST', body: body('tools/call', { name: 'ggui_consume' }) });
    const probe = await watch.probe;
    expect(probe.toolName).toBe('ggui_consume');
    await expect(probe.headersArrived()).resolves.toBe(true);
    expect(probe.ended).toBe(false);
    release();
    await (await pending).text();
    other.cancel();
  });

  it('headersArrived is false for a request that ended without headers', async () => {
    server = createServer((req) => req.socket.destroy());
    const url = await listen(server);
    const meter = new RequestMeter();
    const watch = meter.watchNext('tools/call');
    await expect(meter.fetch(url, { method: 'POST', body: body('tools/call', { name: 'x' }) })).rejects.toThrow();
    await expect((await watch.probe).headersArrived()).resolves.toBe(false);
  });

  it('a cancelled watch matches nothing later', async () => {
    server = createServer((_req, res) => res.writeHead(200).end('{}'));
    const url = await listen(server);
    const meter = new RequestMeter();
    const stale = meter.watchNext('tools/call', 'ggui_consume');
    stale.cancel();
    const fresh = meter.watchNext('tools/call', 'ggui_consume');
    await (await meter.fetch(url, { method: 'POST', body: body('tools/call', { name: 'ggui_consume' }) })).text();
    const winner = await Promise.race([stale.probe.then(() => 'stale'), fresh.probe.then(() => 'fresh')]);
    expect(winner).toBe('fresh');
  });
});

describe('HostSimulator.callToolTracked (ggui#1822)', () => {
  let fixture: OssFixture | null = null;
  let host: HostSimulator | null = null;
  afterEach(async () => {
    if (host) await host.close();
    host = null;
    if (fixture) await fixture.close();
    fixture = null;
  });

  it('accepted resolves true once the server has the call, and the result is the plain callTool result', async () => {
    fixture = await bootOssServer();
    host = new HostSimulator({ url: fixture.url, bearer: 'host-simulator-test' });
    await host.connect();
    const tracked = host.callToolTracked('ggui_get_session', { sessionId: 'no-such-session' });
    await expect(tracked.accepted).resolves.toBe(true);
    const result = await tracked.result;
    expect(result).toBeDefined();
  });
});
