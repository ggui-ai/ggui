/**
 * OSS full-generation — Slice 4 follow-on: live-BYOK browser proof.
 *
 * Proves the real generation success path end-to-end in a real
 * browser, against a real LLM, with no stubs and no mocks. Pairs
 * with the Slice 4 jsdom render-path unit tests (in
 * `packages/console`) and the Slice 1 deterministic preview spec
 * (`provisional-preview.spec.ts`) — together the three cover "preview
 * appears / final mounts / handoff completes" on the OSS path:
 *
 *   - `provisional-preview.spec.ts` — preview FRAMES land in the
 *     viewer from the deterministic emitter (no LLM, no BYOK). This
 *     is the "preview appears" half.
 *   - Slice 4 jsdom render-path tests — the DOM-level handoff
 *     contract (`data-ggui-code-ready="false"` → `"true"`, preview
 *     path retires, renderer mounts). This is the handoff shape.
 *   - THIS spec — real componentCode flowing through the real render
 *     handler, compiled by `withBrowserCompile`, and MOUNTED in a
 *     real browser. This is the "final generated UI mounts" half,
 *     proving the Slice 3 + Slice 4 chain survives live LLM output.
 *
 * ## Gating (advisory lane — NOT blocking)
 *
 * Skips cleanly when:
 *
 *   1. `ANTHROPIC_API_KEY` is unset or empty (CI without secrets).
 *   2. `GGUI_OSS_LIVE_BYOK` is explicitly set to `'0'` (operator
 *      opt-out, e.g., when running the OSS journey without wanting
 *      to spend provider credits).
 *   3. The OSS CLI / console dists are missing (same guard as
 *      sibling specs — `pnpm --filter @ggui-ai/{cli,console}
 *      build` is a prerequisite).
 *
 * Per plan §4.4 #3: "If a scenario legitimately needs an env var
 * (e.g., a BYOK key for a specific path), the spec passes it
 * explicitly and the decision is commented." The
 * `forwardEnv: ['ANTHROPIC_API_KEY']` below is that explicit
 * carve-out.
 *
 * ## Provider lock
 *
 * Anthropic only. Matches `PROVIDER_PROBE_ORDER[0]` in
 * `@ggui-ai/cli/src/generation-probe.ts` — the OSS ecosystem
 * default. A multi-provider matrix here would turn the advisory
 * lane into a long, flaky tail; the BYOK resolver contract + the
 * per-provider adapter unit tests in `@ggui-ai/ui-gen/providers`
 * are where multi-provider coverage belongs.
 *
 * ## What this spec does NOT prove (and why)
 *
 *   - Provisional preview VISIBILITY during the live path. By the
 *     time `ggui_render` returns (Slice 3 blocks on generation),
 *     preview emission has finished. The browser subscribes AFTER
 *     render completes and sees the final render directly. Preview
 *     visibility on the browser surface is proven by the sibling
 *     `provisional-preview.spec.ts` under the deterministic
 *     emitter. Re-proving it here would require racing render
 *     with a second RPC to extract a shortCode before generation
 *     finishes — invented infrastructure, out of scope.
 *
 *   - Multi-turn generation, RAG cache hits, handshake-mode
 *     generation. Slices 5 + 7 of the OSS full-generation port
 *     plan own those; this spec covers Slice 3 + Slice 4 only.
 *
 *   - Deterministic DOM assertions on the generated component's
 *     content. LLM output is non-deterministic (per CLAUDE.md's
 *     "Testing LLM-Generated UI" guidance). The anchors here are
 *     the structural contract — `data-ggui-code-ready="true"`, a
 *     `ggui-rcr-*` scope class, non-empty rendered content — not
 *     specific text.
 *
 * Lane 2 of the 4-lane taxonomy (LLM-backed advisory, blocking
 * subset). Runs under the `journeys-ggui-oss` opt-in Playwright
 * project; serial by construction (shared harness lifetime).
 */
import { test, expect } from '@playwright/test';
import {
  attachGateAttempts,
  attachServeArtifacts,
  installNetworkGate,
  mcpCallAs,
  mintPairToken,
  shouldSkipLane2Advisory,
  spawnGguiServe,
  type GguiServeHandle,
  type NetworkGate,
} from './ggui-serve-harness';
import { createPerfRecorder, type PerfRecorder } from './perf-recorder';

/**
 * Generous — real Anthropic call + session-cookie mint + WebSocket
 * subscribe + render replay + component mount. On a warm Anthropic
 * endpoint + a tiny prompt this completes in 5-15s; the headroom
 * absorbs provider tail latency without flapping the CI worker.
 */
const TEST_TIMEOUT_MS = 180_000;

/** GguiSession-wait budget — the RPC blocks on generation before responding. */
const GENERATION_BUDGET_MS = 120_000;

/**
 * The intent we feed `ggui_render`. Kept short + unambiguous so the
 * generator produces a small component in one provider turn — faster
 * round-trip, less chance of hitting content-filter or length-cap.
 * The assertions don't depend on WHAT the UI says, only that a
 * component mounted.
 */
