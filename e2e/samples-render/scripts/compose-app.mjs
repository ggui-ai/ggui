#!/usr/bin/env node
/**
 * compose-app — assemble a runnable agentic app DIRECTLY from `oss/samples/*`
 * for the samples-render sub-tier-B e2e. This is the Phase-1 replacement for
 * the `create-agentic-app` scaffolder path: the same merge the retired
 * template assembler performed, minus the template-shell wrappers (README,
 * railway.toml, .claude/, .reference/ — publish/DX artifacts, not behavior).
 *
 * Merge map (paths relative to the oss-root) — framework-native keys
 * (claude-agent-sdk | openai-agents-sdk | google-adk):
 *
 *   samples/agents/<sdk>/        → servers/agent/
 *   samples/gguis/default/       → servers/ggui/
 *   samples/mcp-servers/todo/    → servers/mcps/todo/
 *   samples/apps/ggui-basic-web/ → apps/web/
 *
 * plus the harness-owned `app-shell/` at the root (root package.json,
 * pnpm-workspace.yaml, scripts/dev.mjs + stop-dev.mjs — the 4-server
 * `pnpm dev` boot).
 *
 * The `with-guuey` key composes the platform-composed (guuey-sdk) golden
 * path instead — guuey's OWN layout, not the app-shell's:
 *
 *   samples/agents/with-guuey/    → .            (app root — guuey.json home;
 *                                                 `guuey dev` walks up from
 *                                                 cwd to find it)
 *   samples/gguis/default/        → servers/ggui/ (the ggui runtime config)
 *   samples/mcp-servers/todo/     → servers/mcps/todo/ (the colocated
 *                                                 `source` guuey.json points
 *                                                 at — rewritten at compose
 *                                                 time, see below)
 *   samples/apps/with-guuey-web/  → apps/web/
 *
 * NO app-shell: the with-guuey tree is NOT a pnpm workspace — its halves are
 * standalone published-consumer npm projects installed per-dir, and the boot
 * sequence (ggui serve :6781 → `guuey dev --serve` :6790 → web :6890) lives
 * in compose-and-boot.sh's with-guuey branch, not scripts/dev.mjs.
 *
 * Package-json rewrites at compose time:
 *   1. Root `"name"` → `rendercell-<sdk>`.
 *   2. `"@ggui-ai/<pkg>": "workspace:*"` → the prerelease-inclusive caret
 *      range (`^<base>-alpha.0` for a stable base, `^<base>` when the base
 *      is itself a prerelease; base read from packages/protocol — the
 *      lockstep cohort version), so the composed tree installs the PUBLISHED
 *      cohort from the harness's Verdaccio. This deliberately keeps the
 *      version-range-resolution coverage class alive (the
 *      `protocol@0.2.0-not-found` incident class): an unsatisfiable range
 *      fails the install loudly instead of silently linking workspace source.
 *   3. `"@ggui-samples/<pkg>": "workspace:*"` stays `workspace:*` — the
 *      composed tree IS a pnpm workspace, so sample cross-deps resolve
 *      locally. Any OTHER `workspace:*` dep is an error.
 *
 * Also points `servers/ggui/ggui.json#generation.model` at the SDK's own
 * provider (same rewrite the template assembler did), so each composed app
 * needs ONE provider key family, not two.
 *
 * Usage:
 *   node compose-app.mjs --sdk=<claude-agent-sdk|openai-agents-sdk|google-adk|with-guuey> --out=<dir>
 *
 * Exit codes: 0 = success, 1 = bad args, 2 = source dir missing,
 * 3 = rewrite produced an invalid package.json.
 */
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// oss-root: `oss/` in the monorepo, the repo root in the public mirror —
// this script sits at <oss-root>/e2e/samples-render/scripts/.
const OSS_ROOT = resolve(HERE, '../../..');
const APP_SHELL = resolve(HERE, '../app-shell');

