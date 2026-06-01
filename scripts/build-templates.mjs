#!/usr/bin/env node
/**
 * build-templates — assemble agentic-app-template-<sdk>/ trees from
 * canonical samples + per-SDK shells.
 *
 * Paths are resolved relative to the oss-root (REPO_ROOT = the dir one level
 * above this script). That is `oss/` in the monorepo and the repo root in the
 * published `ggui-ai/ggui` mirror (where the `oss/` subtree sits at the root) —
 * so the same relative paths work in both contexts.
 *
 * Source of truth lives in TWO places (relative to oss-root):
 *
 *   samples/agents/<sdk>/        ← SDK-specific agent backend
 *   samples/gguis/default/       ← canonical ggui server config
 *   samples/mcp-servers/todo/    ← canonical reference MCP server
 *   samples/apps/ggui-basic-web/ ← canonical Vite SPA frontend
 *
 *   template-shells/agentic-app-template/<sdk>/
 *       ← per-SDK wrapper: package.json, pnpm-workspace.yaml,
 *         railway.toml, README, CLAUDE.md, LICENSE, .gitignore,
 *         .env.example, .mcp.json, .claude/{settings.json,commands/}
 *
 * Output: one assembled tree per SDK at
 *   <outBase>/<sdk>/
 * Each tree is a complete pnpm monorepo runnable via `pnpm install &&
 * pnpm dev:*`. Internal layout:
 *
 *   <sdk>/
 *     package.json + pnpm-workspace.yaml + railway.toml + …
 *     servers/agent/    (from samples/agents/<sdk>/)
 *     servers/ggui/     (from samples/gguis/default/)
 *     servers/mcps/todo/ (from samples/mcp-servers/todo/)
 *     apps/web/         (from samples/apps/ggui-basic-web/)
 *
 * Package-json rewrites at assembly time:
 *   1. `"name": "@ggui-samples/<X>"` → `"name": "@agentic-app-template/<X>"`
 *      so create-agentic-app can globally s/@agentic-app-template/@<scope>/.
 *   2. `"<pkg>": "workspace:*"` → `"<pkg>": "<PUBLISHED_VERSION>"` for
 *      every `@ggui-ai/*` dep, so the assembled tree installs from npm.
 *      With `--pin=<version>` the @ggui-ai/* deps are pinned EXACTLY to
 *      <version> (the co-published cohort) instead of a caret range.
 *
 * Usage:
 *   node oss/scripts/build-templates.mjs --all --out-base=/tmp/templates
 *   node oss/scripts/build-templates.mjs --sdk=claude-agent-sdk --out=/tmp/x
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
const REPO_ROOT = resolve(HERE, '..');

const SDKS = /** @type {const} */ (['claude-agent-sdk', 'openai-agents-sdk', 'google-adk']);

/**
 * Per-SDK assembly recipe. KEY = output subdir under outBase. Each entry's
 * `shell` + `agentSample` is mandatory; the other 3 are shared across SDKs.
 *
 * To add a new SDK: drop samples/agents/<sdk>/ + template-shells/
 * agentic-app-template/<sdk>/ (relative to oss-root), then append an entry
 * here.
 */
const RECIPES = SDKS.map((sdk) => ({
  sdk,
  shellDir: `template-shells/agentic-app-template/${sdk}`,
  agentSampleDir: `samples/agents/${sdk}`,
}));

const SHARED_PLACEMENTS = /** @type {const} */ ([
  { sample: 'samples/gguis/default', target: 'servers/ggui' },
  { sample: 'samples/mcp-servers/todo', target: 'servers/mcps/todo' },
  { sample: 'samples/apps/ggui-basic-web', target: 'apps/web' },
]);

const AGENT_TARGET = 'servers/agent';

