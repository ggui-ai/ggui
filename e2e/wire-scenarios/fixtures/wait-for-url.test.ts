import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForUrl } from './wait-for-url';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** The port a listening server bound. */
function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error(`expected a TCP address, got ${String(address)}`);
  }
  return address.port;
}

/** The message a wait rejected with; fails the test when it resolved. */
async function timeoutMessage(wait: Promise<unknown>): Promise<string> {
  const outcome = await wait.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(outcome instanceof Error)) {
    throw new Error(`expected the wait to reject, got ${String(outcome)}`);
  }
  return outcome.message;
}

/** A local server answering every request with `handler`; resolves to its base URL. */
async function serve(
  handler: Parameters<typeof createServer>[1],
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${portOf(server)}/`;
}

/** A port that was just free: bound, read, released. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = portOf(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const fast = { pollMs: 20, attemptTimeoutMs: 100 };

describe('waitForUrl: a timeout names what the last probe saw', () => {
  it('returns how long the URL took and how many probes it needed', async () => {
    let calls = 0;
    const url = await serve((_req, res) => {
      calls += 1;
      res.statusCode = calls < 3 ? 503 : 200;
      res.end();
    });
    const ready = await waitForUrl(url, { timeoutMs: 2_000, ...fast });
    expect(ready.attempts).toBe(3);
    expect(ready.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('nothing listening: the error says the connection was refused, and that nothing answered', async () => {
    const url = `http://127.0.0.1:${await freePort()}/`;
    const message = await timeoutMessage(
      waitForUrl(url, { timeoutMs: 300, ...fast }),
    );
    expect(message).toContain(`Timed out after 300ms waiting for ${url}`);
    expect(message).toContain('last: connection refused (ECONNREFUSED)');
    expect(message).toContain('no HTTP answer');
  });

  it('bound but not ready: the error carries the last status and when the first answer came', async () => {
    const url = await serve((_req, res) => {
      res.statusCode = 503;
      res.end();
    });
    const message = await timeoutMessage(
      waitForUrl(url, { timeoutMs: 300, ...fast }),
    );
    expect(message).toContain('last: HTTP 503');
    expect(message).toMatch(/first HTTP answer at \d+ms/);
  });

  it('accepts the connection and never answers: the error says no answer came within the probe limit', async () => {
    const url = await serve(() => {
      /* hold the request open */
    });
    const message = await timeoutMessage(
      waitForUrl(url, { timeoutMs: 300, ...fast }),
    );
    // The last probe's limit is capped by what is left of the overall budget.
    expect(message).toMatch(/last: no answer within \d+ms/);
    expect(message).toContain('no HTTP answer');
  });

  it('a probe never runs past the overall deadline', async () => {
    const url = await serve(() => {
      /* hold the request open */
    });
    const started = Date.now();
    await waitForUrl(url, {
      timeoutMs: 150,
      pollMs: 20,
      attemptTimeoutMs: 5_000,
    }).catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