const SDKS = /** @type {const} */ ([
  'claude-agent-sdk',
  'openai-agents-sdk',
  'google-adk',
  'with-guuey',
]);

/**
 * Per-key merge map. Framework-native keys share the fixed 4-way layout
 * (app-shell at the root, agent under servers/agent, pnpm-workspace tree);
 * `with-guuey` composes guuey's own layout (agent half IS the root, no
 * app-shell, standalone npm halves — see the header).
 *
 * `workspaceTree` drives the package-json rewrite rules: in a workspace tree
 * `@ggui-samples/*` cross-deps stay `workspace:*` (the composed tree resolves
 * them locally); in a non-workspace tree ANY surviving `workspace:*` is a
 * compose-time error — a per-dir npm install would die on the unsupported
 * spec, so fail at the rewrite with a message that says why.
 */
function frameworkPlan(sdk) {
  return {
    appShell: true,
    workspaceTree: true,
    agent: { sample: `samples/agents/${sdk}`, target: 'servers/agent' },
    placements: [
      { sample: 'samples/gguis/default', target: 'servers/ggui' },
      { sample: 'samples/mcp-servers/todo', target: 'servers/mcps/todo' },
      { sample: 'samples/apps/ggui-basic-web', target: 'apps/web' },
    ],
  };
}

const COMPOSE_PLAN = {
  'claude-agent-sdk': frameworkPlan('claude-agent-sdk'),
  'openai-agents-sdk': frameworkPlan('openai-agents-sdk'),
  'google-adk': frameworkPlan('google-adk'),
  'with-guuey': {
    appShell: false,
    workspaceTree: false,
    agent: { sample: 'samples/agents/with-guuey', target: '.' },
    placements: [
      { sample: 'samples/gguis/default', target: 'servers/ggui' },
      { sample: 'samples/mcp-servers/todo', target: 'servers/mcps/todo' },
      { sample: 'samples/apps/with-guuey-web', target: 'apps/web' },
    ],
  },
};

/** Where the with-guuey guuey.json's colocated todo `source` must point in
 *  the COMPOSED layout (`guuey dev` resolves colocated sources against the
 *  guuey.json project root, i.e. the app root here). */
const COMPOSED_TODO_SOURCE = './servers/mcps/todo';

// Point the composed app's ggui UI-generation at the SAME provider as its
// agent, so the app needs ONE API key family (its SDK's), not two. The shared
// gguis/default sample is Claude; compose rewrites servers/ggui/ggui.json's
// generation.model per SDK. Values are canonical `provider:model` routes from
// @ggui-ai/protocol's MODELS registry (providers: anthropic | openai | google).
const GGUI_GENERATION_MODEL = /** @type {const} */ ({
  'claude-agent-sdk': 'anthropic:claude-haiku-4-5-20251001',
  'openai-agents-sdk': 'openai:gpt-5.6-luna',
  'google-adk': 'google:gemini-3.5-flash-lite',
  // with-guuey's agent half runs framework claude-agent-sdk (worker mode —
  // graceful `agent.entry` is google-adk-only under dev-serve), so the whole
  // lane stays on the ANTHROPIC_API_KEY family, like its claude sibling.
  'with-guuey': 'anthropic:claude-haiku-4-5-20251001',
});

/**
 * Read the committed BASE version every @ggui-ai/* package shares. They
 * version in lockstep, so reading one (protocol) suffices. Throws on read
 * failure — a compose-time bug, not a silent fallback.
 */
function readCohortBaseVersion() {
  const raw = readFileSync(resolve(OSS_ROOT, 'packages/protocol/package.json'), 'utf8');
  const pkg = JSON.parse(raw);
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('packages/protocol/package.json missing version');
  }
  return pkg.version;
}

