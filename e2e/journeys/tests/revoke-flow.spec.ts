/**
 * Phase 5 `ggui` OSS — pair revoke flow (advisory → GREEN).
 *
 * Closes §4.3 G15 ("Unpair → 401 after revoke"). Before this slice
 * revocation was programmatic-only (`pairingService.revokePairing`
 * via the `GguiServer` handle); the HTTP admin surface did not
 * expose it. This spec pins the just-landed
 * `POST /admin/pair/:pairingId/revoke` route on the wire:
 *
 *   1. Mint a pair token via the normal `/admin/pair/init` → `/pair`
 *      flow — same path the CLI pre-mints on boot.
 *   2. Use the minted token against `/mcp tools/list` — succeeds
 *      (200 + full tool roster). Anchors "authenticated before revoke".
 *   3. Call `POST /admin/pair/:pairingId/revoke` with the minted
 *      builder bearer. Asserts the 200 envelope (`{ok: true,
 *      pairingId}`).
 *   4. Repeat `/mcp tools/list` with the same token — now a
 *      canonical 401 JSON-RPC envelope (`code: -32000`,
 *      `message: "No valid credentials"`). This is the load-bearing
 *      security claim the §4.3 advisory row names: the minted
 *      token MUST stop authenticating immediately after revoke.
 *
 * Serial under `journeys-ggui-oss` — revoke mutates adapter state,
 * so a fresh `ggui serve` per test keeps the sub-steps deterministic.
 */
import { test, expect } from '@playwright/test';
import {
  attachServeArtifacts,
  DEVTOOL_DIST,
  GGUI_CLI_DIST,
  mcpCallAs,
  spawnGguiServe,
  type GguiServeHandle,
} from './ggui-serve-harness';
import { existsSync } from 'node:fs';

const TEST_TIMEOUT_MS = 60_000;

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

test.describe.serial('Phase 5 — pair revoke flow', () => {
  let handle: GguiServeHandle;

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
  });

  test('mint → authenticate → revoke → token rejected with 401', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);

    // 1. Consume the CLI-minted initial pair code. Builder T1 from
    //    that mint is the bearer we use for the admin surfaces —
    //    same pattern as `pair-flow.spec.ts`.
    expect(handle.initialPairCode).toMatch(/^\d{6}$/);
    const t1Res = await fetch(`${handle.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: handle.initialPairCode!,
        deviceName: 'revoke-flow-builder',
      }),
    });
    expect(t1Res.status).toBe(200);
    const t1 = (await t1Res.json()) as PairingCompletion;
    expect(t1.token.length).toBeGreaterThan(0);

    // 2. Mint a second token T2 via admin init under T1's bearer —
    //    T2 is the SUBJECT of the revoke. Doing it this way keeps
    //    the admin-init route (builder-auth) exercised on the same
    //    spec, AND guarantees T1 is still live when we revoke T2.
    const initRes = await fetch(`${handle.baseUrl}/admin/pair/init`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t1.token}` },
    });
    expect(initRes.status).toBe(200);
    const init = (await initRes.json()) as PairingInit;
    expect(init.code).toMatch(/^\d{6}$/);

    const t2Res = await fetch(`${handle.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: init.code,
        deviceName: 'revoke-flow-target',
      }),
    });
    expect(t2Res.status).toBe(200);
    const t2 = (await t2Res.json()) as PairingCompletion;
    expect(t2.token.length).toBeGreaterThan(0);
    expect(t2.token).not.toBe(t1.token);

    // 3. Pre-revoke sanity: T2 authenticates `/mcp tools/list`.
    //    Anchors "was authenticated before revoke" so the negative
    //    assertion below is a real delta.
    const preListed = await mcpCallAs(
      handle.baseUrl,
      t2.token,
      'tools/list',
      {},
    );
    const preTools = (preListed.result?.['tools'] ?? []) as Array<{
      name: string;
    }>;
    expect(preTools.length).toBeGreaterThan(0);

    // 4. Revoke T2 via the HTTP admin route, authenticated with T1.
    //    Response envelope `{ok: true, pairingId}` — pins the
    //    contract from `pairing-transport.ts`. Asserting this 200
    //    flip catches a regression where the route returned a 404
    //    or mutated response shape.
    const revokeRes = await fetch(
      `${handle.baseUrl}/admin/pair/${t2.pairingId}/revoke`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${t1.token}` },
      },
    );
    expect(revokeRes.status).toBe(200);
    const revokeBody = (await revokeRes.json()) as {
      ok?: boolean;
      pairingId?: string;
    };
    expect(revokeBody.ok).toBe(true);
    expect(revokeBody.pairingId).toBe(t2.pairingId);

    // 5. The load-bearing G15 assertion: T2 is now rejected with the
    //    canonical JSON-RPC 401 envelope from `resolveIdentity`.
    //    Uses raw `fetch` (not `mcpCallAs`, which throws on non-2xx)
    //    so we can read the HTTP status + error envelope directly.
    const postRes = await fetch(`${handle.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${t2.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'post-revoke',
        method: 'tools/list',
        params: {},
      }),
    });
    expect(postRes.status).toBe(401);
    const postBody = (await postRes.json()) as {
      jsonrpc?: string;
      error?: { code?: number; message?: string };
      id?: unknown;
    };
    expect(postBody.jsonrpc).toBe('2.0');
    expect(postBody.error?.code).toBe(-32000);
    expect(postBody.error?.message).toBe('No valid credentials');

    // 6. T1 (the revoker) must still work — revoke is scoped to the
    //    passed pairingId, not the bearer performing the revoke.
    //    Without this guard a copy-paste regression that revoked the
    //    bearer instead of the path param would silently lock the
    //    admin out.
    const t1Listed = await mcpCallAs(
      handle.baseUrl,
      t1.token,
      'tools/list',
      {},
    );
    const t1Tools = (t1Listed.result?.['tools'] ?? []) as Array<{
      name: string;
    }>;
    expect(t1Tools.length).toBeGreaterThan(0);
  });
});
