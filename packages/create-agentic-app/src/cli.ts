#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI; stdout is its UI. */
/**
 * create-agentic-app — scaffold a ggui agentic app from one of the
 * three official templates.
 *
 *   npx @ggui-ai/create-agentic-app                  # full interactive
 *   npx @ggui-ai/create-agentic-app my-app           # name from positional
 *   npx @ggui-ai/create-agentic-app \
 *     --name my-app --scope acme --agent claude-agent-sdk --install
 *   npx @ggui-ai/create-agentic-app --list-agents
 *
 * Mechanics: shallow-clones github.com/ggui-ai/agentic-app-templates,
 * extracts the chosen SDK subdir into the target dir, renames
 * `agentic-app-template` → <name> and `@agentic-app-template/*` →
 * `@<scope>/*` in every package.json + a few docstring sites, seeds
 * `.env.local` from `.env.example`, optionally runs `pnpm install`.
 *
 * The user can still run `/bootstrap` inside Claude Code afterwards —
 * that command tailors README/CLAUDE.md prose and deletes itself.
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const REPO_URL =
  process.env.GGUI_TEMPLATES_REPO_URL ?? 'https://github.com/ggui-ai/agentic-app-templates';
const REPO_REF = process.env.GGUI_TEMPLATES_REF ?? 'main';

const AGENTS = ['claude-agent-sdk', 'openai-agents-sdk', 'google-adk'] as const;
type Agent = (typeof AGENTS)[number];

const API_KEY_BY_AGENT: Record<Agent, string> = {
  'claude-agent-sdk': 'ANTHROPIC_API_KEY',
  'openai-agents-sdk': 'OPENAI_API_KEY',
  'google-adk': 'GEMINI_API_KEY',
};

const DEFAULT_PORT_BY_AGENT: Record<Agent, string> = {
  'claude-agent-sdk': '6790',
  'openai-agents-sdk': '6791',
  'google-adk': '6792',
};

interface Args {
  target?: string;
  name?: string;
  scope?: string;
  agent?: Agent;
  install?: boolean;
  git?: boolean;
  force?: boolean;
  ref?: string;
  listAgents?: boolean;
  help?: boolean;
}

// npm name rules: lowercase letters/digits/hyphen, not hyphen-leading.
const validName = (s: string): boolean =>
  typeof s === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s);

function parseArgs(argv: readonly string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === '--help' || t === '-h') a.help = true;
    else if (t === '--list-agents') a.listAgents = true;
    else if (t === '--install') a.install = true;
    else if (t === '--no-git') a.git = false;
    else if (t === '--force') a.force = true;
    else if (t === '--name') a.name = argv[++i];
    else if (t === '--scope') a.scope = argv[++i];
    else if (t === '--agent') {
      const v = argv[++i];
      if (v && (AGENTS as readonly string[]).includes(v)) a.agent = v as Agent;
      else {
        console.error(`✗ --agent must be one of: ${AGENTS.join(', ')}`);
        process.exit(1);
      }
    } else if (t === '--ref') a.ref = argv[++i];
    else if (!t.startsWith('-')) {
      if (a.target) {
        console.error(`✗ unexpected positional: ${t}`);
        process.exit(1);
      }
      a.target = t;
    } else {
      console.error(`✗ unknown argument: ${t}`);
      process.exit(1);
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`create-agentic-app — scaffold a ggui agentic app

Usage:
  npx @ggui-ai/create-agentic-app [<target>] [options]

Positional:
  <target>           Target directory (also used as the npm package name
                     unless --name is given). Prompted if omitted.

Options:
  --name <name>      npm package name. Defaults to <target>. kebab-case.
  --scope <scope>    npm scope for servers/* packages (no leading @).
                     Prompted if omitted.
  --agent <sdk>      One of: ${AGENTS.join(', ')}. Prompted if omitted.
  --install          Run \`pnpm install\` after scaffolding.
  --no-git           Skip \`git init\` + initial commit (done by default).
  --force            Overwrite target if it exists (non-empty).
  --ref <ref>        git ref of ${REPO_URL} to clone from (default: ${REPO_REF}).
  --list-agents      Print the supported agent SDKs and exit.
  --help, -h         Show this help.
`);
}

async function ask(
  rl: ReturnType<typeof createInterface>,
  label: string,
  validate: (v: string) => boolean,
): Promise<string> {
  for (;;) {
    const v = (await rl.question(label)).trim();
    if (validate(v)) return v;
    console.error('  ✗ invalid value — try again.');
  }
}

function ensureGitAvailable(): void {
  const r = spawnSync('git', ['--version'], { stdio: 'ignore' });
  if (r.status !== 0) {
    console.error('✗ `git` is required to clone the templates repo but was not found on PATH.');
    console.error('  Install git and re-run, or set GGUI_TEMPLATES_REPO_URL to a local path.');
    process.exit(1);
  }
}

function shallowClone(ref: string, dest: string): void {
  console.log(`Fetching ${REPO_URL} (${ref})…`);
  const r = spawnSync(
    'git',
    ['clone', '--depth', '1', '--branch', ref, REPO_URL, dest],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (r.status !== 0) {
    console.error(`\n✗ git clone failed — is ${REPO_URL} reachable?`);
    process.exit(1);
  }
}

/**
 * Replace `@agentic-app-template/<leaf>` → `@<scope>/<leaf>` and
 * the root `"name": "agentic-app-template"` marker → `"name": "<name>"`.
 * Walks the whole tree (skipping node_modules) — the assembled template
 * has packages under `servers/agent`, `servers/ggui`, `servers/mcps/*`,
 * AND `apps/*`. Docs intentionally keep their original wording until the
 * user runs `/bootstrap` (the Claude Code slash command) to tailor them.
 */