/**
 * The @ggui-ai/* dep range the composed app ships: a prerelease-inclusive
 * caret. `^X.Y.Z-alpha.0` matches the FULL prerelease cohort of the X.Y.Z
 * line (alpha/beta/rc) and auto-promotes to stable X.Y.z once it ships; a
 * plain `^X.Y.Z` would EXCLUDE prereleases and fail to install while only
 * prereleases exist. Resolvers pick the HIGHEST satisfying published version,
 * so the `-alpha.0` floor never *selects* an early build — it only keeps the
 * range satisfiable. Against the harness's Verdaccio (which publishes the
 * cohort at the committed base) the range always resolves to this run's
 * tarballs; the range form itself is what keeps the version-range-resolution
 * failure class observable.
 *
 * A base that is ITSELF a prerelease (`0.4.0-rc.0`) must NOT get the
 * `-alpha.0` suffix: `0.4.0-rc.0-alpha.0` semver-sorts ABOVE `0.4.0-rc.0`
 * (prerelease identifier `0-alpha` > `0`), so the published cohort falls
 * OUTSIDE the range and the install dies with NO_MATCHING_VERSION — the
 * exact 2026-07-27/28 nightly + samples-render failures after the
 * 0.4.0-rc.0 version bump. A caret on the prerelease base is already
 * prerelease-inclusive for its own version line, which is all the floor
 * was buying.
 */
function gguiAiPinRange(base) {
  if (base.includes('-')) return `^${base}`;
  return `^${base}-alpha.0`;
}

/**
 * Rewrite a parsed package.json's `workspace:*` deps:
 *   - `@ggui-ai/*` → `pinRange` (install the published cohort from Verdaccio)
 *   - `@ggui-samples/*` → stays `workspace:*` when the composed tree IS a
 *     pnpm workspace (`workspaceTree: true` — sample cross-deps resolve
 *     locally); in a NON-workspace tree (with-guuey's standalone halves) it
 *     is an error — a per-dir npm install cannot resolve a `workspace:*`
 *     spec, so fail at compose time with the reason instead of at install.
 *   - anything else → error (compose only knows how to rewrite these two)
 * Returns the mutated pkg object.
 */
function rewritePkgJson(pkg, pinRange, workspaceTree = true) {
  for (const depField of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[depField];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (spec !== 'workspace:*') continue;
      if (name.startsWith('@ggui-ai/')) {
        deps[name] = pinRange;
      } else if (!name.startsWith('@ggui-samples/')) {
        throw new Error(
          `unexpected workspace:* dep "${name}" in ${pkg.name ?? '<unnamed>'} — ` +
            'compose-app only rewrites @ggui-ai/* and keeps @ggui-samples/* local',
        );
      } else if (!workspaceTree) {
        throw new Error(
          `workspace:* dep "${name}" in ${pkg.name ?? '<unnamed>'} — the composed ` +
            'with-guuey tree is NOT a pnpm workspace (standalone per-dir npm ' +
            'installs); a workspace:* spec cannot resolve there',
        );
      }
    }
  }
  return pkg;
}

/**
 * Rewrite the with-guuey guuey.json for the composed layout: the todo MCP's
 * colocated `source` is authored relative to the SAMPLES tree
 * (`../../mcp-servers/todo`) and must point at the composed location
 * instead. Throws when the expected entry is missing or shaped differently —
 * a compose-time bug must fail loudly here: `guuey dev` would otherwise
 * warn-and-drop the misconfigured server, leaving the agent tool-less at
 * scenario time. Returns the mutated config object.
 */
function rewriteGuueyJsonTodoSource(cfg, composedSource) {
  const todo = cfg?.agent?.mcpServers?.todo;
  if (
    todo === undefined ||
    todo === null ||
    todo.kind !== 'colocated' ||
    typeof todo.source !== 'string' ||
    typeof todo.devPort !== 'number'
  ) {
    throw new Error(
      'guuey.json: expected agent.mcpServers.todo = { kind: "colocated", ' +
        'source: <string>, devPort: <number> } — compose cannot rewrite the ' +
        'colocated source for the composed layout',
    );
  }
  todo.source = composedSource;
  return cfg;
}

