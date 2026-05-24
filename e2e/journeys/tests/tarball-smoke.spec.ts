/**
 * Phase 5.5 first slice — packaged-artifact smoke for `@ggui-ai/cli`
 * + `@ggui-ai/mcp-server`.
 *
 * What this spec proves end-to-end (per
 * `docs/plans/2026-04-21-oss-split-e2e-phases.md` §5 + §9.2):
 *
 *   - The tarball `pnpm pack` produces from `@ggui-ai/cli` + every
 *     transitive `@ggui-ai/*` workspace dep installs cleanly via
 *     `npm install` into a fresh tmp project. No workspace
 *     symlinks rescue missing `files[]` entries; no host npmrc
 *     pollutes resolution.
 *   - The installed `./node_modules/@ggui-ai/cli/dist/cli.js`
 *     boots a real `ggui serve --port 0 --mcp-only`, prints both
 *     `READY` and `PAIR_CODE` boot beacons, and a pair-minted
 *     bearer authenticates a real MCP `tools/list` call against
 *     the installed tree.
 *   - `import('@ggui-ai/mcp-server')` from the same install root
 *     resolves and exposes `createGguiServer` as a function. Pins
 *     the publish-shape of the package's `exports` field — a
 *     missed `./package.json#exports` subpath would fail with
 *     `ERR_PACKAGE_PATH_NOT_EXPORTED` here.
 *
 * Sibling Phase 5 specs in this project run against the workspace
 * `dist/cli.js`, which is what an in-monorepo developer hits but NOT
 * what an OSS user sees. This spec deliberately avoids any path that
 * could be rescued by the workspace import graph.
 *
 * What this spec deliberately does NOT cover (next slices):
 *   - `@ggui-ai/console` standalone smoke (the install resolves
 *     it transitively but we don't yet pin its `dist/index.html` +
 *     hashed-asset contract).
 *   - `@ggui-ai/project-config` subpath-export smoke.
 *   - Caching tarballs across runs (each run packs fresh).
 *
 * Opt-in under `journeys-ggui-oss`. Slow-ish (~10s end-to-end:
 * ~1s parallel pack + ~6s npm install + ~2s server boot + smoke);
 * one server boot covers both sub-tests via `test.describe.serial`.
 */
import { test, expect } from '@playwright/test';
import {
  attachTarballArtifacts,
  packAndInstall,
  spawnInstalledGguiServe,
  type InstalledServeHandle,
  type TarballInstallHandle,
} from './tarball-install-harness';
import { mcpCallAs } from './ggui-serve-harness';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

/**
 * Generous overall timeout: parallel pack + npm install can vary
 * with cold caches / I/O pressure. The harness's own deadlines are
 * tighter; this is the playwright per-test envelope.
 */
const TEST_TIMEOUT_MS = 180_000;

