/**
 * Phase 5 `ggui` OSS — manifest capability consumption E2E.
 *
 * Boots `ggui serve` against a real fixture project that declares
 * capabilities in its `ggui.json` and asserts each one is actually
 * consumed at boot, through the most product-visible seam available
 * today:
 *
 *   - **blueprints** — three positive proofs of the register → search →
 *     render happy path:
 *       - `ggui_list_featured_blueprints` surfaces the declared UI
 *         (manifest source, `BlueprintProvider.list`).
 *       - `ggui_search_blueprints` finds the blueprint via the merged
 *         manifest + semantic source (substring match on the
 *         description; vector store empty on fresh boot).
 *       - `ggui_render_blueprint` resolves the id through
 *         `LocalUiRegistry` (manifest + compile-on-demand via
 *         esbuild) and returns the compiled bundle inline. A negative
 *         test pins the unknown-id rejection path.
 *     Together they exercise the full blueprint product surface on
 *     OSS — what an agent sees from list, to search, to render.
 *   - **primitives** — CLI pre-banner stdout (`primitives: N
 *     catalog(s) declared` + per-catalog import line). No MCP listing
 *     tool exists for primitive catalogs today; the spawned process's
 *     own status output is the strongest external signal that
 *     `discoverPrimitives` actually walked the manifest. Inventing a
 *     new product surface for testing is explicitly out of scope per
 *     the slice plan.
 *   - **theme** — CLI pre-banner stdout (`theme: <absolute-path>`).
 *     Browser-side runtime theme injection for arbitrary themes is not
 *     a shipped surface in `ggui serve` today (the console ships
 *     the bundled `@ggui-ai/design` light theme); asserting "theme
 *     was loaded" via the loader's own stdout report is the honest
 *     external seam. Same scope-out rationale as primitives.
 *
 * Note: the `adapters` capability was retired in Bucket B (LOCKED-22,
 * 2026-05-18). The schema now rejects the field, and its
 * corresponding tests / fixture entries have been removed.
 *
 * Fixture: `fixtures/manifest-capabilities/`. Self-contained — no
 * `node_modules`, `primitives.packages: []` so no npm-resolution from
 * the temp CWD, no `agent.entry` so `--mcp-only` is the natural fit.
 *
 * What this spec deliberately does NOT cover (per the slice plan):
 *
 *   - Browser DOM theme assertion. `ggui serve`'s console does
 *     not yet swap the bundled theme for the operator's
 *     `ggui.json#theme` at runtime; doing so is product work, not a
 *     test. Once that seam lands, extend this spec to navigate
 *     `/s/<shortCode>` and assert a CSS variable matching `theme.json`.
 *   - Primitives MCP-tool visibility. No `ggui_list_primitives` tool
 *     exists today. If/when one lands, replace the stdout assertion
 *     with the wire-level catalog assertion.
 *   - Phase 5.5 published-artifact smoke; `ggui` E2E; Phase 6/7.
 *
 * Serial under `journeys-ggui-oss`. Spawns its own server to keep
 * fixture-induced state isolated from the pair-flow + npx-bootstrap
 * specs in the same project.
 */
import { test, expect } from '@playwright/test';
import {
  attachServeArtifacts,
  DEVTOOL_DIST,
  GGUI_CLI_DIST,
  mcpCallAs,
  mintPairToken,
  spawnGguiServe,
  type GguiServeHandle,
} from './ggui-serve-harness';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const FIXTURE_DIR = resolvePath(__dirname, 'fixtures/manifest-capabilities');

/** Same upper bound as the sibling specs — serial boot + teardown. */
const TEST_TIMEOUT_MS = 60_000;

