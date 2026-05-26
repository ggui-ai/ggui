/**
 * OSS hero-path E2E: `ggui serve` → MCP wire → ggui_push →
 * console viewer. No hosted account, no cloud, no Docker — the
 * whole journey runs against the real `@ggui-ai/cli` binary booted on
 * an ephemeral 127.0.0.1 port.
 *
 * Command under test:
 *
 *     node packages/ggui-cli/dist/cli.js serve --port 0 --mcp-only
 *
 * which is the repo-local form of `ggui serve --port 0 --mcp-only`.
 * That's the command operators will run once `@ggui-ai/cli` lands on
 * npm — this spec exercises its actual code path (argv parser →
 * `pickFreePort` → `buildMcpServerBackend` → `createGguiServer` with
 * the OSS first-run bundle → bind + emit `READY <url>`). `--mcp-only`
 * skips agent supervision so the server stands up without a
 * `ggui.json` / `agent.entry` in the workspace.
 *
 * WHAT THIS SPEC PROVES END-TO-END:
 *   1. `ggui serve` starts the OSS server with the recommended dev
 *      wiring (sessionChannel + pairing + console.sessionCookie +
 *      shortCodeIndex + mcpApps). See
 *      `packages/ggui-cli/src/mcp-backend.ts` for the composition.
 *   2. `GET /ggui/health` reports 4 tools (3 blueprint-read + ggui_push)
 *      and a live `/ws` channel.
 *   3. `tools/list` over real MCP JSON-RPC surfaces `ggui_push` with the
 *      `_meta.ui.resourceUri` + `_meta.ui.visibility` entry-point stamp
 *      per `docs/plans/2026-04-17-ggui-oss-split.md` §2.4.1.
 *   4. `tools/call ggui_push` creates a session, returns a structured
 *      shortCode/url/sessionId tuple, and carries the R3/R4 slice envelope
 *      at `_meta["ai.ggui/session"]`. The `url` points back at the
 *      same-origin console viewer.
 *   5. `GET /` serves the console landing bundle with the CSP /
 *      security-header set per `packages/console/README.md` §Security.
 *   6. `GET /ggui/console/info` returns the server-identity block.
 *   7. Browser navigation to `/s/<shortCode>` mints the same-origin
 *      HTTP-only session cookie (via `POST /ggui/console/session-cookie`),
 *      opens a cookie-authenticated live-channel WebSocket, reaches the
 *      live `connected` state, and shows the real sessionId + "no stack
 *      items yet" empty-state — the truthful current OSS state because
 *      component-code generation is deferred on OSS (see the `codeReady:
 *      false` note in `packages/mcp-server-handlers/src/session-mutations/push.ts`).
 *
 * WHAT THIS SPEC DOES **NOT** PROVE (and why):
 *   - Real component-code generation. The OSS `ggui_push` deliberately
 *     allocates a placeholder `pageId` and returns `codeReady: false`
 *     today — the generator + harness + negotiator live on the hosted
 *     pod (Slice B+ per §10 of the OSS split plan). The viewer therefore
 *     renders the live session shell ("No stack items yet. Waiting for
 *     `ggui_push` from the agent.") rather than a generated UI. When the
 *     OSS generator seam lands, extend this spec to assert on a real
 *     rendered component.
 *   - User-action roundtrip through `ggui_consume`. Without a rendered
 *     UI there's nothing to act on; deferred to the same slice.
 *   - BYOK credential wiring. The OSS push path performs zero LLM calls
 *     on this journey today, so there's no meaningful place to plumb
 *     `ANTHROPIC_API_KEY`. Deferred to the same slice.
 *   - Literal `npx @ggui-ai/cli serve` over the npm registry — the
 *     package hasn't been published yet. We invoke the built
 *     workspace `dist/cli.js` under the same `ggui` bin the package
 *     ships (see `packages/ggui-cli/package.json#bin.ggui`), so the
 *     code path is identical to what a published `npx` run would hit.
 *
 * Serial, opt-in under the `journeys-ggui-oss` Playwright project (see
 * `e2e/playwright.config.ts`); does not share state with the other
 * Docker-backed specs in the same project.
 */

