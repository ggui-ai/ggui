/**
 * Phase 5 `ggui` OSS — pair flow + clean-room + zero-hosted-network +
 * real `/mcp` auth.
 *
 * What this spec proves end-to-end (per
 * `docs/plans/2026-04-21-oss-split-e2e-phases.md` §9.1 + the
 * strict-auth follow-on slice):
 *
 *   - G5  `/admin/pair/init` + `/pair` lifecycle is real HTTP, not
 *         just a unit. Pre-mint on boot → wrong code → successful
 *         consume → one-shot replay rejection → admin-init with the
 *         just-minted builder token → second consume.
 *   - G6  A token minted by `POST /pair` authenticates a real MCP
 *         `tools/list` AND `tools/call ggui_render` — proves the
 *         `onTokenIssued` bridge registered the token on the live
 *         `AuthAdapter` at mint time, along the full write-path.
 *   - G14 No browser-side request targets hosted infrastructure
 *         (`ggui.ai`, `amazonaws.com`, `cognito.com`). The gate aborts
 *         + records; the spec asserts `[]` at teardown.
 *   - G16 The spawned `ggui serve` runs from a fresh `mkdtempSync`
 *         CWD under an explicit env allowlist — zero ambient-state
 *         inheritance (no walked-up `ggui.json`, no `GGUI_*` /
 *         `AWS_*` / `ANTHROPIC_*` / `COGNITO_*` / proxy-var leakage).
 *   - **`/mcp` strict-auth** — a bearer the adapter does not recognise
 *         is rejected with HTTP 401 and the canonical JSON-RPC error
 *         envelope (`code: -32000`, `message: "No valid credentials"`).
 *         This is the load-bearing assertion the earlier slice could
 *         not make under `devAllowAll: true`.
 *
 * What this spec deliberately does NOT cover (and why):
 *
 *   - Pair-token **revocation** over HTTP. `@ggui-ai/mcp-server`
 *     exposes revocation programmatically via
 *     `GguiServer.pairingService.revokePairing`, not as an HTTP
 *     route. Unit coverage lives at
 *     `packages/mcp-server/src/pairing-transport.test.ts` —
 *     "revokePairing invalidates future /mcp requests using the
 *     token". An HTTP admin-revoke surface is a future product
 *     slice; adding it here would bleed this spec into product
 *     work per §9.1's "not in this slice" list.
 *
 *   - Server-side outbound fetch from the spawned process.
 *     Cross-process MITM is overkill for this slice; the
 *     architectural guard is the open-source subtree split —
 *     `@ggui-ai/*` packages do not import anything under any
 *     closed-side scope. See the harness module-level "deliberately
 *     does NOT" note.
 *
 * Serial by construction — each sub-test shares the same `ggui serve`
 * instance so the mint → consume → negative-assertion sequence can
 * thread state through the real in-memory pairing service without
 * fighting port / mkdtemp races across workers. `journeys-ggui-oss`
 * Playwright project runs with `fullyParallel: false` already.
 */
import { test, expect } from '@playwright/test';
import {
  allowlistedEnv,
  assertLocalUrl,
  assertNoBannedEnv,
  attachGateAttempts,
  attachServeArtifacts,
  BANNED_ENV_PREFIXES,
  DEVTOOL_DIST,
  GGUI_CLI_DIST,
  installNetworkGate,
  mcpCallAs,
  spawnGguiServe,
  type GguiServeHandle,
  type NetworkGate,
} from './ggui-serve-harness';
import { createPerfRecorder, type PerfRecorder } from './perf-recorder';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/** Same upper bound as `npx-bootstrap.spec.ts` — serial boot + teardown. */
const TEST_TIMEOUT_MS = 60_000;

/**
 * Minimal structural shapes for the pairing wire. Source of truth
 * lives in `@ggui-ai/mcp-server-core` (`PairingInit` /
 * `PairingCompletion`), but `@ggui-private/e2e`'s dep graph
 * deliberately does not pull the server-side package in — spec
 * assertions use these local shapes so the e2e package doesn't gain
 * a new workspace dep for one slice.
 */
interface PairingInit {
  readonly code: string;
  readonly codeExpiresAt: number;
  readonly serverName: string;
}

