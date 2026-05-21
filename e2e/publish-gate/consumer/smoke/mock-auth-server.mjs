/**
 * Mock ggui.ai auth server for the publish gate.
 *
 * `ggui login` is an RFC 8628 device-flow client; its endpoints live on
 * api.ggui.ai. The gate is hermetic (no outbound network), so instead
 * of the real cloud the CLI is pointed at this mock via the
 * `GGUI_API_URL` env override — the same override operators use for
 * sandbox testing.
 *
 * It implements exactly the four endpoints the CLI's auth commands hit
 * and auto-approves immediately (no human "enter the code" step), so
 * `ggui login` / `whoami` / `keys` run fully non-interactively.
 *
 * This MUST run as its own process: cli-smoke.mjs drives the `ggui`
 * binary with the blocking `spawnSync`, which freezes its event loop —
 * an in-process server would be unable to answer the CLI's requests.
 * Run standalone:
 *
 *   node mock-auth-server.mjs
 *     → prints `MOCK_AUTH_URL=http://127.0.0.1:<port>` to stdout,
 *       then serves until killed.
 *
 * Testing the CLI's *client* code is the point — does the published
 * @ggui-ai/cli speak the protocol. The real device flow against live
 * ggui.ai is exercised by e2e/'s hosted-journeys suite, not here.
 */
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0];
    const send = (obj, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    // RFC 8628 step 1 — device authorization request.
    if (req.method === 'POST' && url === '/v1/auth/device') {
      return send({
        device_code: 'mock-device-code',
        user_code: 'MOCK-CODE',
        verification_uri: 'http://mock-auth.invalid/verify',
        verification_uri_complete: 'http://mock-auth.invalid/verify?user_code=MOCK-CODE',
        expires_in: 600,
        interval: 1,
      });
    }

    // RFC 8628 step 3 — token poll. Auto-approve: tokens on first poll.
    if (req.method === 'POST' && url === '/v1/auth/poll') {
      return send({
        access_token: 'mock-access-token',
        refresh_token: 'mock-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        session_id: 'mock-session-id',
      });
    }

    // `ggui whoami` — GET /v1/me with the bearer.
    if (req.method === 'GET' && url === '/v1/me') {
      return send({
        userId: 'mock-user-id',
        sessionId: 'mock-session-id',
        clientName: 'ggui CLI (publish-gate)',
        accessExpiresAt: Date.now() + 3600_000,
      });
    }

    // `ggui keys list` (cloud mode) — GET /v1/keys.
    if (req.method === 'GET' && url === '/v1/keys') {
      return send({ keys: [] });
    }

    send(
      { error: 'not_found', message: `mock-auth: no route for ${req.method} ${url}` },
      404,
    );
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`MOCK_AUTH_URL=http://127.0.0.1:${server.address().port}\n`);
});