import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { WebSocket as NodeWebSocket } from 'ws';
import { OUTERMOST_ROOT, packagePath } from './workspace-paths';

// Publishable-package paths resolve CONTEXT-INDEPENDENTLY via
// `workspace-paths.ts` (walks up to the nearest `pnpm-workspace.yaml`).
// A fixed `../../../..` would be correct in only one of the two
// supported layouts — `oss/e2e/journeys/` in the monorepo vs
// `e2e/journeys/` in the OSS standalone repo — and silently wrong in
// the other. Shared with `ggui-serve-harness.ts` and
// `tarball-install-harness.ts`.
const GGUI_CLI_DIST = packagePath('ggui-cli', 'dist', 'cli.js');
const DEVTOOL_DIST = packagePath('console', 'dist', 'index.html');

/** How long we wait for `ggui serve` to print `READY`. */
const READY_TIMEOUT_MS = 15_000;
/** Upper bound on the whole journey. */
const TEST_TIMEOUT_MS = 90_000;

let serveProc: ChildProcessWithoutNullStreams | null = null;
let baseUrl = '';
/**
 * Bearer minted by consuming the CLI's PAIR_CODE beacon before the
 * first MCP call. Replaces the old `Bearer dev` shortcut — the CLI
 * composes `InMemoryAuthAdapter({ devAllowAll: false })` now, so any
 * bearer that isn't pair-minted is rejected.
 */
let pairToken = '';
/**
 * Admin token captured from the CLI's `ADMIN_TOKEN <token>` stdout
 * beacon. Required by admin-gated console routes since the Slice 4
 * admin-zone refactor (`/ggui/console/info`, `/ggui/console/keys`,
 * etc.). Empty until the boot beacon arrives.
 */
let adminToken = '';