/**
 * Delete every committed `package-lock.json` from the composed COPY (the
 * samples keep theirs — self-hosters get reproducible standalone installs).
 * The locks' `resolved` URLs point `@ggui-ai/*` at registry.npmjs.org; an
 * install that honors them would silently bypass THIS run's Verdaccio cohort
 * — the exact false-green the composed gate exists to prevent. A lock-less
 * `npm install` re-resolves `@ggui-ai/*` against the scoped Verdaccio
 * registry while the exact-pinned `@guuey/*` leaves still land on their
 * published versions from real npm.
 */
function stripNpmLocks(rootDir) {
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === 'node_modules') continue;
        visit(p);
      } else if (entry === 'package-lock.json') {
        rmSync(p);
      }
    }
  };
  visit(rootDir);
}

/**
 * Delete every `pnpm-workspace.yaml` BELOW the composed root (the root's
 * own file — the app-shell workspace wrapper — stays). Sample-carried
 * copies (e.g. the todo sample's `allowBuilds` approval, which serves the
 * standalone with-guuey lane) would otherwise make a workspace MEMBER a
 * nested workspace root, which pnpm does not support.
 */
function stripNestedPnpmWorkspaceFiles(rootDir) {
  const visit = (dir, depth) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === 'node_modules') continue;
        visit(p, depth + 1);
      } else if (entry === 'pnpm-workspace.yaml' && depth > 0) {
        rmSync(p);
      }
    }
  };
  visit(rootDir, 0);
}

function copyTree(src, dst) {
  if (!existsSync(src)) {
    console.error(`✗ source missing: ${src}`);
    process.exit(2);
  }
  cpSync(src, dst, {
    recursive: true,
    // Don't copy build artifacts that may have leaked into a dev workspace.
    filter: (s) => {
      const base = s.split('/').pop();
      return !['node_modules', 'dist', 'dist-ui', '.turbo', '.next'].includes(base);
    },
  });
}

function rewriteAllPackageJsons(rootDir, pinRange, workspaceTree) {
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (entry === 'node_modules') continue;
        visit(p);
      } else if (entry === 'package.json') {
        const raw = readFileSync(p, 'utf8');
        let pkg;
        try {
          pkg = JSON.parse(raw);
        } catch (e) {
          console.error(`✗ invalid JSON in ${p}: ${String(e)}`);
          process.exit(3);
        }
        rewritePkgJson(pkg, pinRange, workspaceTree);
        writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
      }
    }
  };
  visit(rootDir);
}