interface PairingCompletion {
  readonly pairingId: string;
  readonly token: string;
  readonly serverName: string;
  readonly deviceName: string;
}

test.describe.serial('Phase 5 — pair flow + clean-room + strict-auth /mcp', () => {
  let handle: GguiServeHandle;
  let gate: NetworkGate;
  let perf: PerfRecorder;
  /**
   * Set by the "consume initial CLI-minted code" test — later tests
   * use it as the builder bearer for `/admin/pair/init` and as the
   * positive token for MCP authentication. Intentionally
   * function-scoped so an early failure doesn't trip a downstream
   * test with a confusing `undefined` bearer; each consumer asserts
   * non-empty before use.
   */
  let firstPairToken = '';

  test.beforeAll(async () => {
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
    handle = await spawnGguiServe();
  });

  test.afterAll(async () => {
    if (handle) await handle.close();
  });

  test.afterEach(async () => {
    if (handle) await attachServeArtifacts(handle);
    // `gate` is installed mid-suite (inside the builder-token test)
    // via `installNetworkGate`. When the gate is present, dump
    // its recorded attempts on failure — plan §12.1 names a network
    // tape as "required" evidence for the G14 zero-hosted-network
    // claim; `attempts` is the load-bearing subset (the URLs that
    // matched a BLOCKED_HOST_SUFFIXES entry) that the spec asserts
    // on directly.
    if (gate) await attachGateAttempts(gate);
    // Attach perf timings on every run (pass + fail). See
    // `perf-recorder.ts` for rationale: trend data belongs in
    // green runs too. Budget assertions fire inline via
    // `perf.assertBudgets()` at each test's end, not here.
    if (perf) await perf.attach();
  });

  test('clean-room invariants hold at spawn time', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    perf = createPerfRecorder();

    // Cold-boot timing — spawn → both boot beacons arrive. Captured
    // by the harness; we just promote it into the perf artifact +
    // enforce the 15s budget (matches `READY_TIMEOUT_MS`).
    perf.recordBlocking('cold-boot', handle.readyElapsedMs);

    // §4.4 #1 — CWD is under the OS tmp dir, NOT the monorepo.
    // `tests/` sits 4 levels below the workspace root (`tests/` →
    // `journeys/` → `e2e/` → `oss/` → root), so `../../../..` is the
    // monorepo-root probe. It must hit the exact root — too few
    // segments lands on `oss/`, too many on `/workspaces`, and a
    // tempCwd under `/tmp/...` would no longer be correctly excluded.
    expect(handle.tempCwd.length).toBeGreaterThan(0);
    expect(handle.tempCwd.startsWith(resolvePath(__dirname, '../../../..')))
      .toBe(false);

    // §4.4 #3 — allowlisted env, defence-in-depth.
    const env = allowlistedEnv();
    assertNoBannedEnv(env);
    for (const prefix of BANNED_ENV_PREFIXES) {
      expect(
        Object.keys(env).some((k) => k === prefix || k.startsWith(prefix)),
        `env leak: ${prefix}`,
      ).toBe(false);
    }

    // §4.4 #4 — stderr has no signs of a walked-up `ggui.json`. The
    // `ggui serve` CLI prints pre-banner warnings on stderr when it
    // auto-resolves a project manifest; an empty `storage:` /
    // `theme:` / `blueprints:` block in stdout implies no
    // inheritance. We assert the negative: stderr has no
    // `reading config from /workspaces/...` trace.
    expect(handle.stderr()).not.toMatch(/reading config from \/workspaces/);
    expect(handle.stderr()).not.toMatch(/inherited ggui\.json/);

    // CLI pre-minted an initial code on boot — the strict-auth
    // story's chicken-and-egg break. Without this the spec can't
    // consume the first code in any test below.
    expect(handle.initialPairCode).toMatch(/^\d{6}$/);

    // Blocking-budget gate — cold-boot must have landed inside
    // `READY_TIMEOUT_MS`. Fails explicitly here instead of the
    // harness's generic "did not print READY" timeout so a
    // regression in startup latency surfaces with a readable diff.
    perf.assertBudgets();
  });

  test('POST /admin/pair/init without bearer → 401 unauthenticated', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const url = `${handle.baseUrl}/admin/pair/init`;
    assertLocalUrl(url, handle.baseUrl);
    // Intentionally no Authorization header. `resolveIdentity`
    // treats an absent bearer as `UnauthenticatedError`; the
    // transport maps that to 401 / `unauthenticated`.
    const res = await fetch(url, { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unauthenticated');
  });

  test('POST /pair with malformed body → 400 bad_request', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    // Missing `deviceName`. The transport rejects at the schema
    // check BEFORE touching the service, so this returns 400
    // regardless of pending-code state.
    const res = await fetch(`${handle.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('bad_request');
  });

  test('POST /pair with wrong code → 401 pairing_rejected (CLI-minted code stays live)', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    // Use a code that cannot equal the CLI-minted one: the
    // `InMemoryPairingService` emits six ASCII digits, so any
    // non-digit string fails the `code !== input.code` check
    // deterministically without colliding with the real value.
    // Mismatches do NOT consume the pending code per the service
    // contract, so the subsequent happy-path test still finds it
    // live.
    const res = await fetch(`${handle.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'not-a-digit', deviceName: 'wrong-code' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('pairing_rejected');
  });

  test('consume CLI-minted code → one-shot replay rejection', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    expect(handle.initialPairCode).toMatch(/^\d{6}$/);

    const okRes = await fetch(`${handle.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: handle.initialPairCode!,
        deviceName: 'first-e2e-pair',
      }),
    });
    expect(okRes.status).toBe(200);
    const completion = (await okRes.json()) as PairingCompletion;
    expect(completion.pairingId).toBeTruthy();
    expect(completion.token).toBeTruthy();
    expect(completion.token.length).toBeGreaterThan(0);
    expect(completion.serverName).toBe('ggui-mcp-server');
    expect(completion.deviceName).toBe('first-e2e-pair');

    // Persist for the downstream admin-init + /mcp tests.
    firstPairToken = completion.token;

    // One-shot replay — same code second time → 401. Proves the
    // pending code was actually consumed by step 1.
    const replayRes = await fetch(`${handle.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: handle.initialPairCode!,
        deviceName: 'replay-attempt',
      }),
    });
    expect(replayRes.status).toBe(401);
  });

  test('builder token → /admin/pair/init → /pair (second mint) → /mcp success', async ({
    page,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    expect(firstPairToken.length).toBeGreaterThan(0); // guard
    perf = createPerfRecorder();

    // Install the hosted-network gate BEFORE any MCP / pair call in
    // this sub-test. Later additions that navigate `page` inherit
    // the same gate.
    gate = await installNetworkGate(page);

    // 1. Admin-init with the BUILDER bearer we minted in the prior
    //    test — proves the `onTokenIssued` bridge registered that
    //    token as a builder identity. Under the old devAllowAll
    //    default ANY bearer would pass here; under strict auth
    //    only pair-minted bearers do.
    const initRes = await fetch(`${handle.baseUrl}/admin/pair/init`, {
      method: 'POST',
      headers: { authorization: `Bearer ${firstPairToken}` },
    });
    expect(initRes.status).toBe(200);
    const init = (await initRes.json()) as PairingInit;
    expect(init.code).toMatch(/^\d{6}$/);
    expect(init.serverName).toBe('ggui-mcp-server');
    expect(init.codeExpiresAt).toBeGreaterThan(Date.now());

    // 2. Complete the second pair — independent bearer T2. Blocking
    //    timing — `/pair` is pure in-memory service logic; a regression
    //    where it slips over 2s = something broke. See perf-recorder
    //    BUDGET_RATIONALE.
    const okRes = await perf.timeBlocking('pair-mint', () =>
      fetch(`${handle.baseUrl}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: init.code,
          deviceName: 'second-e2e-pair',
        }),
      }),
    );
    expect(okRes.status).toBe(200);
    const completion = (await okRes.json()) as PairingCompletion;
    expect(completion.token).toBeTruthy();
    expect(completion.token).not.toBe(firstPairToken); // distinct bearers

    // 3. BOTH minted tokens authenticate /mcp. `tools/list` for T1
    //    keeps it hermetic (no render side-effect); `ggui_render`
    //    for T2 exercises the full write-path to prove the bridge
    //    covers it. Blocking timing on `tools/list` — no LLM, no
    //    cache, purely in-memory registry scan.
    const listed = await perf.timeBlocking('tools-list', () =>
      mcpCallAs(handle.baseUrl, firstPairToken, 'tools/list', {}),
    );
    const tools = (listed.result?.['tools'] ?? []) as Array<{ name: string }>;
    const toolNames = tools.map((t) => t.name);
    // The authenticated bearer sees the native ggui tool surface. The
    // exact roster grows slice over slice (gadget / theme readers, …)
    // — pin the always-on core plus the conditional-registration
    // invariant, not an exhaustive list that rots every slice (that
    // exact-count canary is tarball-smoke's job).
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'ggui_handshake',
        'ggui_list_featured_blueprints',
        'ggui_render',
        'ggui_search_blueprints',
        'ggui_update',
        'ggui_runtime_submit_action',
      ]),
    );
    // `ggui_render_blueprint` registers only when a uiRegistry is
    // present (server.ts conditional) — absent here in the empty cwd.
    expect(toolNames).not.toContain('ggui_render_blueprint');

    // Post-Phase-B render is handshake-first: handshake → render
    // ({handshakeId, props, override?}). The prior `ggui_new_session` mint is
    // gone — every render IS the addressable scope.
    const hsEnv = await mcpCallAs(handle.baseUrl, completion.token, 'tools/call', {
      name: 'ggui_handshake',
      arguments: {
        intent: 'pair-token smoke: weather card',
        blueprintDraft: { contract: {} },
      },
    });
    expect(hsEnv.error).toBeUndefined();
    const handshakeId = (
      hsEnv.result as { structuredContent: { handshakeId: string } }
    ).structuredContent.handshakeId;

    const renderEnv = await mcpCallAs(
      handle.baseUrl,
      completion.token,
      'tools/call',
      {
        name: 'ggui_render',
        arguments: { handshakeId, props: {}, override: { contract: {} } },
      },
    );
    expect(renderEnv.error).toBeUndefined();
    // Post-Phase-B structuredContent: {sessionId, action, nextStep?}.
    // The proof the render committed is the minted `sessionId` — the
    // legacy `url`/`/r/<shortCode>` field is retired (hosts resolve the
    // GguiSession via `_meta.ui.resourceUri` or `{sessionId}`).
    const renderResult = renderEnv.result as {
      structuredContent?: { sessionId?: string };
    };
    expect(renderResult.structuredContent?.sessionId).toBeTruthy();

    // 4. Network gate — no browser-side call attempted hosted / AWS
    //    / Cognito during this sub-test.
    expect(gate.attempts).toEqual([]);

    // 5. Blocking-budget gate — pair-mint + tools-list each stay
    //    under their 2s budget. Specs carry the perf gate INSIDE the
    //    assertion block (not afterEach) so a budget violation fails
    //    this test directly with the record dump, not a generic
    //    teardown step.
    perf.assertBudgets();
  });

  test('/mcp with an unrecognised bearer → 401 + canonical JSON-RPC envelope', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    // The load-bearing negative assertion the earlier Phase 5 slice
    // could not make under `devAllowAll: true`. With strict auth
    // the wire behaviour is:
    //   - HTTP 401 (the request never reaches the MCP SDK).
    //   - JSON-RPC envelope: jsonrpc: "2.0", error.code: -32000,
    //     error.message: "No valid credentials", id: null.
    // If this test ever passes under an arbitrary random bearer,
    // `buildMcpServerBackend` has silently regressed to the old
    // devAllowAll default.
    const res = await fetch(`${handle.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer absolutely-not-a-real-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'unauth',
        method: 'tools/list',
        params: {},
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      jsonrpc?: string;
      error?: { code?: number; message?: string };
      id?: unknown;
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toBe('No valid credentials');
    expect(body.id).toBeNull();
  });

  test('/mcp with NO bearer → 401 + canonical JSON-RPC envelope', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    // Complementary negative: an absent `Authorization` header
    // lands on the same `resolveIdentity → UnauthenticatedError →
    // 401` path. Pinning both the "unknown bearer" and the "missing
    // bearer" cases catches drift on either branch of
    // `InMemoryAuthAdapter.getIdentity` independently.
    const res = await fetch(`${handle.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'unauth',
        method: 'tools/list',
        params: {},
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error?: { code?: number; message?: string };
    };
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toBe('No valid credentials');
  });
});
