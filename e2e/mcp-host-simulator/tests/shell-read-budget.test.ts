/**
 * ggui#1822 — a `ui://` shell read has two budgets and reports its timing.
 *
 *   - The first body byte must arrive within a tight first-byte gate: a server
 *     that stops answering fails fast, whatever the body budget is.
 *   - The whole read gets the body budget from `GGUI_E2E_BODY_TIMEOUT_MS`
 *     (default 60 s), set per runner class: only the drain gets slack.
 *   - Every read records first byte, drain, bytes and the content encoding, on
 *     stderr and in the GitHub step summary.
 *
 * A proxy in front of a real OSS server forwards every request and treats only
 * `resources/read` according to the test: gzip it, hold it after the headers,
 * or hold it after the first chunk of the body.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BODY_TIMEOUT_ENV,
  DEFAULT_BODY_TIMEOUT_MS,
  HostSimulator,
  bootOssServer,
  readBodyTimeoutMs,
  type OssFixture,
} from '../src/index.js';

type ReadMode = 'gzip' | 'hold-after-headers' | 'hold-after-first-chunk';

interface ReadProxy {
  readonly server: Server;
  readonly url: string;
  /** The request headers of each `resources/read` the proxy saw. */
  readonly readHeaders: IncomingHttpHeaders[];
}

function readProxy(target: string, mode: ReadMode): Promise<ReadProxy> {
  const upstream = new URL(target);
  const readHeaders: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const isJsonRpc = req.method === 'POST' && (req.headers['content-type'] ?? '').includes('application/json');
      const method = isJsonRpc ? (JSON.parse(body.toString('utf8')) as { method?: unknown }).method : undefined;
      const isRead = method === 'resources/read';
      if (isRead) readHeaders.push(req.headers);
      if (isRead && mode === 'hold-after-headers') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
        return;
      }
      const fwd = request(
        { host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers },
        (up) => {
          if (!isRead) {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
            return;
          }
          const parts: Buffer[] = [];
          up.on('data', (c: Buffer) => parts.push(c));
          up.on('end', () => {
            const whole = Buffer.concat(parts);
            const headers = { ...up.headers };
            delete headers['content-length'];
            if (mode === 'gzip') {
              const zipped = gzipSync(whole);
              res.writeHead(up.statusCode ?? 502, { ...headers, 'content-encoding': 'gzip', 'content-length': String(zipped.length) });
              res.end(zipped);
              return;
            }
            // hold-after-first-chunk: some of the body, then nothing.
            res.writeHead(up.statusCode ?? 502, headers);
            res.write(whole.subarray(0, Math.min(1024, whole.length - 1)));
          });
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
      resolve({ server, url: `http://127.0.0.1:${port}`, readHeaders });
    });
  });
}

describe('readBodyTimeoutMs: the body budget comes from the environment (ggui#1822)', () => {
  it('is 60 s when the variable is unset', () => {
    expect(readBodyTimeoutMs({})).toBe(DEFAULT_BODY_TIMEOUT_MS);
    expect(DEFAULT_BODY_TIMEOUT_MS).toBe(60_000);
  });

  it('reads a positive integer of milliseconds', () => {
    expect(readBodyTimeoutMs({ [BODY_TIMEOUT_ENV]: '180000' })).toBe(180_000);
  });

  it.each(['', '0', '-5', '1.5', '180s', ' 180000'])('refuses %j instead of falling back to the default', (raw) => {
    expect(() => readBodyTimeoutMs({ [BODY_TIMEOUT_ENV]: raw })).toThrow(BODY_TIMEOUT_ENV);
  });
});