function composeOne(sdk, outDir) {
  const plan = COMPOSE_PLAN[sdk];
  if (!plan) {
    throw new Error(`compose-app: no COMPOSE_PLAN entry for "${sdk}"`);
  }
  const pinRange = gguiAiPinRange(readCohortBaseVersion());

  console.log(`→ composing ${sdk} into ${outDir} (@ggui-ai/* pinned \`${pinRange}\`)`);

  // Wipe + recreate the target.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 1. The harness-owned shell at the root (workspace wrapper + dev boot) —
  // framework-native keys only; with-guuey's root IS its agent half.
  if (plan.appShell) copyTree(APP_SHELL, outDir);

  // 2. Agent sample → its target (servers/agent/, or the root for with-guuey).
  copyTree(resolve(OSS_ROOT, plan.agent.sample), join(outDir, plan.agent.target));

  // 3. Shared samples → their fixed destinations.
  for (const { sample, target } of plan.placements) {
    copyTree(resolve(OSS_ROOT, sample), join(outDir, target));
  }

  // 3a. with-guuey layout adjustments: point guuey.json's colocated todo
  // `source` at the composed location, and strip the samples' committed npm
  // locks from the COPY so `@ggui-ai/*` re-resolves against this run's
  // Verdaccio cohort (see stripNpmLocks — a kept lock silently bypasses it).
  if (!plan.workspaceTree) {
    const guueyJsonPath = join(outDir, 'guuey.json');
    const guueyCfg = rewriteGuueyJsonTodoSource(
      JSON.parse(readFileSync(guueyJsonPath, 'utf8')),
      COMPOSED_TODO_SOURCE,
    );
    writeFileSync(guueyJsonPath, `${JSON.stringify(guueyCfg, null, 2)}\n`);
    stripNpmLocks(outDir);
  } else {
    // Workspace lanes: a sample may carry its own pnpm-workspace.yaml —
    // the todo sample does (its `allowBuilds` approval is what lets the
    // STANDALONE with-guuey lane's `pnpm install` run esbuild's
    // postinstall under pnpm ≥11's fatal ignored-builds gate). Inside
    // the composed WORKSPACE tree that same file would turn the member
    // into a nested workspace root, so strip every copy below the
    // app-shell's own root file; the root already carries the lanes'
    // build posture (`strictDepBuilds: false`).
    stripNestedPnpmWorkspaceFiles(outDir);
  }

  // 3b. Point ggui's UI generation at this SDK's own provider. Guard the
  // map lookup: an SDK added to SDKS without a model entry would otherwise
  // silently write `generation.model: undefined` into the composed config.
  const gguiModel = GGUI_GENERATION_MODEL[sdk];
  if (!gguiModel) {
    throw new Error(`compose-app: no GGUI_GENERATION_MODEL entry for "${sdk}"`);
  }
  const gguiJsonPath = join(outDir, 'servers/ggui/ggui.json');
  const gguiCfg = JSON.parse(readFileSync(gguiJsonPath, 'utf8'));
  gguiCfg.generation = { ...gguiCfg.generation, model: gguiModel };
  writeFileSync(gguiJsonPath, `${JSON.stringify(gguiCfg, null, 2)}\n`);

  // 4. Name the root after the composed cell + rewrite every package.json.
  const rootPkgPath = join(outDir, 'package.json');
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  rootPkg.name = `rendercell-${sdk}`;
  writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);
  rewriteAllPackageJsons(outDir, pinRange, plan.workspaceTree);

  console.log(
    plan.appShell
      ? `  ✓ app-shell + 4 samples + package-json rewrites`
      : `  ✓ 4 samples (guuey layout, no app-shell) + guuey.json/package-json rewrites`,
  );
}

/**
 * `--self-test`: prove the composer's pure logic can FAIL (evidence-tier
 * parity with the repo's other assembly/drift gates). No filesystem writes.
 * Asserts the pin-range form, the package.json rewrite rules (including the
 * throw on an unknown `workspace:*` dep — the composer's only guard against
 * silently linking unpublished source), and that every SDK has a
 * well-formed `provider:model` generation-model mapping.
 */