// Point each template's ggui UI-generation at the SAME provider as its agent,
// so the template needs ONE API key (its SDK's), not two. The shared
// gguis/default sample is Claude; assembleOne rewrites servers/ggui/ggui.json's
// generation.model per SDK. Values are canonical `provider:model` routes from
// @ggui-ai/protocol's MODELS registry (providers: anthropic | openai | google).
const GGUI_GENERATION_MODEL = /** @type {const} */ ({
  'claude-agent-sdk': 'anthropic:claude-haiku-4-5-20251001',
  'openai-agents-sdk': 'openai:gpt-5.4-mini',
  'google-adk': 'google:gemini-3.1-flash-lite',
});

/**
 * Read the committed BASE version every @ggui-ai/* package shares (e.g.
 * "0.2.0"). They version in lockstep, so reading one (protocol) suffices.
 * NOTE: this base is the eventual-stable target and is NOT itself
 * necessarily published — only prereleases (0.2.0-alpha.N, under dist-tags
 * alpha/beta/rc) may exist on npm yet. The assembler turns it into a
 * prerelease-inclusive caret range (see rewritePkgJson) so the template
 * actually installs. Throws on read failure — a build-time bug, not a
 * silent fallback.
 */
function readPublishedVersion() {
  const p = readFileSync(
    resolve(REPO_ROOT, 'packages/protocol/package.json'),
    'utf8',
  );
  const pkg = JSON.parse(p);
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('packages/protocol/package.json missing version');
  }
  return pkg.version;
}

/**
 * Scan `packages/*` (relative to oss-root) for the publishable `@ggui-ai/*`
 * packages and map each package name → its absolute workspace directory.
 * Used by `--link`
 * mode: instead of pinning a published version, the assembler rewrites
 * `@ggui-ai/*` deps to `link:<dir>` so the assembled template installs
 * symlinks straight to your LOCAL source (built dist) — no Verdaccio, no
 * `make registry`. Transitive `@ggui-ai/*` deps of the linked packages
 * resolve through the workspace, so the whole tree stays local.
 */
function buildGguiAiLinkMap() {
  const map = {};
  const root = resolve(REPO_ROOT, 'packages');
  if (!existsSync(root)) return map;
  for (const entry of readdirSync(root)) {
    const pj = join(root, entry, 'package.json');
    if (!existsSync(pj)) continue;
    try {
      const name = JSON.parse(readFileSync(pj, 'utf8')).name;
      if (typeof name === 'string' && name.startsWith('@ggui-ai/')) {
        map[name] = join(root, entry);
      }
    } catch {
      // unreadable/invalid package.json — skip
    }
  }
  return map;
}

/**
 * Rewrite a parsed package.json:
 *   - "@ggui-samples/<X>" → "@agentic-app-template/<X>" (root name + any deps)
 *   - "workspace:*" → published version for @ggui-ai/* and @agentic-app-template/* deps
 *     (or `link:<local-dir>` when `linkMap` is provided — `--link` mode;
 *      or the EXACT `pin` version when `pin` is provided — `--pin` mode).
 * Returns the mutated pkg object.
 */