describe('host-simulator: a shell read is gated on its first byte and timed on its drain (ggui#1822)', () => {
  let fixture: OssFixture | null = null;
  let proxy: Server | null = null;
  let host: HostSimulator | null = null;
  const savedBudget = process.env[BODY_TIMEOUT_ENV];
  const savedSummary = process.env['GITHUB_STEP_SUMMARY'];
  let summaryDir: string | null = null;

  afterEach(async () => {
    if (savedBudget === undefined) delete process.env[BODY_TIMEOUT_ENV];
    else process.env[BODY_TIMEOUT_ENV] = savedBudget;
    if (savedSummary === undefined) delete process.env['GITHUB_STEP_SUMMARY'];
    else process.env['GITHUB_STEP_SUMMARY'] = savedSummary;
    if (summaryDir) rmSync(summaryDir, { recursive: true, force: true });
    summaryDir = null;
    if (host) await host.close();
    host = null;
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise<void>((r) => proxy!.close(() => r()));
    }
    proxy = null;
    if (fixture) await fixture.close();
    fixture = null;
  });

  async function connectThrough(mode: ReadMode, firstByteTimeoutMs?: number): Promise<ReadProxy> {
    fixture = await bootOssServer();
    const p = await readProxy(fixture.url, mode);
    proxy = p.server;
    host = new HostSimulator({
      url: p.url,
      bearer: 'host-simulator-test',
      ...(firstByteTimeoutMs !== undefined ? { firstByteTimeoutMs } : {}),
    });
    await host.connect();
    return p;
  }

  it('asks for gzip, decodes it, and records the encoding, the drain and the bytes', async () => {
    summaryDir = mkdtempSync(join(tmpdir(), 'host-sim-summary-'));
    const summary = join(summaryDir, 'summary.md');
    process.env['GITHUB_STEP_SUMMARY'] = summary;
    const p = await connectThrough('gzip');

    const tools = await host!.listTools({ prefetchShells: true });
    const render = tools.find((t) => t.name === 'ggui_render');
    expect(host!.getPrefetchedResource(render!.resourceUri!)).toMatch(/<html/i);

    expect(p.readHeaders.length).toBeGreaterThan(0);
    for (const h of p.readHeaders) expect(h['accept-encoding']).toContain('gzip');

    const reads = host!.getShellReads();
    expect(reads.length).toBe(p.readHeaders.length);
    const first = reads[0]!;
    expect(first.outcome).toBe('ok');
    expect(first.contentEncoding).toBe('gzip');
    expect(first.bytes).toBeGreaterThan(0);
    expect(first.firstByteMs).not.toBeNull();
    expect(first.drainMs).not.toBeNull();
    expect(first.bodyBudgetMs).toBe(savedBudget === undefined ? DEFAULT_BODY_TIMEOUT_MS : Number(savedBudget));

    const lines = readFileSync(summary, 'utf8').trim().split('\n');
    expect(lines.length).toBe(reads.length);
    expect(lines[0]).toContain(first.uri);
    expect(lines[0]).toContain(`drain ${first.drainMs} ms`);
    expect(lines[0]).toContain('gzip');
  });

  it('fails at the first-byte gate when the headers arrive and the body does not, long before the body budget', async () => {
    delete process.env[BODY_TIMEOUT_ENV];
    await connectThrough('hold-after-headers', 300);

    const started = Date.now();
    const err = await host!.listTools({ prefetchShells: true }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('300 ms first-byte gate');
    expect((err as Error).message).toContain('headers after');
    const [read] = host!.getShellReads();
    expect(read?.outcome).toBe('failed');
    expect(read?.firstByteMs).toBeNull();
    expect(read?.headersMs).not.toBeNull();
  });

  it('gives the drain the body budget from the environment, and fails at it naming what had arrived', async () => {
    process.env[BODY_TIMEOUT_ENV] = '800';
    await connectThrough('hold-after-first-chunk', 5_000);

    const started = Date.now();
    const err = await host!.listTools({ prefetchShells: true }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('budget 800 ms');
    expect((err as Error).message).toMatch(/timed out/i);
    const [read] = host!.getShellReads();
    expect(read?.outcome).toBe('failed');
    expect(read?.firstByteMs).not.toBeNull();
    expect(read?.bytes).toBeGreaterThan(0);
    expect(read?.bodyBudgetMs).toBe(800);
  });
});