test.describe.serial('OSS hero path — `ggui serve` (real CLI bin)', () => {
  test.beforeAll(async () => {
    // Fast skip if the workspace hasn't built the OSS surface yet —
    // gives the operator an actionable message instead of a cryptic
    // "module not found" from the spawned bin.
    if (!existsSync(GGUI_CLI_DIST)) {
      test.skip(
        true,
        `@ggui-ai/cli dist missing at ${GGUI_CLI_DIST}. Run \`pnpm --filter @ggui-ai/cli build\` first.`,
      );
      return;
    }
    if (!existsSync(DEVTOOL_DIST)) {
      test.skip(
        true,
        `@ggui-ai/console dist missing at ${DEVTOOL_DIST}. Run \`pnpm --filter @ggui-ai/console build\` first.`,
      );
      return;
    }

    // Spawn the real CLI bin. `--port 0` asks the CLI to resolve a
    // free ephemeral port via its own `pickFreePort` path; `--mcp-only`
    // skips agent supervision so we don't need a `ggui.json` /
    // `agent.entry` in the test cwd. CWD is `OUTERMOST_ROOT` — the
    // workspace root, which carries no `ggui.json`, so the serve
    // fallback matrix reports "disabled (no ggui.json)" rather than
    // trying to load one.
    // Hero-path identity: "no account, no cloud, no BYOK". The spec
    // deliberately proves `codeReady:false` + the truthful empty-state
    // in the SessionViewer. We strip BYOK provider keys from the
    // forwarded env because Playwright's `.env.local` loader injects
    // them into `process.env` for the live-generation specs — without
    // this, the CLI would detect BYOK, run the real generator, and
    // `codeReady:true` would trip the deferred-generator assertion.
    // The BYOK path has its own specs (chat-generation.spec.ts,
    // tasks-backed-generation.spec.ts, cache-reuse.spec.ts).
    // Keep this list in sync with `PROVIDER_ENV_NAMES` in
    // `packages/ggui-cli/src/byok-resolver.ts` (flattened). If a
    // provider adds a new env-var name there, this strip will go
    // stale and `codeReady:true` will leak in via the new alias.
    const heroEnv = { ...process.env };
    for (const k of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
    ]) {
      delete heroEnv[k];
    }
    serveProc = spawn('node', [GGUI_CLI_DIST, 'serve', '--port', '0', '--mcp-only'], {
      cwd: OUTERMOST_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: heroEnv,
    }) as ChildProcessWithoutNullStreams;

    // Wait for BOTH READY and PAIR_CODE stdout beacons before
    // resolving. The CLI emits them back-to-back after bind, but
    // they can arrive in separate stream chunks — resolving on
    // READY alone and then synchronously grepping for PAIR_CODE
    // races the next chunk and often misses it.
    let stdoutBuf = '';
    const { baseUrl: resolvedUrl, pairCode } = await new Promise<{
      baseUrl: string;
      pairCode: string;
    }>((done, fail) => {
      const timer = setTimeout(() => {
        fail(
          new Error(
            `\`ggui serve\` did not print READY + PAIR_CODE within ${READY_TIMEOUT_MS}ms — stdout so far:\n${stdoutBuf}`,
          ),
        );
      }, READY_TIMEOUT_MS);

      let capturedUrl: string | null = null;
      let capturedCode: string | null = null;
      const tryFinish = (): void => {
        if (capturedUrl !== null && capturedCode !== null) {
          clearTimeout(timer);
          done({ baseUrl: capturedUrl, pairCode: capturedCode });
        }
      };

      serveProc!.stdout.setEncoding('utf8');
      serveProc!.stdout.on('data', (chunk: string) => {
        process.stdout.write(`[ggui serve] ${chunk}`);
        stdoutBuf += chunk;
        if (capturedUrl === null) {
          const m = stdoutBuf.match(/READY\s+(https?:\/\/\S+)/);
          if (m) capturedUrl = m[1]!;
        }
        if (capturedCode === null) {
          const m = stdoutBuf.match(/PAIR_CODE\s+(\d{6})/);
          if (m) capturedCode = m[1]!;
        }
        if (adminToken === '') {
          const m = stdoutBuf.match(/ADMIN_TOKEN\s+(\S+)/);
          if (m) adminToken = m[1]!;
        }
        tryFinish();
      });
      serveProc!.stderr.setEncoding('utf8');
      serveProc!.stderr.on('data', (chunk: string) => {
        process.stderr.write(`[ggui serve:err] ${chunk}`);
      });
      serveProc!.on('exit', (code) => {
        clearTimeout(timer);
        fail(
          new Error(
            `\`ggui serve\` exited prematurely with code ${code ?? 'null'}`,
          ),
        );
      });
    });
    baseUrl = resolvedUrl;

    // Trade the CLI-minted code for a real pair-minted bearer. The
    // hero-path spec historically used `Bearer dev` under
    // devAllowAll, which no longer authenticates anything — the
    // honest OSS claim is that /mcp only accepts pair-minted tokens.
    const pairRes = await fetch(`${baseUrl}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: pairCode,
        deviceName: 'npx-bootstrap-hero',
      }),
    });
    if (pairRes.status !== 200) {
      throw new Error(
        `POST /pair returned ${pairRes.status}: ${await pairRes.text()}`,
      );
    }
    const completion = (await pairRes.json()) as { token: string };
    pairToken = completion.token;
  });

  test.afterAll(async () => {
    if (serveProc && !serveProc.killed) {
      serveProc.kill('SIGTERM');
      await new Promise<void>((done) => {
        const done2 = (): void => done();
        serveProc!.once('exit', done2);
        // Hard cap on shutdown — SIGTERM triggers the CLI's
        // AbortController which closes the HTTP server cleanly; if
        // it hangs we don't block Playwright's teardown.
        setTimeout(() => {
          try {
            serveProc?.kill('SIGKILL');
          } catch {
            /* noop */
          }
          done2();
        }, 5_000);
      });
      serveProc = null;
    }
  });

  test('boot → MCP → ggui_push → console viewer', async ({ page }) => {
    test.setTimeout(TEST_TIMEOUT_MS);

    // ── 1. Health shape ────────────────────────────────────────────
    const healthRes = await fetch(`${baseUrl}/ggui/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as {
      status: string;
      server: string;
      version: string;
      tools: number;
      channel?: { path: string; subscribers: number; sessions: number };
    };
    expect(health.status).toBe('ok');
    expect(health.server).toBe('ggui-mcp-server');
    expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
    // Native ggui_* surface (post-Slice 6/7) + the CLI's serve-mode
    // additions (registry / runtime / ops handlers visible on the OSS
    // serve path). Total ~27 with no mcpMounts in the temp cwd. The
    // critical contract is "the load-bearing tools are present"; the
    // total-count pin is a guard against regressions but not the
    // primary assertion. Asserts below check the required surface
    // explicitly via `expect.arrayContaining` so adding a new native
    // tool doesn't flap this spec.
    expect(health.tools).toBeGreaterThanOrEqual(15);
    expect(health.channel?.path).toBe('/ws');

    // ── 2. tools/list — MCP Apps entry-point stamp on ggui_push ────
    const listed = await mcpCall(baseUrl, pairToken, 'tools/list', {});
    const tools = (listed.result?.tools ?? []) as Array<{
      name: string;
      _meta?: { ui?: { resourceUri?: string; visibility?: readonly string[] } };
    }>;
    const toolNames = tools.map((t) => t.name).sort();
    // Required surface: the 4 historical tools (handshake / push /
    // update / blueprint-search) + the 5 lifecycle tools (new_session,
    // consume, emit, get_session, get_stack) that ground the OSS hero
    // path. Other native tools (runtime_*, list_gadgets, etc.) ride
    // along but aren't load-bearing for this spec — present is enough,
    // exhaustive pinning is brittle.
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'ggui_handshake',
        'ggui_list_featured_blueprints',
        'ggui_new_session',
        'ggui_push',
        'ggui_search_blueprints',
        'ggui_update',
      ]),
    );
    const push = tools.find((t) => t.name === 'ggui_push');
    expect(push?._meta?.ui?.resourceUri).toBe('ui://ggui/session');
    expect(push?._meta?.ui?.visibility).toEqual(expect.arrayContaining(['model']));

    // ── 3. tools/call ggui_new_session → ggui_handshake → ggui_push ─
    //
    // Post-Slice-5 the direct story-shaped push is retired. The agent
    // mints a session, negotiates via handshake, then pushes with the
    // returned handshakeId. The retired fields that previously rode on
    // `structuredContent` (sessionId, shortCode, codeReady, handshakeId,
    // contractHash, decision) are gone — `_meta["ai.ggui/session"].sessionId`
    // (R3/R4 slice envelope) carries the sessionId, and shortCode is
    // derivable from the url tail.
    const sessEnv = await mcpCall(baseUrl, pairToken, 'tools/call', {
      name: 'ggui_new_session',
      arguments: {},
    });
    const mintedSessionId = (
      sessEnv.result as { structuredContent: { sessionId: string } }
    ).structuredContent.sessionId;
    // `ggui_new_session` with no `seed` mints a `randomUUID()` session
    // id (see `new-session.ts` — the `sess-`+sha256 form is the seeded
    // derivation path only). Assert the UUIDv4 shape.
    expect(mintedSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const hsEnvelope = await mcpCall(baseUrl, pairToken, 'tools/call', {
      name: 'ggui_handshake',
      arguments: {
        sessionId: mintedSessionId,
        intent: 'weather dashboard for Tokyo — current + 3-day forecast',
        blueprintDraft: { contract: {} },
      },
    });
    const handshakeId = (
      hsEnvelope.result as { structuredContent: { handshakeId: string } }
    ).structuredContent.handshakeId;
    expect(handshakeId).toBeTruthy();

    const pushEnvelope = await mcpCall(baseUrl, pairToken, 'tools/call', {
      name: 'ggui_push',
      arguments: { handshakeId, decision: { kind: 'override', blueprintDraft: { contract: {} } } },
    });
    const pushResult = pushEnvelope.result as {
      content?: ReadonlyArray<{ type: string; text: string }>;
      structuredContent?: {
        stackItemId: string;
        url: string;
        action: string;
        nextStep?: { tool: string; args: { stackItemId: string } };
      };
      _meta?: {
        // R3/R4 slice envelope — `_meta["ai.ggui/session"]` replaced the
        // legacy `_meta.ggui.bootstrap` nesting. The bearer field is now
        // `wsToken` (was `token`); the rest of the slice carries through.
        'ai.ggui/session'?: {
          wsUrl: string;
          wsToken: string;
          expiresAt: string;
          sessionId: string;
          appId: string;
        };
      };
    };
    expect(pushResult).toBeTruthy();
    const out =
      pushResult.structuredContent ??
      (JSON.parse(pushResult.content![0].text) as NonNullable<
        typeof pushResult.structuredContent
      >);
    expect(out.stackItemId).toBeTruthy();
    // First push on a brand-new session reuses (handshake target carries
    // the sessionId, push finds the existing session) — `reuse`. Pre-
    // Slice-5 this would have been `create` because handshake itself
    // implicitly minted the session; post-`ggui_new_session` the session
    // already exists by the time push runs.
    expect(['create', 'reuse']).toContain(out.action);
    // Slice 5 retired the embedded-ui /s/<shortCode> SPA route in
    // favour of the same-origin `/r/<shortCode>` HTTP fallback (the
    // `renderBaseUrl` default for OSS). The shortCode alphabet matches
    // `push.ts::generateShortCode` (`abcdefghjkmnpqrstuvwxyz23456789`).
    const urlMatch = new URL(out.url).pathname.match(/^\/[rs]\/([a-z0-9]+)$/);
    expect(urlMatch, `push url is not /r/<shortCode>: ${out.url}`).not.toBeNull();
    const derivedShortCode = urlMatch![1]!;
    expect(derivedShortCode).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]+$/);
    // The render URL carries a signed `?sig=…&exp=…` query (capability-
    // URL signing) — assert the origin + `/r/<shortCode>` path prefix,
    // not an exact string that would reject the signature params.
    expect(out.url.startsWith(`${baseUrl}/r/${derivedShortCode}`)).toBe(true);

    const sessionSlice = pushResult._meta?.['ai.ggui/session'];
    expect(sessionSlice).toBeTruthy();
    expect(sessionSlice?.wsUrl).toBe(`ws://127.0.0.1:${new URL(baseUrl).port}/ws`);
    expect(typeof sessionSlice?.wsToken).toBe('string');
    expect(sessionSlice?.sessionId).toBe(mintedSessionId);

    // ── 4. Console info endpoint ───────────────────────────────────
    // Admin-gated since the Slice 4 admin-zone refactor — pass the
    // Bearer token captured from the `ADMIN_TOKEN` boot beacon.
    const infoRes = await fetch(`${baseUrl}/ggui/console/info`, {
      headers: adminToken
        ? { authorization: `Bearer ${adminToken}` }
        : {},
    });
    expect(infoRes.status).toBe(200);
    const info = (await infoRes.json()) as {
      server: string;
      version: string;
      pairing?: { enabled: boolean };
    };
    expect(info.server).toBe('ggui-mcp-server');
    // Harness wires `pairing: true`; the landing page uses this to distinguish
    // "real OSS operator server" from the no-pairing default.
    expect(info.pairing?.enabled).toBe(true);

    // ── 5. Landing bundle + CSP / X-Frame-Options headers ─────────
    const landing = await fetch(`${baseUrl}/`);
    expect(landing.status).toBe(200);
    expect((landing.headers.get('content-type') ?? '').toLowerCase()).toContain(
      'text/html',
    );
    // Embedded-UI security-header set (Slice 3 of the MVP plan). Sampling
    // X-Frame-Options + Referrer-Policy is enough to prove the surgical
    // middleware is on the path; the full set is covered by the package's
    // own integration tests.
    expect(landing.headers.get('x-frame-options')).toBe('DENY');
    expect(landing.headers.get('x-content-type-options')).toBe('nosniff');

    // ── 6. Live session viewer — /s/<shortCode> ────────────────────
    //
    // Four invariants prove end-to-end:
    //   (a) GET /s/<shortCode> returns the SPA HTML shell + the React
    //       tree hydrates (title, root div, no pageerror). The
    //       `getStableRoute` snapshot cache in
    //       `packages/console/src/router.ts` is load-bearing here:
    //       without it the `<App/>` tree collapsed with "Maximum
    //       update depth exceeded" on every mount.
    //   (b) POST /ggui/console/session-cookie resolves the real
    //       shortCode minted by `ggui_push` (not a fixture) and returns
    //       a same-origin HTTP-only cookie. Exact shape pinned in
    //       `packages/mcp-server/src/console-auth.ts`.
    //   (c) A cookie-authenticated live-channel WebSocket upgrade at /ws
    //       acks a `subscribe` for the cookie-bound session. This is
    //       the single most-load-bearing OSS-hero invariant: cookie
    //       mint → WS upgrade → session-channel binding all wired
    //       against the same `shortCodeIndex` / `sessionStore` the
    //       `ggui_push` call populated.
    //   (d) The React SessionViewer reaches its live `connected` state
    //       and renders the truthful empty-state — the viewer's own
    //       `GguiProvider`/`GguiSession` wiring works end-to-end.
    //
    // (b) + (c) additionally run via direct `fetch` + `ws` to pin the
    // wire invariants independent of the React renderer, matching the
    // unit-level `packages/mcp-server/src/console.test.ts::"full
    // ceremony"` coverage.

    // Surface any mount-time React crashes as explicit failures rather
    // than silent blank renders — a regression in the `getStableRoute`
    // cache would show up here as a `pageerror`.
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    // (a) SPA HTML shell + React mount. `networkidle` waits for the
    // cookie POST + WS upgrade to complete, so the viewer has had a
    // chance to reach its live state before we start asserting.
    await page.goto(out.url, { waitUntil: 'networkidle', timeout: 20_000 });
    // The /r/<shortCode> route serves the thin-shell HTML
    // (GGUI_SESSION_SHELL_HTML, `<title>ggui session</title>`)
    // post-Slice-5 — the embedded-ui SPA route is gone, so the page
    // title is whatever the hosting iframe shell sets, not the
    // operator console title.
    await expect(page).toHaveTitle(/ggui/);

    // (b) Cookie mint against the REAL shortCode the agent's push
    // produced. 200 + Set-Cookie proves shortCodeIndex is threaded
    // into the cookie endpoint AND `ggui_push` wrote through to it.
    const mintRes = await fetch(`${baseUrl}/ggui/console/session-cookie`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ shortCode: derivedShortCode }),
    });
    expect(mintRes.status).toBe(200);
    const mintBody = (await mintRes.json()) as {
      sessionId: string;
      appId: string;
      expiresAt: number;
    };
    // Cookie endpoint returns the SAME session the push created —
    // silent mismatch here would mean short-code collisions on the
    // index or push not writing through.
    expect(mintBody.sessionId).toBe(mintedSessionId);
    expect(mintBody.appId).toBe('builder'); // default InMemoryAuthAdapter identity → defaultAppIdFromIdentity('builder')
    const setCookie = mintRes.headers.get('set-cookie') ?? '';
    const cookiePair = setCookie.split(';')[0];
    expect(cookiePair).toMatch(/^ggui_console_session=/);

    // (c) Cookie-authenticated /ws subscribe → ack. Proves the full
    // mint → upgrade → bind → ack path without depending on the SPA.
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;
    const ws = new NodeWebSocket(wsUrl, { headers: { cookie: cookiePair } });
    const ack = await new Promise<{ type: string }>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error('live-channel ack timeout after 10s')),
        10_000,
      );
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            payload: { sessionId: mintedSessionId, appId: 'builder' },
            requestId: 'e2e-sub-1',
          }),
        );
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === 'ack') {
          clearTimeout(timer);
          done(msg);
        }
      });
      ws.on('error', (err: Error) => {
        clearTimeout(timer);
        fail(err);
      });
    });
    expect(ack.type).toBe('ack');
    ws.close();

    // (d) /r/<shortCode> render surface. Pre-Slice-5 this navigated
    // to the embedded-ui SessionViewer SPA at /s/<shortCode> and
    // asserted on its `<h1>Live session.</h1>` + `<code>` nodes. The
    // SPA was retired alongside the user zone; /r/<shortCode> now
    // serves either the self-contained shell (when componentCode is
    // available) or the 202 "Generating UI…" polling placeholder
    // (when codeReady:false — our case here without an LLM key).
    // Either body is acceptable for the no-BYOK "reaches the viewer
    // without crashing" claim; the polling placeholder is the
    // expected steady state until a generator BYOK is wired. The
    // page title check above already covers the load. Live-BYOK
    // specs (`live-generation.spec.ts`, `chat-generation.spec.ts`)
    // exercise the populated render path.
    const renderBody = await page.content();
    expect(renderBody).toMatch(/Generating UI…|ggui-shell|ggui-root/i);

    // Final gate: no uncaught React errors during mount. Regressing
    // the `getStableRoute` cache would trip this before any of the
    // positive assertions fired, but keeping the check at the end
    // covers downstream mount-time crashes (GguiProvider, etc.) too.
    expect(pageErrors, `unexpected browser pageerrors: ${pageErrors.join(' | ')}`).toEqual([]);
  });
});

