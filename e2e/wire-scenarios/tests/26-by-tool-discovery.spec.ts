/**
 * Scenario 26 — by-tool discovery journey (#477, the deferred §8 e2e
 * journey from `docs/superpowers/specs/2026-08-10-mcp-discovery-
 * surfacing-design.md`).
 *
 * The local-composable leg of the journey — everything that runs
 * against the OSS `@ggui-ai/registry-server` in-process, no deployed
 * infrastructure:
 *
 *   1. Publish a PUBLIC gadget with DECLARED `mcpTools`.
 *   2. Publish a PUBLIC blueprint with NO declared `mcpTools` — its
 *      binding is DERIVED from `contract.propsSpec`/`streamSpec`.
 *   3. `GET /search?tool=` / `?server=` / both (exact pair) exercise
 *      the AND-composed filter semantics end-to-end over real HTTP.
 *   4. Each result entry carries `mcpTools` + `mcpToolsSource`
 *      ('declared' vs 'derived').
 *   5. `scopeVerification` starts absent-from-view as `'unverified'`
 *      (the auto-claim default) and flips to `'verified'` +
 *      `verifiedDomain` after an operator-style
 *      `storage.updateScopeOwner` call — proving the wire label
 *      really is read from the scope-ownership row, not defaulted.
 *   6. Yank parity: a 410 (yanked) read carries the SAME
 *      `scopeVerification`/`verifiedDomain` projection as the live
 *      200 — the discovery fields don't vanish on yank.
 *
 * What this scenario does NOT cover (sandbox-dependent, out of this
 * lane's touch scope — `apps/` and `cloud/` are owned by other #259
 * follow-up lanes):
 *
 *   - hub.ggui.ai `/search?tool=` facet rendering (chips + verified
 *     badge). Grounding note: `apps/hub` has ZERO Amplify/backend
 *     coupling — it's a pure client over the public HTTP registry
 *     endpoints, with its registry base URL configurable via
 *     `NEXT_PUBLIC_REGISTRY_URL` (`apps/hub/src/lib/registry.ts`).
 *     It does NOT structurally need a deployed sandbox. It's excluded
 *     here only because every existing Playwright-driven `apps/*` UI
 *     journey in this repo is placed under
 *     `cloud/e2e/tests/journeys/ggui/` by convention (axis: Playwright
 *     UI journey) — a directory this lane was told not to touch. A
 *     follow-up should add a KEYLESS hub spec there (boot
 *     `bootRegistryServer()` + `next start` pointed at it via
 *     `NEXT_PUBLIC_REGISTRY_URL`, no sandbox deploy needed) rather
 *     than a sandbox-gated one.
 *   - console "For your app's tools" marketplace section. This leg IS
 *     genuinely sandbox-dependent — `useToolIdentityCatalog` /
 *     `useToolMatchedArtifacts` call an authed Amplify Gen2 AppSync
 *     query (`fetchToolIdentityCatalog`) against a seeded tool-
 *     identity catalog; there is no local/keyless path. Also lands
 *     under `cloud/e2e/tests/journeys/ggui/`, gated on a deployed
 *     sandbox, when that lane picks it up.
 *
 * See the placement decision + full grounding writeup in
 * `.claude/worktrees/fu-e2e/fu-c-report.md`.
 */
import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import {
  signBundleSigstore,
  canonicalJson,
  type SigstoreSignature,
} from '@ggui-ai/gadget-signing';
import { startSigstoreMockStack } from '@ggui-ai/gadget-signing/testing';
import { parseGadgetManifest, parseBlueprintManifest } from '@ggui-ai/artifact-manifest';
import {
  bootRegistryServer,
  TEST_REGISTRY_TOKEN,
  type RegistryServerHandle,
} from '../fixtures/registry-server.js';

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function sha384(bytes: Uint8Array): string {
  return createHash('sha384').update(bytes).digest('base64');
}

interface SearchResultEntryLike {
  readonly artifactId: string;
  readonly mcpTools?: ReadonlyArray<{ readonly server?: string; readonly tool: string }>;
  readonly mcpToolsSource?: string;
  readonly scopeVerification?: string;
  readonly verifiedDomain?: string;
}

async function searchJson(
  registry: RegistryServerHandle,
  qs: string,
): Promise<{ results: readonly SearchResultEntryLike[] }> {
  const res = await fetch(`${registry.url}/search${qs}`);
  expect(res.status, `GET /search${qs} status`).toBe(200);
  return (await res.json()) as { results: readonly SearchResultEntryLike[] };
}