function renameProject(targetDir: string, name: string, scope: string): void {
  // 1. Root package.json gets the user's project name.
  const pkgRootPath = join(targetDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgRootPath, 'utf8')) as { name?: string };
  pkg.name = name;
  writeFileSync(pkgRootPath, `${JSON.stringify(pkg, null, 2)}\n`);

  // 2. Every nested package.json with a @agentic-app-template/* name
  // gets the user's scope. Walk the tree; the layout has packages under
  // servers/agent, servers/ggui, servers/mcps/*, apps/*, blueprints/*,
  // gadgets/*. Future templates may grow more — recursion makes adding
  // them zero-touch for this script.
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        visit(p);
      } else if (entry === 'package.json' && p !== pkgRootPath) {
        const sPkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: string };
        if (typeof sPkg.name === 'string' && sPkg.name.startsWith('@agentic-app-template/')) {
          sPkg.name = sPkg.name.replace('@agentic-app-template/', `@${scope}/`);
          writeFileSync(p, `${JSON.stringify(sPkg, null, 2)}\n`);
        }
      }
    }
  };
  visit(targetDir);
}

function seedEnvLocal(targetDir: string): boolean {
  const envExample = join(targetDir, '.env.example');
  const envLocal = join(targetDir, '.env.local');
  if (existsSync(envLocal)) return false;
  if (!existsSync(envExample)) return false;
  copyFileSync(envExample, envLocal);
  return true;
}