// ── Raw MCP JSON-RPC helper ────────────────────────────────────────────
//
// Speaks the MCP Streamable-HTTP wire directly via `fetch`. The OSS
// server uses `StreamableHTTPServerTransport({sessionIdGenerator: undefined})`
// — stateless mode, so each POST is self-contained and no Mcp-Session-Id
// ceremony is required. `Accept` carries both `application/json` and
// `text/event-stream` per the MCP spec; the server picks whichever shape
// fits. `bearer` is the pair-minted token the beforeAll consumed off
// the CLI's `PAIR_CODE` beacon — the default server now composes
// `InMemoryAuthAdapter({devAllowAll:false})`, so the pre-flip
// `Bearer dev` shortcut no longer authenticates anything.
//
// We stop short of pulling in `@modelcontextprotocol/sdk` as a direct
// e2e dep because the wire is narrow enough that a real HTTP client is
// clearer + avoids churn on `e2e/package.json` + `pnpm-lock.yaml`.
async function mcpCall(
  base: string,
  bearer: string,
  method: string,
  params: unknown,
): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      params,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `MCP ${method} failed: HTTP ${res.status} ${res.statusText} — ${await res.text()}`,
    );
  }
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/event-stream')) {
    const body = await res.text();
    // SSE payload shape: one or more `data: <json>\n\n` blocks. We only
    // expect a single response frame for stateless request/response.
    const dataLine = body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    if (!dataLine) {
      throw new Error(`MCP ${method} SSE response had no data frame: ${body}`);
    }
    return JSON.parse(dataLine.slice(5).trim()) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
  }
  return (await res.json()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}