describe('26 — by-tool discovery journey (#477)', () => {
  test('publish declared + derived bindings -> tool/server/pair search -> scopeVerification flip -> yank parity', async () => {
    const stack = await startSigstoreMockStack();
    const registry = await bootRegistryServer({ sigstoreTuf: stack.tuf });
    try {
      // ── 1. Publish a PUBLIC gadget with DECLARED mcpTools ───────────
      const gadgetManifest = parseGadgetManifest({
        kind: 'gadget',
        scope: '@ggui-test',
        name: 'weather-widget',
        version: '0.0.1',
        bundle: 'src/index.ts',
        visibility: 'public',
        description: 'Scenario 26 probe gadget with a declared MCP tool binding.',
        exports: [
          {
            hook: 'useWeatherWidget',
            description: 'Renders current weather for a city.',
            usage: 'Renders a weather card for a given city',
            example: { city: 'SF' },
          },
        ],
        mcpTools: [{ server: 'weather-server', tool: 'get_weather' }],
      });
      const gadgetBundleBytes = new TextEncoder().encode(
        `export function useWeatherWidget(){return null;}\nexport default useWeatherWidget;\n`,
      );
      const gadgetSignature: SigstoreSignature = await signBundleSigstore({
        bundleBytes: gadgetBundleBytes,
        identityToken: stack.identityToken(),
        endpoints: stack.signEndpoints,
      });
      const gadgetPublishResp = await fetch(`${registry.url}/publish`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TEST_REGISTRY_TOKEN}`,
        },
        body: JSON.stringify({
          manifest: gadgetManifest,
          bundle: base64(gadgetBundleBytes),
          bundleSha384: sha384(gadgetBundleBytes),
          signature: gadgetSignature,
        }),
      });
      const gadgetPublishBody: unknown = await gadgetPublishResp.json();
      expect(
        gadgetPublishResp.status,
        `gadget publish answered: ${JSON.stringify(gadgetPublishBody)}`,
      ).toBe(201);

      // ── 2. Publish a PUBLIC blueprint that DERIVES bindings from its
      //       contract — no declared mcpTools of its own. ─────────────
      const blueprintManifest = parseBlueprintManifest({
        kind: 'blueprint',
        scope: '@ggui-test',
        name: 'weather-panel',
        version: '0.0.1',
        visibility: 'public',
        description: 'Scenario 26 probe blueprint deriving bindings from its contract.',
        source: 'export default function WeatherPanel(){ return <div>Panel</div>; }',
        variance: { persona: 'casual-shopper', seedPrompt: 'A weather panel' },
        contract: {
          propsSpec: {
            properties: {
              temp: { schema: { type: 'number' }, sourceTool: 'get_weather' },
            },
          },
        },
      });
      const blueprintManifestBytes = new TextEncoder().encode(canonicalJson(blueprintManifest));
      const blueprintSignature: SigstoreSignature = await signBundleSigstore({
        bundleBytes: blueprintManifestBytes,
        identityToken: stack.identityToken(),
        endpoints: stack.signEndpoints,
      });
      const blueprintPublishResp = await fetch(`${registry.url}/publish`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TEST_REGISTRY_TOKEN}`,
        },
        body: JSON.stringify({ manifest: blueprintManifest, signature: blueprintSignature }),
      });
      const blueprintPublishBody: unknown = await blueprintPublishResp.json();
      expect(
        blueprintPublishResp.status,
        `blueprint publish answered: ${JSON.stringify(blueprintPublishBody)}`,
      ).toBe(201);

      // ── 3. GET /search?tool=get_weather — both entries bind it: the
      //       gadget declares it, the blueprint derives it (bare, no
      //       server — a derived binding is always bare per the spec). ─
      const byTool = await searchJson(registry, '?tool=get_weather');
      const byToolIds = byTool.results.map((r) => r.artifactId);
      expect(byToolIds).toContain('@ggui-test/weather-widget');
      expect(byToolIds).toContain('@ggui-test/weather-panel');

      // ── 4. GET /search?server=weather-server — ONLY the gadget: a
      //       bare (server-less) binding never matches a server filter. ─
      const byServer = await searchJson(registry, '?server=weather-server');
      const byServerIds = byServer.results.map((r) => r.artifactId);
      expect(byServerIds).toContain('@ggui-test/weather-widget');
      expect(byServerIds).not.toContain('@ggui-test/weather-panel');

      // ── 5. GET /search?tool=&server= (exact pair) — same as #4: only
      //       the gadget's declared (server, tool) pair matches exactly. ─
      const byPair = await searchJson(registry, '?tool=get_weather&server=weather-server');
      const byPairIds = byPair.results.map((r) => r.artifactId);
      expect(byPairIds).toContain('@ggui-test/weather-widget');
      expect(byPairIds).not.toContain('@ggui-test/weather-panel');

      // ── 6. mcpTools / mcpToolsSource wire projection per artifact ───
      const gadgetEntry = byTool.results.find(
        (r) => r.artifactId === '@ggui-test/weather-widget',
      );
      expect(gadgetEntry?.mcpTools).toEqual([{ server: 'weather-server', tool: 'get_weather' }]);
      expect(gadgetEntry?.mcpToolsSource).toBe('declared');

      const blueprintEntry = byTool.results.find(
        (r) => r.artifactId === '@ggui-test/weather-panel',
      );
      expect(blueprintEntry?.mcpTools).toEqual([{ tool: 'get_weather' }]);
      expect(blueprintEntry?.mcpToolsSource).toBe('derived');

      // ── 7. scopeVerification starts 'unverified' (publish auto-claims
      //       the scope; the default row carries no proof of domain
      //       control) — the fields are PRESENT (the scope row was
      //       read), just not 'verified' yet. ─────────────────────────
      expect(gadgetEntry?.scopeVerification).toBe('unverified');
      expect(gadgetEntry?.verifiedDomain).toBeUndefined();

      // ── 8. Operator verifies the scope (out-of-band flow — see
      //       ScopeOwnerRow's docstring: self-serve DNS is explicitly
      //       out of scope; only the *existing* verification state is
      //       surfaced). Flip via the storage-level primitive directly,
      //       same as an operator tool would. ────────────────────────
      const scopeBefore = await registry.storage.getScopeOwner('@ggui-test');
      expect(scopeBefore).not.toBeNull();
      if (scopeBefore === null) return;
      const verifyResult = await registry.storage.updateScopeOwner(
        {
          ...scopeBefore,
          verification: 'verified',
          verifiedDomain: 'weather-server.example',
          verifiedAt: '2026-08-11T00:00:00.000Z',
        },
        { ownerSubject: scopeBefore.ownerSubject, verification: 'unverified' },
      );
      expect(verifyResult).toEqual({ ok: true });

      // ── 9. Re-search — scopeVerification flips to 'verified' with the
      //       domain, proving the wire label is read from the row, not
      //       defaulted or cached from the earlier response. ──────────
      const afterVerify = await searchJson(registry, '?tool=get_weather');
      const gadgetAfterVerify = afterVerify.results.find(
        (r) => r.artifactId === '@ggui-test/weather-widget',
      );
      expect(gadgetAfterVerify?.scopeVerification).toBe('verified');
      expect(gadgetAfterVerify?.verifiedDomain).toBe('weather-server.example');

      // ── 10. Yank parity — a 410 (yanked) read carries the SAME
      //        scopeVerification/verifiedDomain projection as the live
      //        200 did. No HTTP yank route exists (yank is an operator-
      //        storage primitive today); invoke it directly, same as
      //        the search-verification step above. ────────────────────
      const liveReadResp = await fetch(
        `${registry.url}/pkg/ggui-test/weather-widget/0.0.1`,
      );
      expect(liveReadResp.status).toBe(200);
      const liveReadBody = (await liveReadResp.json()) as {
        scopeVerification?: string;
        verifiedDomain?: string;
      };
      expect(liveReadBody.scopeVerification).toBe('verified');
      expect(liveReadBody.verifiedDomain).toBe('weather-server.example');

      await registry.storage.yankArtifactVersion('@ggui-test/weather-widget', '0.0.1');

      const yankedReadResp = await fetch(
        `${registry.url}/pkg/ggui-test/weather-widget/0.0.1`,
      );
      expect(yankedReadResp.status).toBe(410);
      const yankedReadBody = (await yankedReadResp.json()) as {
        scopeVerification?: string;
        verifiedDomain?: string;
        manifest?: unknown;
      };
      // Audit-friendly: the manifest is still present on a 410 body.
      expect(yankedReadBody.manifest).toBeDefined();
      // Parity: the discovery fields don't vanish on yank.
      expect(yankedReadBody.scopeVerification).toBe(liveReadBody.scopeVerification);
      expect(yankedReadBody.verifiedDomain).toBe(liveReadBody.verifiedDomain);
    } finally {
      await registry.stop();
      stack.teardown();
    }
  });
});