test.describe.serial('Phase 5.5 — tarball-install smoke (cli + mcp-server)', () => {
  let install: TarballInstallHandle;
  let serve: InstalledServeHandle;
  let pairToken = '';

  test.beforeAll(async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    install = await packAndInstall();
    serve = await spawnInstalledGguiServe(install.installRoot);

    // Trade the CLI-minted pair code for a real bearer using the
    // existing `/pair` flow — same wire shape the in-workspace
    // pair-flow.spec.ts proves.
    const pairRes = await fetch(`${serve.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: serve.initialPairCode,
        deviceName: 'tarball-smoke',
      }),
    });
    if (pairRes.status !== 200) {
      throw new Error(
        `tarball-smoke beforeAll: POST /pair returned ${pairRes.status}: ${await pairRes.text()}`,
      );
    }
    const completion = (await pairRes.json()) as { token: string };
    pairToken = completion.token;
  });

  test.afterAll(async () => {
    if (serve) await serve.close();
    if (install) await install.close();
  });

  test.afterEach(async () => {
    // Dump tarball listings + install logs on failure — plan §12.1
    // Phase 5.5 "tarball contents listing — required". The handle is
    // only populated after `beforeAll`; a failure during that phase
    // won't have an install to dump, so we guard.
    if (install) await attachTarballArtifacts(install);
  });

  test('@ggui-ai/cli — installed tarball boots ggui serve and authenticates MCP via pair token', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    expect(pairToken.length).toBeGreaterThan(0); // guard

    // The install root is genuinely under tmpdir — defence against
    // a future regression where the harness silently falls back to
    // the workspace cwd. Workspace root is 4 levels up
    // (`tests/` → `journeys/` → `e2e/` → `oss/` → workspace), so
    // `../../../..` is the monorepo-root probe — it must hit the
    // exact root so an mkdtemp install root under `/tmp/...` stays
    // correctly excluded.
    expect(install.installRoot.startsWith(resolvePath(__dirname, '../../../..')))
      .toBe(false);
    expect(install.installRoot).toMatch(/ggui-tarball-e2e-/);

    // Health endpoint over the installed CLI's own bind. The OSS
    // default native ggui_* tool surface, post-Slice 6/7 growth.
    // Update both the count + the tools/list assertion when the
    // native surface changes.
    const healthRes = await fetch(`${serve.baseUrl}/ggui/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as {
      status: string;
      server: string;
      tools: number;
      channel?: { path: string };
    };
    expect(health.status).toBe('ok');
    expect(health.server).toBe('ggui-mcp-server');
    // `health.tools` counts every registered tool across all audience
    // routes (agent + runtime + protocol + ops); the `tools/list`
    // assertion below pins the agent/runtime surface the `/mcp` route
    // actually exposes. When the native surface changes, update both.
    expect(health.tools).toBe(28);
    expect(health.channel?.path).toBe('/ws');

    // tools/list with the pair-minted bearer. If publish-shape
    // packaging dropped any of the handler bundle's files, the
    // server would either fail to boot OR list a different tool
    // count. Pinning the exact tool name set catches both. This is
    // the `/mcp` route's agent + runtime surface — narrower than the
    // all-audiences `health.tools` count above.
    const listed = await mcpCallAs(
      serve.baseUrl,
      pairToken,
      'tools/list',
      {},
    );
    const tools = (listed.result?.['tools'] ?? []) as Array<{ name: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ggui_close',
      'ggui_consume',
      'ggui_emit',
      'ggui_get_session',
      'ggui_get_stack',
      'ggui_handshake',
      'ggui_list_featured_blueprints',
      'ggui_list_gadgets',
      'ggui_list_themes',
      'ggui_new_session',
      'ggui_pop',
      'ggui_push',
      'ggui_runtime_refresh_bootstrap',
      'ggui_runtime_submit_action',
      'ggui_runtime_sync_context',
      'ggui_search_blueprints',
      'ggui_update',
    ]);
  });

  test('@ggui-ai/mcp-server — installed tarball exposes createGguiServer via package exports', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);

    // The package is ESM-only — `require()` fails with
    // `ERR_PACKAGE_PATH_NOT_EXPORTED` because there's no CJS main
    // resolved through `package.json#exports`. We use `node
    // --input-type=module -e "import(...)"` to exercise the same
    // entry-resolution path a real ESM consumer takes.
    //
    // The probe lives in a tiny inline script rather than a
    // separate file so the spec reads top-to-bottom: failure modes
    // (missing exports, missing dist file, broken default export)
    // surface in the spawnSync stderr captured below.
    const probeScript = `
      import('@ggui-ai/mcp-server')
        .then((m) => {
          const ok =
            typeof m.createGguiServer === 'function' &&
            typeof m.InMemoryShortCodeIndex === 'function' &&
            typeof m.InMemoryAuthAdapter === 'function';
          if (!ok) {
            console.error('FAIL exports shape:', Object.keys(m).join(','));
            process.exit(1);
          }
          console.log('OK createGguiServer + reference adapters present');
        })
        .catch((err) => {
          console.error('IMPORT_FAIL:', err.code ?? '', err.message);
          process.exit(1);
        });
    `.trim();

    const result = spawnSync(
      'node',
      ['--input-type=module', '-e', probeScript],
      {
        cwd: install.installRoot,
        encoding: 'utf8',
        // Inherit the installed tree's node_modules — explicitly do
        // not pass an env override so we don't accidentally widen
        // the spawned process's lookup path beyond installRoot.
      },
    );
    expect(
      result.status,
      `mcp-server import probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain('OK createGguiServer');
  });

  test('@ggui-ai/console — installed tarball ships dist/index.html + a hashed asset bundle', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);

    // Flips the Phase 5.5 matrix row for `@ggui-ai/console` from
    // "GREEN (by transit)" to directly asserted. The CLI boot path
    // covered elsewhere in this spec implicitly proves the package
    // lands; this test pins the exact shipped shape so a regression
    // (missing `dist/`, missing assets dir, an empty Vite output) is
    // named here instead of surfacing as a confusing 404 on the
    // landing page at boot.
    const pkgRoot = resolvePath(
      install.installRoot,
      'node_modules/@ggui-ai/console',
    );
    expect(existsSync(pkgRoot), `package root missing: ${pkgRoot}`).toBe(true);

    // package.json — sanity baseline + version pin against the
    // workspace version we packed.
    const pkgJson = JSON.parse(
      readFileSync(join(pkgRoot, 'package.json'), 'utf8'),
    ) as { name?: string; version?: string };
    expect(pkgJson.name).toBe('@ggui-ai/console');
    expect(pkgJson.version).toBe(install.versions['@ggui-ai/console']);

    // dist/index.html — the SPA shell `@ggui-ai/cli` serves at `/`.
    // `buildMcpServerBackend`'s `console.distRoot` resolves against
    // this same path on boot; a missing file here is the exact failure
    // mode Phase 5.5 is designed to catch before npm publish.
    const indexHtml = join(pkgRoot, 'dist/index.html');
    expect(existsSync(indexHtml), `dist/index.html missing: ${indexHtml}`).toBe(
      true,
    );
    const indexBody = readFileSync(indexHtml, 'utf8');
    // Vite stamps `<script type="module" src="/assets/index-<hash>.js">`;
    // asserting on the module-script anchor is robust across Vite
    // minor versions without pinning the exact hash.
    expect(indexBody).toMatch(/<script[^>]+type="module"[^>]+src="\/assets\//);

    // dist/assets/ — Vite's hashed bundle dir. At least one `.js`
    // entry must be present; zero would mean the Vite build produced
    // an empty output.
    const assetsDir = join(pkgRoot, 'dist/assets');
    expect(existsSync(assetsDir), `dist/assets missing: ${assetsDir}`).toBe(
      true,
    );
    const jsAssets = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    expect(
      jsAssets.length,
      `dist/assets has no .js bundle — Vite build regression?`,
    ).toBeGreaterThan(0);
  });

  test('@ggui-ai/project-config — installed tarball resolves root + /node subpath exports', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);

    // Flips the Phase 5.5 matrix row for `@ggui-ai/project-config`
    // from "GREEN (by transit)" to directly asserted. Both subpaths
    // are load-bearing on the CLI boot path — `parseGguiJson` +
    // `UiManifestV1` from the root, `discoverPrimitives` +
    // `loadTheme` from `/node`. Missing any entry surfaces here as
    // `ERR_PACKAGE_PATH_NOT_EXPORTED` rather than during `ggui
    // serve`.
    const probeScript = `
      Promise.all([
        import('@ggui-ai/project-config'),
        import('@ggui-ai/project-config/node'),
      ])
        .then(([root, node]) => {
          const rootOk =
            typeof root.parseGguiJson === 'function' &&
            typeof root.UiManifestV1 === 'object' &&
            typeof root.GguiJsonV1 === 'object';
          const nodeOk =
            typeof node.findGguiJson === 'function' &&
            typeof node.loadGguiJson === 'function' &&
            typeof node.discoverPrimitives === 'function' &&
            typeof node.loadTheme === 'function';
          if (!rootOk) {
            console.error('FAIL root exports:', Object.keys(root).sort().join(','));
            process.exit(1);
          }
          if (!nodeOk) {
            console.error('FAIL node exports:', Object.keys(node).sort().join(','));
            process.exit(1);
          }
          console.log('OK project-config root + /node exports present');
        })
        .catch((err) => {
          console.error('IMPORT_FAIL:', err.code ?? '', err.message);
          process.exit(1);
        });
    `.trim();

    const result = spawnSync(
      'node',
      ['--input-type=module', '-e', probeScript],
      {
        cwd: install.installRoot,
        encoding: 'utf8',
      },
    );
    expect(
      result.status,
      `project-config import probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain('OK project-config root + /node');
  });
});
