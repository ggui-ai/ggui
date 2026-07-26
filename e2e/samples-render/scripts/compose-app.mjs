#!/usr/bin/env node
/**
 * compose-app — assemble a runnable agentic app DIRECTLY from `oss/samples/*`
 * for the samples-render sub-tier-B e2e. This is the Phase-1 replacement for
 * the `create-agentic-app` scaffolder path: the same merge the retired
 * template assembler performed, minus the template-shell wrappers (README,
 * railway.toml, .claude/, .reference/ — publish/DX artifacts, not behavior).
 *
 * Merge map (paths relative to the oss-root):
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
 * Package-json rewrites at compose time:
 *   1. Root `"name"` → `rendercell-<sdk>`.
 *   2. `"@ggui-ai/<pkg>": "workspace:*"` → the prerelease-inclusive caret
 *      range `^<base>-alpha.0` (base read from packages/protocol — the
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
 *   node compose-app.mjs --sdk=<claude-agent-sdk|openai-agents-sdk|google-adk> --out=<dir>
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

const SDKS = /** @type {const} */ (['claude-agent-sdk', 'openai-agents-sdk', 'google-adk']);

const PLACEMENTS = /** @type {const} */ ([
  { sample: 'samples/gguis/default', target: 'servers/ggui' },
  { sample: 'samples/mcp-servers/todo', target: 'servers/mcps/todo' },
  { sample: 'samples/apps/ggui-basic-web', target: 'apps/web' },
]);

const AGENT_TARGET = 'servers/agent';

// Point the composed app's ggui UI-generation at the SAME provider as its
// agent, so the app needs ONE API key family (its SDK's), not two. The shared
// gguis/default sample is Claude; compose rewrites servers/ggui/ggui.json's
// generation.model per SDK. Values are canonical `provider:model` routes from
// @ggui-ai/protocol's MODELS registry (providers: anthropic | openai | google).
const GGUI_GENERATION_MODEL = /** @type {const} */ ({
  'claude-agent-sdk': 'anthropic:claude-haiku-4-5-20251001',
  'openai-agents-sdk': 'openai:gpt-5.6-luna',
  'google-adk': 'google:gemini-3.5-flash-lite',
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
 */
function gguiAiPinRange(base) {
  return `^${base}-alpha.0`;
}

/**
 * Rewrite a parsed package.json's `workspace:*` deps:
 *   - `@ggui-ai/*` → `pinRange` (install the published cohort from Verdaccio)
 *   - `@ggui-samples/*` → stays `workspace:*` (the composed tree IS a workspace)
 *   - anything else → error (compose only knows how to rewrite these two)
 * Returns the mutated pkg object.
 */
function rewritePkgJson(pkg, pinRange) {
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
      }
    }
  }
  return pkg;
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

function rewriteAllPackageJsons(rootDir, pinRange) {
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
        rewritePkgJson(pkg, pinRange);
        writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
      }
    }
  };
  visit(rootDir);
}

function composeOne(sdk, outDir) {
  const agentSampleAbs = resolve(OSS_ROOT, `samples/agents/${sdk}`);
  const pinRange = gguiAiPinRange(readCohortBaseVersion());

  console.log(`→ composing ${sdk} into ${outDir} (@ggui-ai/* pinned \`${pinRange}\`)`);

  // Wipe + recreate the target.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 1. The harness-owned shell at the root (workspace wrapper + dev boot).
  copyTree(APP_SHELL, outDir);

  // 2. Agent sample → servers/agent/.
  copyTree(agentSampleAbs, join(outDir, AGENT_TARGET));

  // 3. Shared samples → their fixed destinations.
  for (const { sample, target } of PLACEMENTS) {
    copyTree(resolve(OSS_ROOT, sample), join(outDir, target));
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
  rewriteAllPackageJsons(outDir, pinRange);

  console.log(`  ✓ app-shell + 4 samples + package-json rewrites`);
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

  console.log('✓ compose-app self-test: pin range, rewrite rules (incl. seeded throw), model map — all fire correctly');
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