function selfTest() {
  const fail = (msg) => {
    console.error(`✗ compose-app self-test: ${msg}`);
    process.exit(1);
  };

  if (gguiAiPinRange('0.3.0') !== '^0.3.0-alpha.0') {
    fail(`gguiAiPinRange('0.3.0') → ${gguiAiPinRange('0.3.0')}, expected ^0.3.0-alpha.0`);
  }
  // Prerelease base: no -alpha.0 suffix — `^0.4.0-rc.0-alpha.0` excludes
  // the published 0.4.0-rc.0 cohort entirely (the 2026-07-28 nightly red).
  if (gguiAiPinRange('0.4.0-rc.0') !== '^0.4.0-rc.0') {
    fail(`gguiAiPinRange('0.4.0-rc.0') → ${gguiAiPinRange('0.4.0-rc.0')}, expected ^0.4.0-rc.0`);
  }

  const pkg = rewritePkgJson(
    {
      name: '@ggui-samples/probe',
      dependencies: { '@ggui-ai/protocol': 'workspace:*', react: '^19.0.0' },
      devDependencies: { '@ggui-ai/cli': 'workspace:*' },
      peerDependencies: { '@ggui-samples/mcp-todo': 'workspace:*' },
    },
    '^9.9.9-alpha.0',
  );
  if (pkg.dependencies['@ggui-ai/protocol'] !== '^9.9.9-alpha.0') {
    fail('dependencies @ggui-ai/* not rewritten to the pin range');
  }
  if (pkg.devDependencies['@ggui-ai/cli'] !== '^9.9.9-alpha.0') {
    fail('devDependencies @ggui-ai/* not rewritten to the pin range');
  }
  if (pkg.peerDependencies['@ggui-samples/mcp-todo'] !== 'workspace:*') {
    fail('@ggui-samples/* workspace dep must stay workspace:* (composed tree IS a workspace)');
  }
  if (pkg.dependencies.react !== '^19.0.0') {
    fail('non-workspace dep must pass through untouched');
  }

  let threw = false;
  try {
    rewritePkgJson({ name: 'x', dependencies: { '@other/pkg': 'workspace:*' } }, '^1.0.0-alpha.0');
  } catch {
    threw = true;
  }
  if (!threw) {
    fail('rewritePkgJson must THROW on an unknown workspace:* dep (seeded negative did not fire)');
  }

  // Non-workspace tree (with-guuey): @ggui-ai/* still rewrites to the pin
  // range, but a surviving @ggui-samples/* workspace dep must THROW — the
  // standalone per-dir npm installs cannot resolve a workspace:* spec.
  const standalone = rewritePkgJson(
    { name: 'probe-standalone', dependencies: { '@ggui-ai/cli': 'workspace:*' } },
    '^9.9.9-alpha.0',
    false,
  );
  if (standalone.dependencies['@ggui-ai/cli'] !== '^9.9.9-alpha.0') {
    fail('non-workspace tree: @ggui-ai/* workspace dep not rewritten to the pin range');
  }
  threw = false;
  try {
    rewritePkgJson(
      { name: 'probe-standalone', dependencies: { '@ggui-samples/mcp-todo': 'workspace:*' } },
      '^9.9.9-alpha.0',
      false,
    );
  } catch {
    threw = true;
  }
  if (!threw) {
    fail(
      'rewritePkgJson must THROW on a @ggui-samples/* workspace:* dep in a ' +
        'NON-workspace tree (seeded negative did not fire)',
    );
  }

  const mapped = Object.keys(GGUI_GENERATION_MODEL).sort();
  const sdks = [...SDKS].sort();
  if (JSON.stringify(mapped) !== JSON.stringify(sdks)) {
    fail(`GGUI_GENERATION_MODEL keys [${mapped}] must exactly equal SDKS [${sdks}]`);
  }
  for (const [sdk, model] of Object.entries(GGUI_GENERATION_MODEL)) {
    if (!/^[a-z]+:[A-Za-z0-9._-]+$/.test(model)) {
      fail(`generation model for ${sdk} ("${model}") is not provider:model shaped`);
    }
  }

  // The merge map covers every SDK key, and the with-guuey plan composes
  // guuey's layout: agent half at the ROOT (guuey.json home), no app-shell,
  // non-workspace tree, with-guuey-web (not ggui-basic-web) at apps/web, and
  // the todo MCP at the exact composed location the guuey.json rewrite
  // points its colocated `source` at.
  const planKeys = Object.keys(COMPOSE_PLAN).sort();
  if (JSON.stringify(planKeys) !== JSON.stringify(sdks)) {
    fail(`COMPOSE_PLAN keys [${planKeys}] must exactly equal SDKS [${sdks}]`);
  }
  const wg = COMPOSE_PLAN['with-guuey'];
  if (wg.appShell !== false || wg.workspaceTree !== false) {
    fail('with-guuey plan must have appShell:false and workspaceTree:false');
  }
  if (wg.agent.sample !== 'samples/agents/with-guuey' || wg.agent.target !== '.') {
    fail('with-guuey plan must compose samples/agents/with-guuey at the app ROOT');
  }
  const wgTargets = Object.fromEntries(wg.placements.map((p) => [p.sample, p.target]));
  if (wgTargets['samples/apps/with-guuey-web'] !== 'apps/web') {
    fail('with-guuey plan must compose samples/apps/with-guuey-web at apps/web');
  }
  if (wgTargets['samples/gguis/default'] !== 'servers/ggui') {
    fail('with-guuey plan must compose samples/gguis/default at servers/ggui');
  }
  const todoTarget = wgTargets['samples/mcp-servers/todo'];
  if (todoTarget === undefined || COMPOSED_TODO_SOURCE !== `./${todoTarget}`) {
    fail(
      `with-guuey todo placement ("${todoTarget}") must match the guuey.json ` +
        `colocated-source rewrite ("${COMPOSED_TODO_SOURCE}")`,
    );
  }
  for (const fw of ['claude-agent-sdk', 'openai-agents-sdk', 'google-adk']) {
    const p = COMPOSE_PLAN[fw];
    if (p.appShell !== true || p.workspaceTree !== true || p.agent.target !== 'servers/agent') {
      fail(`framework plan ${fw} must keep app-shell + workspace tree + servers/agent`);
    }
  }

  // guuey.json colocated-source rewrite: happy path + seeded negative (a
  // missing/misshapen todo entry must THROW, not silently drop — `guuey dev`
  // would warn-and-drop the server, leaving the agent tool-less).
  const rewritten = rewriteGuueyJsonTodoSource(
    {
      agent: {
        framework: 'claude-agent-sdk',
        mcpServers: {
          todo: { kind: 'colocated', source: '../../mcp-servers/todo', devPort: 6740 },
        },
      },
    },
    COMPOSED_TODO_SOURCE,
  );
  if (rewritten.agent.mcpServers.todo.source !== COMPOSED_TODO_SOURCE) {
    fail('rewriteGuueyJsonTodoSource did not rewrite the colocated source');
  }
  if (rewritten.agent.mcpServers.todo.devPort !== 6740) {
    fail('rewriteGuueyJsonTodoSource must leave devPort untouched');
  }
  threw = false;
  try {
    rewriteGuueyJsonTodoSource({ agent: { mcpServers: {} } }, COMPOSED_TODO_SOURCE);
  } catch {
    threw = true;
  }
  if (!threw) {
    fail(
      'rewriteGuueyJsonTodoSource must THROW when the colocated todo entry is ' +
        'missing (seeded negative did not fire)',
    );
  }

  console.log(
    '✓ compose-app self-test: pin range, rewrite rules (incl. seeded throws), ' +
      'model map, compose plans (incl. with-guuey layout + guuey.json rewrite) — all fire correctly',
  );
}

function parseArgs(argv) {
  const args = { sdk: null, out: null, selfTest: false };
  for (const a of argv) {
    if (a === '--self-test') args.selfTest = true;
    else if (a.startsWith('--sdk=')) args.sdk = a.slice('--sdk='.length);
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node compose-app.mjs --sdk=<sdk> --out=<dir>
  node compose-app.mjs --self-test

  --sdk=<sdk>   One of: ${SDKS.join(', ')}.
  --out=<dir>   Target dir (wiped + recreated).
  --self-test   Prove the pure compose logic can fail (no fs writes).
`);
      process.exit(0);
    } else {
      console.error(`✗ unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (args.selfTest) return args;
  if (!args.sdk || !args.out) {
    console.error('✗ pass --sdk=<sdk> and --out=<dir> (or --self-test)');
    process.exit(1);
  }
  if (!SDKS.includes(args.sdk)) {
    console.error(`✗ unknown sdk: ${args.sdk} (expected one of ${SDKS.join(', ')})`);
    process.exit(1);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.selfTest) {
  selfTest();
} else {
  composeOne(args.sdk, resolve(args.out));
}