function rewritePkgJson(pkg, publishedVersion, linkMap, pin) {
  if (typeof pkg.name === 'string' && pkg.name.startsWith('@ggui-samples/')) {
    pkg.name = pkg.name.replace(/^@ggui-samples\//, '@agentic-app-template/');
  }
  for (const depField of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[depField];
    if (!deps || typeof deps !== 'object') continue;
    const renamed = {};
    for (const [name, spec] of Object.entries(deps)) {
      const newName = name.startsWith('@ggui-samples/')
        ? name.replace(/^@ggui-samples\//, '@agentic-app-template/')
        : name;
      if (spec === 'workspace:*') {
        if (newName.startsWith('@ggui-ai/')) {
          if (linkMap) {
            // --link mode: point at the LOCAL workspace package dir so the
            // assembled template runs your uncommitted source (built dist).
            // No published version / Verdaccio needed. (Rebuild the package
            // after edits so its dist is current.) STRICT: a @ggui-ai/* dep
            // with no local package is a real gap (published-only / wrong
            // scope), so throw rather than silently mixing in a published
            // pin — link mode must be all-local or fail loudly.
            const dir = linkMap[newName];
            if (!dir) {
              throw new Error(
                `--link: no local @ggui-ai/* workspace package "${newName}" under ` +
                  `packages/ (needed by ${pkg.name ?? '<unnamed>'}). ` +
                  `Published-only or another scope?`,
              );
            }
            renamed[newName] = `link:${dir}`;
            continue;
          }
          if (pin) {
            // --pin mode: pin the @ggui-ai/* dep EXACTLY to the co-published
            // cohort version (no caret). Used by the bundled create-agentic-app
            // build so the scaffold pins to a version guaranteed to exist on
            // npm (the CLI's own published cohort) rather than a moving range.
            renamed[newName] = pin;
            continue;
          }
          // Prerelease-inclusive caret, NOT an exact pin. `^X.Y.Z-alpha.1`
          // installs the latest published X.Y.Z prerelease (the alpha/beta/rc
          // cohort) and auto-promotes to stable X.Y.z once it ships; a plain
          // `^X.Y.Z` would EXCLUDE prereleases and fail to install today.
          // Floor is `-alpha.1`, NOT `-alpha.0`: the `-alpha.0` build of some
          // packages (e.g. @ggui-ai/agent-server) was published with internal
          // deps pinned to the unpublished plain base (`"@ggui-ai/protocol":
          // "0.2.0"`), so `^…-alpha.0` admits that poisoned build and breaks
          // `pnpm install` (ERR_PNPM_NO_MATCHING_VERSION). `publishedVersion`
          // is the committed base (e.g. "0.2.0") — see readPublishedVersion.
          renamed[newName] = `^${publishedVersion}-alpha.1`;
        } else if (newName.startsWith('@agentic-app-template/')) {
          // Inter-template deps stay workspace-flavored — the assembled tree
          // IS a pnpm workspace, so workspace:* resolves locally.
          renamed[newName] = 'workspace:*';
        } else {
          throw new Error(
            `unexpected workspace:* dep "${name}" in ${pkg.name ?? '<unnamed>'} — ` +
              'assembler only knows how to rewrite @ggui-ai/* and @ggui-samples/*',
          );
        }
      } else {
        renamed[newName] = spec;
      }
    }
    pkg[depField] = renamed;
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

function rewriteAllPackageJsons(rootDir, publishedVersion, linkMap, pin) {
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
        rewritePkgJson(pkg, publishedVersion, linkMap, pin);
        writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
      }
    }
  };
  visit(rootDir);
}

function assembleOne(sdk, outDir, publishedVersion, linkMap, pin) {
  const recipe = RECIPES.find((r) => r.sdk === sdk);
  if (!recipe) {
    console.error(`✗ unknown sdk: ${sdk}`);
    process.exit(1);
  }
  const shellAbs = resolve(REPO_ROOT, recipe.shellDir);
  const agentSampleAbs = resolve(REPO_ROOT, recipe.agentSampleDir);

  console.log(`\n→ assembling ${sdk} into ${outDir}`);

  // Wipe + recreate the target.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 1. Shell at the root.
  copyTree(shellAbs, outDir);

  // 2. Agent sample → servers/agent/.
  copyTree(agentSampleAbs, join(outDir, AGENT_TARGET));

  // 3. Shared samples → their fixed destinations.
  for (const { sample, target } of SHARED_PLACEMENTS) {
    copyTree(resolve(REPO_ROOT, sample), join(outDir, target));
  }

  // 3b. Point ggui's UI generation at this SDK's own provider so the template
  // needs ONE API key, not two. The shared gguis/default sample is Claude.
  const gguiModel = GGUI_GENERATION_MODEL[sdk];
  if (!gguiModel) {
    throw new Error(`build-templates: no GGUI_GENERATION_MODEL entry for "${sdk}"`);
  }
  const gguiJsonPath = join(outDir, 'servers/ggui/ggui.json');
  const gguiCfg = JSON.parse(readFileSync(gguiJsonPath, 'utf8'));
  gguiCfg.generation = { ...gguiCfg.generation, model: gguiModel };
  writeFileSync(gguiJsonPath, `${JSON.stringify(gguiCfg, null, 2)}\n`);

  // 4. Rewrite every package.json.
  rewriteAllPackageJsons(outDir, publishedVersion, linkMap, pin);

  console.log(`  ✓ shell + 4 samples + package-json rewrites`);
}

function parseArgs(argv) {
  const args = { sdk: null, all: false, out: null, outBase: null, link: false, pin: null };
  for (const a of argv) {
    if (a === '--all') args.all = true;
    else if (a.startsWith('--sdk=')) args.sdk = a.slice('--sdk='.length);
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
    else if (a.startsWith('--out-base=')) args.outBase = a.slice('--out-base='.length);
    else if (a === '--link') args.link = true;
    else if (a.startsWith('--pin=')) args.pin = a.slice('--pin='.length);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node oss/scripts/build-templates.mjs --all --out-base=<dir>
  node oss/scripts/build-templates.mjs --sdk=<sdk> --out=<dir>

  --all              Assemble all SDKs (${SDKS.join(', ')}).
  --sdk=<sdk>        Assemble just one SDK.
  --out-base=<dir>   With --all: parent dir; each SDK lands at <dir>/<sdk>/.
  --out=<dir>        With --sdk: exact target dir.
  --pin=<version>    Pin @ggui-ai/* deps EXACTLY to <version> (no caret),
                     instead of the default \`^<base>-alpha.1\` range. Used by
                     the bundled create-agentic-app build to pin the scaffold
                     to its co-published cohort version. Mutually exclusive
                     with --link.
  --link             Rewrite @ggui-ai/* deps to link:<local-workspace-dir>
                     (built dist) instead of the published pin, so the
                     assembled template runs your LOCAL source — no Verdaccio.
                     LOCAL DEV ONLY; never use for the published/sync flow.
`);
      process.exit(0);
    } else {
      console.error(`✗ unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (args.all && args.sdk) {
    console.error('✗ pass --all OR --sdk, not both');
    process.exit(1);
  }
  if (args.link && args.pin) {
    console.error('✗ pass --link OR --pin, not both');
    process.exit(1);
  }
  if (!args.all && !args.sdk) {
    console.error('✗ pass --all or --sdk=<sdk>');
    process.exit(1);
  }
  if (args.all && !args.outBase) {
    console.error('✗ --all requires --out-base=<dir>');
    process.exit(1);
  }
  if (args.sdk && !args.out) {
    console.error('✗ --sdk requires --out=<dir>');
    process.exit(1);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const publishedVersion = readPublishedVersion();
  const linkMap = args.link ? buildGguiAiLinkMap() : null;
  const pin = args.pin;
  if (linkMap) {
    console.log(
      `build-templates: --link mode → @ggui-ai/* deps point at LOCAL workspace ` +
        `dirs (${Object.keys(linkMap).length} packages). Rebuild them first so dist is current.`,
    );
  } else if (pin) {
    console.log(`build-templates: --pin mode → @ggui-ai/* deps pinned EXACTLY to \`${pin}\``);
  } else {
    console.log(
      `build-templates: @ggui-ai/* base ${publishedVersion} → pinned \`^${publishedVersion}-alpha.1\``,
    );
  }

  if (args.all) {
    for (const { sdk } of RECIPES) {
      const outDir = resolve(args.outBase, sdk);
      assembleOne(sdk, outDir, publishedVersion, linkMap, pin);
    }
    console.log(`\n✓ assembled ${RECIPES.length} templates under ${args.outBase}/`);
  } else {
    assembleOne(args.sdk, resolve(args.out), publishedVersion, linkMap, pin);
    console.log(`\n✓ assembled ${args.sdk} at ${resolve(args.out)}`);
  }
}

main();