function runInstall(targetDir: string): boolean {
  console.log('\nInstalling dependencies (pnpm install)…\n');
  const r = spawnSync('pnpm', ['install'], { cwd: targetDir, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('\n✗ pnpm install failed.');
    return false;
  }
  return true;
}

const INITIAL_COMMIT_MSG = 'Initial commit (scaffolded by @ggui-ai/create-agentic-app)';

/**
 * `git init` + first commit in the scaffolded project. The template
 * `.gitignore` already excludes `.env*.local`, `node_modules`, and `dist`, so
 * `git add -A` never captures secrets or build artifacts.
 *
 * Prefers the user's configured git identity; if none is set (fresh machine /
 * CI), retries the commit with a generic identity so the first commit still
 * lands — the user can re-author it with `git commit --amend --reset-author`.
 * If even that fails, the half-initialized `.git` is removed and we report skip.
 */
function gitInitAndCommit(targetDir: string): boolean {
  const run = (gitArgs: string[], extraEnv: Record<string, string> = {}): number => {
    const r = spawnSync('git', gitArgs, {
      cwd: targetDir,
      stdio: 'ignore',
      env: { ...process.env, ...extraEnv },
    });
    return r.status ?? 1;
  };

  if (run(['init', '-q']) !== 0) return false;
  run(['add', '-A']);

  let status = run(['commit', '-q', '-m', INITIAL_COMMIT_MSG]);
  if (status !== 0) {
    status = run(['commit', '-q', '-m', INITIAL_COMMIT_MSG], {
      GIT_AUTHOR_NAME: 'ggui',
      GIT_AUTHOR_EMAIL: 'ggui@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'ggui',
      GIT_COMMITTER_EMAIL: 'ggui@users.noreply.github.com',
    });
  }
  if (status !== 0) {
    rmSync(join(targetDir, '.git'), { recursive: true, force: true });
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }
  if (args.listAgents) {
    for (const a of AGENTS) console.log(a);
    return;
  }

  ensureGitAvailable();

  // Resolve target dir + name. Positional target doubles as name unless
  // --name overrides.
  let target = args.target;
  let name = args.name;
  let scope = args.scope;
  let agent = args.agent;

  const needsPrompt = !target || !scope || !agent;
  if (needsPrompt) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!target) target = await ask(rl, 'Project directory (kebab-case): ', validName);
      if (!name) name = target;
      if (!scope) scope = await ask(rl, 'npm scope (without @): ', validName);
      if (!agent) {
        console.log('\nAgent SDK options:');
        AGENTS.forEach((a, i) => console.log(`  ${i + 1}. ${a}`));
        agent = (await ask(rl, 'Agent SDK: ', (v) =>
          (AGENTS as readonly string[]).includes(v),
        )) as Agent;
      }
    } finally {
      rl.close();
    }
  }
  if (!target) {
    console.error('✗ target directory required.');
    process.exit(1);
  }
  if (!name) name = target;
  if (!scope) {
    console.error('✗ --scope required.');
    process.exit(1);
  }
  if (!agent) {
    console.error('✗ --agent required.');
    process.exit(1);
  }
  if (!validName(name) || !validName(scope)) {
    console.error('✗ name and scope must be lowercase kebab-case.');
    process.exit(1);
  }

  const targetAbs = resolve(process.cwd(), target);
  if (existsSync(targetAbs)) {
    const contents = readdirSync(targetAbs).filter((f) => !f.startsWith('.'));
    if (contents.length > 0 && !args.force) {
      console.error(`✗ target "${targetAbs}" already exists and is non-empty. Pass --force to overwrite.`);
      process.exit(1);
    }
  }

  // 1. Shallow-clone the templates repo into a tmpdir.
  const tmp = mkdtempSync(join(tmpdir(), 'create-agentic-app-'));
  try {
    shallowClone(args.ref ?? REPO_REF, tmp);

    const sourceSubdir = join(tmp, agent);
    if (!existsSync(sourceSubdir)) {
      console.error(`\n✗ "${agent}" is not in ${REPO_URL} yet.`);
      console.error('  Available subdirs:');
      for (const d of readdirSync(tmp).filter((d) => !d.startsWith('.'))) {
        console.error(`    - ${d}`);
      }
      process.exit(1);
    }

    // 2. Copy the chosen template subdir into the target.
    cpSync(sourceSubdir, targetAbs, { recursive: true });
    // Strip any artifacts that slipped in.
    for (const junk of ['node_modules', 'dist', 'dist-ui', '.turbo']) {
      rmSync(join(targetAbs, junk), { recursive: true, force: true });
    }
    console.log(`✓ scaffolded ${agent} into ${targetAbs}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // 3. Rename root + per-server packages.
  renameProject(targetAbs, name, scope);
  console.log(`✓ root package → ${name}`);
  console.log(`✓ servers/* packages → @${scope}/*`);

  // 4. Seed .env.local.
  if (seedEnvLocal(targetAbs)) {
    const apiKeyVar = API_KEY_BY_AGENT[agent];
    console.log(`✓ .env.local seeded — add your ${apiKeyVar}`);
  } else {
    console.log('• .env.local already present — left untouched');
  }

  // 5. Optionally install.
  if (args.install) {
    if (!runInstall(targetAbs)) process.exit(1);
  }

  // 5.5 git init + first commit (default on; --no-git to skip). Runs after
  // install so a generated pnpm-lock.yaml lands in the first commit.
  if (args.git !== false) {
    if (gitInitAndCommit(targetAbs)) console.log('✓ git repo initialized + first commit');
    else console.log('• skipped git init — run `git init` yourself if you want version control');
  }

  // 6. Report.
  const apiKeyVar = API_KEY_BY_AGENT[agent];
  const port = DEFAULT_PORT_BY_AGENT[agent];
  console.log('\n✓ Done.\n');
  console.log('Next steps:');
  let step = 1;
  console.log(`  ${step++}. cd ${target}`);
  if (!args.install) console.log(`  ${step++}. pnpm install`);
  console.log(`  ${step++}. Add your key to .env.local → ${apiKeyVar}=…`);
  console.log(`  ${step++}. Run the four servers in separate terminals:`);
  console.log('       pnpm dev:ggui   # ggui MCP server   → http://localhost:6781/mcp');
  console.log('       pnpm dev:todo   # todo MCP server   → http://localhost:6782/mcp');
  console.log(`       pnpm dev:agent  # agent backend     → http://localhost:${port}`);
  console.log('       pnpm dev:web    # frontend SPA      → http://localhost:6890');
  console.log(`  ${step++}. Open http://localhost:6890 and chat.`);
  console.log(
    '\nInside Claude Code, run `/bootstrap` to tailor README + CLAUDE.md for your project.',
  );
}

main().catch((err: unknown) => {
  console.error('create-agentic-app failed:', err);
  process.exit(1);
});