test.describe.serial('Phase 5 — manifest capability consumption', () => {
  let handle: GguiServeHandle;
  let pairToken = '';

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
    handle = await spawnGguiServe({ fixtureDir: FIXTURE_DIR });
    const minted = await mintPairToken(handle, 'manifest-capabilities-spec');
    pairToken = minted.token;
  });

  test.afterAll(async () => {
    if (handle) await handle.close();
  });

  test.afterEach(async () => {
    if (handle) await attachServeArtifacts(handle);
  });

  test('blueprints — ggui_list_featured_blueprints surfaces fixture-declared UI', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    expect(pairToken.length).toBeGreaterThan(0); // guard

    // Load-bearing product-surface assertion: the agent calling
    // `tools/call ggui_list_featured_blueprints` against this server
    // gets back the UI declared in `ggui.json#blueprints.include` →
    // discovered → indexed via `ManifestBlueprintProvider` → exposed
    // to the handler. If any link in that chain regresses, the
    // returned list either misses our fixture id or has the wrong
    // shape.
    const env = await mcpCallAs(
      handle.baseUrl,
      pairToken,
      'tools/call',
      { name: 'ggui_list_featured_blueprints', arguments: {} },
    );
    expect(env.error).toBeUndefined();
    const result = env.result as {
      structuredContent?: {
        blueprints?: Array<{
          id: string;
          name: string;
          source?: string;
          category?: string;
        }>;
        total?: number;
      };
    };
    // Manifest-declared blueprint MUST appear; the catalogue may also
    // include semantic-cache entries when a real LLM has run earlier
    // in this Playwright session, so assert presence + manifest-source
    // rather than pinning an exact count.
    const blueprints = result.structuredContent?.blueprints ?? [];
    expect((result.structuredContent?.total ?? 0)).toBeGreaterThanOrEqual(1);
    const manifestHit = blueprints.find(
      (b) => b.id === 'weather-card-fixture',
    );
    expect(manifestHit).toBeDefined();
    expect(manifestHit).toMatchObject({
      id: 'weather-card-fixture',
      name: 'Weather Card Fixture',
      // `source: 'user'` distinguishes manifest-declared blueprints
      // from any future shipped/built-in variants. Pinning it catches
      // a regression where the provider would silently re-classify.
      source: 'user',
    });

    // CLI pre-banner stdout — secondary boot-time signal. The CLI
    // prints these lines from `describeBlueprintStatus` only after
    // `discoverLocalUis` returned without issues, so a green stdout
    // here means discovery walked the fixture cleanly.
    expect(handle.stdout()).toContain('blueprints: 1 declared');
    expect(handle.stdout()).toContain(
      '- weather-card-fixture (Weather Card Fixture)',
    );
  });

  test('primitives — CLI status reports the local catalog (only external seam today)', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    // Strongest honest external seam: `describePrimitiveStatus` in
    // `cli.ts` prints these lines AFTER `discoverPrimitives` has
    // walked the fixture's `ggui.primitives.json` and parsed it
    // successfully. If the parse failed or the manifest's `import`
    // didn't match, the CLI would have refused to start; if discovery
    // ran but found nothing, the line would say `0 catalog(s)`.
    expect(handle.stdout()).toContain('primitives: 1 catalog(s) declared');
    expect(handle.stdout()).toContain(
      './ui/primitives/index.js (1 primitives, local)',
    );
  });

  test('theme — CLI status reports the loaded theme path', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    // Same rationale as primitives: `describeThemeStatus` only prints
    // a non-default `theme: <path>` line when `loadTheme` resolved a
    // file successfully. The fixture's `theme.json` is at
    // `<temp-cwd>/theme.json`, so the absolute path varies per run;
    // we assert on the basename to keep the test stable across
    // tmpdir prefixes.
    const stdout = handle.stdout();
    expect(stdout).toMatch(/theme:\s+\S*theme\.json/);
    // Negative: stderr did NOT report a theme parse / load issue.
    // If the loader emitted any issue line, the CLI would have
    // refused to start AND the spawn would have thrown — but pinning
    // the absence here surfaces a future regression where the loader
    // demotes a real failure to a warning.
    expect(handle.stderr()).not.toMatch(/ggui serve: theme:/);
  });

  test('blueprints — ggui_search_blueprints returns the manifest-declared blueprint', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    expect(pairToken.length).toBeGreaterThan(0); // guard
    // Happy-path search proof. Post-slice `ggui_search_blueprints`
    // consults both the semantic `VectorStore` AND the manifest
    // `BlueprintProvider` (merged + deduped by id). The fixture's
    // vector store is empty on this boot (no `ggui_render` has fired),
    // so every match comes from the manifest branch. Query is a
    // substring of the blueprint's description so the two-tier
    // manifest-scoring path (substring = 0.7) is the one exercised.
    const env = await mcpCallAs(handle.baseUrl, pairToken, 'tools/call', {
      name: 'ggui_search_blueprints',
      arguments: { query: 'weather' },
    });
    expect(env.error).toBeUndefined();
    const result = env.result as {
      structuredContent?: {
        results?: Array<{ id: string; name: string; score?: number }>;
        total?: number;
        query?: string;
      };
    };
    const results = result.structuredContent?.results ?? [];
    const hit = results.find((r) => r.id === 'weather-card-fixture');
    expect(
      hit,
      'ggui_search_blueprints must return the manifest-declared blueprint — the handler merges manifest + semantic sources.',
    ).toBeDefined();
    expect(hit?.name).toBe('Weather Card Fixture');
    // Substring-match score tier (0.7). Exact-name match would be
    // 1.0 — catching a future regression where the tier inverts.
    expect(hit?.score).toBe(0.7);
    // Manifest entries count toward `total`. The vector store may
    // also contribute entries when a real LLM ran earlier in this
    // Playwright session — assert ≥1 instead of ==1 so the test stays
    // honest under both no-key and live-key postures.
    expect((result.structuredContent?.total ?? 0)).toBeGreaterThanOrEqual(1);
  });

  test('blueprints — ggui_render_blueprint resolves the manifest blueprint to inline compiled code', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    expect(pairToken.length).toBeGreaterThan(0); // guard
    // Happy-path render proof. With a `LocalUiRegistry` wired by the
    // CLI, `ggui_render_blueprint` resolves the blueprint id through
    // the registry's manifest index + compile-on-demand pipeline
    // (esbuild). The result carries the compiled JS inline so the
    // caller can mount it directly. This is the full register →
    // search → render → inline-code contract executing end-to-end
    // against the real OSS binary.
    const env = await mcpCallAs(handle.baseUrl, pairToken, 'tools/call', {
      name: 'ggui_render_blueprint',
      arguments: { blueprintId: 'weather-card-fixture' },
    });
    expect(env.error).toBeUndefined();
    const result = env.result as {
      isError?: boolean;
      structuredContent?: {
        blueprintId?: string;
        blueprintName?: string;
        code?: string;
        contentType?: string;
      };
    };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.blueprintId).toBe('weather-card-fixture');
    expect(result.structuredContent?.blueprintName).toBe('Weather Card Fixture');
    expect(result.structuredContent?.contentType).toBe(
      'application/javascript+react',
    );
    // Compiled bundle is non-empty ESM. We don't pin the exact bytes
    // (esbuild output shifts across versions), only that the TSX
    // actually compiled AND the distinctive fixture content made it
    // through — if the TSX path was missed, the string would be empty
    // or blank.
    const code = result.structuredContent?.code ?? '';
    expect(code.length).toBeGreaterThan(0);
    expect(code).toContain('Weather Card Fixture');
    expect(code).toContain('data-testid');
  });

  test('blueprints — ggui_render_blueprint rejects an unknown blueprint id with a readable error', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    expect(pairToken.length).toBeGreaterThan(0); // guard
    // Negative half of the render contract. An unknown id flows
    // through `UiRegistry.get` → undefined → throw. MCP surfaces that
    // as either a JSON-RPC error OR a tool-level `isError: true` —
    // the load-bearing assertion is the handler did not silently
    // succeed.
    const env = await mcpCallAs(handle.baseUrl, pairToken, 'tools/call', {
      name: 'ggui_render_blueprint',
      arguments: { blueprintId: 'does-not-exist' },
    });
    const narrowed = env as {
      error?: { message?: string };
      result?: {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: { code?: string };
      };
    };
    if (narrowed.error) {
      expect(narrowed.error.message ?? '').toMatch(/no blueprint registered/i);
    } else {
      expect(narrowed.result?.isError).toBe(true);
      // No structured render result — the mis-match would be a
      // silent success if this were present.
      expect(narrowed.result?.structuredContent?.code).toBeUndefined();
    }
  });

});