const RENDER_INTENT = 'Show a small greeting card with a title "Hello"';

test.describe.serial(
  'Slice 4 — live-BYOK generation success path (Anthropic, advisory)',
  () => {
    let handle: GguiServeHandle;
    let gate: NetworkGate;
    let perf: PerfRecorder;
    let skipped = false;

    test.beforeAll(async () => {
      const skip = shouldSkipLane2Advisory({ specLabel: 'live-BYOK spec' });
      if (skip.skip) {
        skipped = true;
        test.skip(true, skip.reason);
        return;
      }

      // Forward ONLY the Anthropic key via the harness's §4.4 #3
      // carve-out. Every other `ANTHROPIC_*` / `AWS_*` / `GGUI_*` /
      // `COGNITO_*` / proxy var is still stripped — the clean-room
      // contract holds for everything except this explicit hole.
      handle = await spawnGguiServe({
        forwardEnv: ['ANTHROPIC_API_KEY'],
      });
    });

    test.afterAll(async () => {
      if (handle) await handle.close();
    });

    test.afterEach(async () => {
      if (handle) await attachServeArtifacts(handle);
      // Same G14-evidence attach as the pair-flow spec — persists
      // the network-gate attempts list on failure.
      if (gate) await attachGateAttempts(gate);
      // Attach perf timings (advisory lane — no budget assertion).
      // See perf-recorder.ts for why Lane 2 / LLM paths stay
      // advisory: provider tail latency would flap a blocking gate.
      if (perf) await perf.attach();
    });

    test('ggui_render → generator runs → viewer mounts real componentCode', async ({
      page,
    }) => {
      if (skipped) return;
      test.setTimeout(TEST_TIMEOUT_MS);
      perf = createPerfRecorder();
      gate = await installNetworkGate(page);

      // 1. Mint a pair token. Strict `/mcp` auth requires a real
      //    bearer — same as the sibling specs.
      const { token } = await mintPairToken(handle, 'live-generation-slice4');
      expect(token.length).toBeGreaterThan(0);

      // 2. Sanity-check: the CLI's boot banner should announce an
      //    Anthropic binding. This is not load-bearing — the RPC
      //    result below is the real proof — but it catches a
      //    plumbing regression early (e.g., `withBrowserCompile`
      //    getting detached from the generation probe).
      const banner = handle.stdout();
      expect(
        banner,
        `CLI banner did not announce anthropic generation binding. ` +
          `Expected a line like "generation: anthropic / claude-haiku-4-5 (env: ANTHROPIC_API_KEY)".`,
      ).toMatch(/generation:\s+anthropic\s+\/\s+\S+\s+\(env:\s+ANTHROPIC_API_KEY\)/);

      // 3. Handshake → render. Post-Phase-B render is handshake-first;
      //    the agent calls ggui_handshake to negotiate, then ggui_render
      //    with the returned handshakeId. Slice 3's handler still blocks
      //    on the real generator call; render returns once the render is
      //    populated with the compiled componentCode. On a healthy
      //    Anthropic path this is ~5-15s; the 120s budget is tail-safe.
      //    The prior `ggui_new_session` mint is gone — every render IS
      //    the addressable scope.
      const hsEnv = await mcpCallAs(handle.baseUrl, token, 'tools/call', {
        name: 'ggui_handshake',
        arguments: {
          intent: RENDER_INTENT,
          blueprintDraft: { contract: {} },
          // The OSS `ggui serve` ships a built-in blueprint catalog;
          // a generic intent exact-key-matches it and render would
          // reuse the cached blueprint in ~10ms instead of running the
          // generator. `forceCreate` bypasses the matcher — this spec
          // exists to prove the cold-generation path itself.
          forceCreate: true,
        },
      });
      expect(hsEnv.error).toBeUndefined();
      const handshakeId = (
        hsEnv.result as { structuredContent: { handshakeId: string } }
      ).structuredContent.handshakeId;

      const renderStart = Date.now();
      const renderEnv = await Promise.race<ReturnType<typeof mcpCallAs>>([
        mcpCallAs(handle.baseUrl, token, 'tools/call', {
          name: 'ggui_render',
          arguments: { handshakeId, props: {}, override: { contract: {} } },
        }),
        new Promise((_resolve, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `ggui_render did not return within ${GENERATION_BUDGET_MS}ms — the LLM call may be hanging. stderr:\n${handle.stderr()}`,
                ),
              ),
            GENERATION_BUDGET_MS,
          ),
        ) as Promise<never>,
      ]);
      const renderElapsedMs = Date.now() - renderStart;
      perf.recordAdvisory(
        'render-cold-llm',
        renderElapsedMs,
        'anthropic cold path — no cache, no handshake',
      );
      expect(renderEnv.error).toBeUndefined();

      // Post-Phase-B the render handler's LLM-visible structuredContent
      // is {sessionId, url, action, nextStep?} — retired fields
      // (sessionId, stackItemId, shortCode, codeReady, handshakeId,
      // contractHash, decision) are gone. `shortCode` is the tail of
      // `url`'s `/r/<shortCode>` path.
      const renderResult = renderEnv.result as {
        structuredContent?: {
          sessionId?: string;
          url?: string;
          action?: 'create' | 'reuse' | 'update' | 'replace' | 'declined';
        };
        isError?: boolean;
      };
      expect(
        renderResult.isError,
        `ggui_render returned isError: true (check server stderr for generator failure reason).`,
      ).not.toBe(true);
      const renderUrl = renderResult.structuredContent?.url;
      expect(renderUrl, 'ggui_render returned no url').toBeTruthy();
      const shortCodeMatch = new URL(renderUrl!).pathname.match(/^\/[rs]\/([^/?]+)/);
      expect(shortCodeMatch, `render url is not /r/<shortCode>: ${renderUrl}`).not.toBeNull();
      const shortCode = shortCodeMatch![1]!;
      // Code-readiness is no longer surfaced via a `codeReady` boolean.
      // The structural proof that real generation ran is the latency
      // floor below + the rendered assertions further down
      // (ggui-rcr-* scope must mount, which only happens when
      // generation completed successfully).
      expect(typeof renderResult.structuredContent?.sessionId).toBe('string');
      // Sanity: a real generator call takes noticeable time. If this
      // returns instantly, something is stubbing the provider (wrong
      // build pulled in, regression in probe wiring). 1s floor is
      // generous — every real Anthropic call ever observed has taken
      // longer.
      expect(
        renderElapsedMs,
        `ggui_render returned in ${renderElapsedMs}ms — too fast for a real LLM call. Stub regression?`,
      ).toBeGreaterThan(1_000);

      // 4. Navigate to the viewer. The session cookie mint + /ws
      //    subscribe happen automatically on render; the subscribe
      //    ack returns the current render (with real componentCode),
      //    and the iframe-runtime mounts `ReactComponentRenderer` for
      //    the render entry.
      await page.goto(`${handle.baseUrl}/s/${shortCode}`, {
        waitUntil: 'networkidle',
      });

      // 5. The console GguiSessionViewer mounts the rendered UI inside a
      //    plain `<iframe srcDoc>` (read-only / visual-only — post
      //    C1-fix it no longer carries the `<McpAppIframe>` lifecycle-
      //    mirror attribute). Readiness is gated by the inner
      //    `ggui-rcr-*` scope visibility check below — the renderer
      //    React-mounts inside the iframe once the bundle has loaded.
      const liveIframe = page
        .locator('iframe[data-testid="render-viewer-iframe"]')
        .first();
      await expect(liveIframe).toBeVisible({ timeout: 15_000 });

      // 6. Post-stack-removal (2026-05-27) the iframe-runtime mounts
      //    the React tree directly into the root iframe body. The
      //    React mount wraps its tree in a scope div whose class
      //    starts with `ggui-rcr-` (see
      //    `packages/iframe-runtime/src/react-renderer.ts::makeScopeClass`).
      //    Presence of that class proves the esbuild-compiled ESM
      //    actually loaded and a React component rendered — not the
      //    loading fallback, not the error boundary.
      const frame = page
        .frameLocator('iframe[data-testid="render-viewer-iframe"]')
        .first();
      const rcrScope = frame.locator('[class^="ggui-rcr-"]');
      await expect(rcrScope).toBeVisible({ timeout: 30_000 });

      // B2 regression — `/s/<shortCode>` must render exactly ONE
      // React mount. A 2026-04-22 QA pass observed the viewer
      // double-mounting the component (two identical <h1>s, no iframe
      // separation). Pinning the count here means a future regression
      // that re-introduces a duplicate-mount path (replay double-
      // delivery, dev StrictMode sneaking into prod, double-subscribe
      // race, etc.) flips this assertion immediately.
      await expect(rcrScope).toHaveCount(1);

      // 7. The preview card anchor MUST NOT appear inside the render
      //    mount — if it does, we're still in the provisional path.
      await expect(
        frame.locator('[data-ggui-preview="card"]'),
      ).toHaveCount(0);

      // 9. The scoped div must have rendered content — an empty
      //    mount would mean the component's default export returned
      //    `null`, which a real Anthropic generation would not
      //    (the intent asks for a visible greeting). Count children
      //    >= 2: at minimum the `<style>` inner-block and the
      //    rendered component subtree. Using `nth-child` rather
      //    than text content keeps the assertion non-deterministic
      //    (LLM output varies but SHAPE is stable).
      const scopeChildren = await rcrScope.evaluate(
        (el) => el.children.length,
      );
      expect(
        scopeChildren,
        `ggui-rcr-* scope has ${scopeChildren} children — expected ≥ 1 (real componentCode must render SOME DOM).`,
      ).toBeGreaterThanOrEqual(1);

      // 10. Network gate — browser-side calls to hosted / AWS /
      //     Cognito must stay empty. The LLM call fires from the
      //     spawned Node process, not from the browser, so
      //     api.anthropic.com is NOT in this list and does not
      //     register as an attempt here.
      expect(gate.attempts).toEqual([]);
    });
  },
);
