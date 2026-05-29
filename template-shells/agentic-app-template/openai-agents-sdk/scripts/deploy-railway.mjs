#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI; stdout is its UI. */
/**
 * deploy-railway — one-command Railway deploy for this agentic-app monorepo.
 *
 *   pnpm deploy:railway              # create project + deploy all services
 *   pnpm deploy:railway -- --dry-run # print the plan, change nothing
 *   pnpm deploy:railway -- --only web --name my-app
 *
 * The script (loaded with .env.local via dotenv-cli) drives Railway entirely
 * from your machine using the Railway CLI plus Railway's public GraphQL API:
 *   1. create + link a Railway project           (railway init)
 *   2. for each service — ggui, the domain MCP(s), agent, web:
 *        a. create it                             (railway add)
 *        b. set its build + start command         (GraphQL serviceInstanceUpdate —
 *           the ONE thing the CLI cannot do for a shared pnpm workspace)
 *        c. set env vars incl. cross-service refs (railway variable set)
 *        d. give public services a domain         (railway domain)
 *        e. deploy it                             (railway up)
 *
 * Required env (from .env.local):
 *   RAILWAY_API_TOKEN  account/workspace token — https://railway.com/account/tokens
 *   <LLM>_API_KEY      ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY
 *                      (whichever your agent + ggui use — forwarded to both)
 *
 * Honest limits: `railway up` deploys one service at a time (the repo is
 * uploaded per service). If the GraphQL build/start update fails, the service
 * is still created and the exact manual dashboard step is printed — you are
 * never left stuck. The GraphQL shapes follow Railway's public API; verify on
 * your first live run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';
const LLM_KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const ONLY = flag('--only');
const PROJECT_NAME = flag('--name');

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

// --- preflight -------------------------------------------------------------
const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN;
if (!RAILWAY_API_TOKEN) {
  die(
    'RAILWAY_API_TOKEN is required.\n' +
      '  Create an ACCOUNT token (not a project token) at https://railway.com/account/tokens\n' +
      '  then add it to .env.local:  RAILWAY_API_TOKEN=...',
  );
}
const llmKeys = LLM_KEY_VARS.filter((k) => process.env[k]);
if (llmKeys.length === 0 && !DRY) {
  die('No LLM API key found (one of ' + LLM_KEY_VARS.join(', ') + '). Add it to .env.local.');
}

// --- railway CLI invocation (prefer a global `railway`, else pnpm dlx) ------
function resolveRailway() {
  try {
    execFileSync('railway', ['--version'], { stdio: 'ignore' });
    return ['railway'];
  } catch {
    return ['pnpm', 'dlx', '@railway/cli@4'];
  }
}
const RAILWAY = DRY ? ['railway'] : resolveRailway();

const maskArg = (a) => {
  const m = /^([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET)[A-Za-z0-9_]*)=.+$/.exec(a);
  return m ? `${m[1]}=***` : a;
};

function railway(args, { capture = false } = {}) {
  const [bin, ...prefix] = RAILWAY;
  const full = [...prefix, ...args];
  if (DRY) {
    console.log(`    $ ${bin} ${full.map(maskArg).join(' ')}`);
    return '';
  }
  return execFileSync(bin, full, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: process.env,
  });
}

async function graphql(query, variables) {
  if (DRY) {
    console.log(`    ⇒ GraphQL serviceInstanceUpdate ${JSON.stringify({ ...variables, input: variables.input })}`);
    return { dryRun: true };
  }
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RAILWAY_API_TOKEN}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data;
}

// --- service discovery (works for todo, table-order, or any domain MCP) ----
function discoverServices() {
  const out = [];
  let mcpPort = 6782;
  if (existsSync(join(ROOT, 'servers/ggui'))) {
    out.push({ name: 'ggui', path: 'servers/ggui', role: 'ggui', public: true, port: 6781 });
  }
  const mcpsDir = join(ROOT, 'servers/mcps');
  if (existsSync(mcpsDir)) {
    for (const d of readdirSync(mcpsDir).sort()) {
      if (statSync(join(mcpsDir, d)).isDirectory()) {
        out.push({ name: d, path: `servers/mcps/${d}`, role: 'mcp', public: false, port: mcpPort++ });
      }
    }
  }
  if (existsSync(join(ROOT, 'servers/agent'))) {
    out.push({ name: 'agent', path: 'servers/agent', role: 'agent', public: true, port: Number(process.env.PORT) || 6790 });
  }
  if (existsSync(join(ROOT, 'apps/web'))) {
    out.push({ name: 'web', path: 'apps/web', role: 'web', public: true, port: 6890 });
  }
  return out;
}

const buildCommand = (p) => `pnpm install --frozen-lockfile && pnpm --filter ./${p} build`;
const startCommand = (p) => `pnpm --filter ./${p} start`;
const privateRef = (s) => `\${{${s.name}.RAILWAY_PRIVATE_DOMAIN}}`;
const publicRef = (s) => `\${{${s.name}.RAILWAY_PUBLIC_DOMAIN}}`;
const mcpEnvName = (s) => `GGUI_${s.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MCP_URL`;

function serviceVars(svc, services) {
  const vars = { PORT: String(svc.port) };
  if (svc.role === 'agent' || svc.role === 'ggui') {
    for (const k of llmKeys) vars[k] = process.env[k];
  }
  if (svc.role === 'ggui') {
    // ggui must know its OWN public URL: the iframe-runtime bundle + live
    // WebSocket it bakes into the rendered HTML are fetched DIRECTLY by the
    // browser, so they must resolve to ggui's public domain, not localhost.
    vars.GGUI_PUBLIC_BASE_URL = `https://${publicRef(svc)}`;
  }
  if (svc.role === 'agent') {
    if (process.env.MODEL) vars.MODEL = process.env.MODEL;
    const ggui = services.find((s) => s.role === 'ggui');
    if (ggui) vars.GGUI_MCP_URL = `http://${privateRef(ggui)}:${ggui.port}/mcp`;
    for (const mcp of services.filter((s) => s.role === 'mcp')) {
      vars[mcpEnvName(mcp)] = `http://${privateRef(mcp)}:${mcp.port}/mcp`;
    }
  }
  if (svc.role === 'web') {
    const agent = services.find((s) => s.role === 'agent');
    if (agent) vars.VITE_AGENT_ENDPOINT_URL = `https://${publicRef(agent)}`;
  }
  return vars;
}

// --- GraphQL: set build + start command (the CLI can't) --------------------
const SERVICE_INSTANCE_UPDATE = `mutation SetCommands($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
}`;

function deepFind(node, pred, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return undefined;
  seen.add(node);
  if (pred(node)) return node;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const hit = deepFind(v, pred, seen);
    if (hit) return hit;
  }
  return undefined;
}

function resolveIds(svc) {
  if (DRY) return { serviceId: `<${svc.name}.serviceId>`, environmentId: '<environmentId>' };
  const status = JSON.parse(railway(['status', '--json'], { capture: true }));
  const serviceNode = deepFind(status, (n) => n.name === svc.name && typeof n.id === 'string');
  const envNode =
    deepFind(status, (n) => typeof n.environmentId === 'string') ||
    deepFind(status, (n) => n.name && n.id && /environment/i.test(JSON.stringify(Object.keys(n))));
  const serviceId = serviceNode?.id;
  const environmentId = status.environmentId ?? envNode?.environmentId ?? envNode?.id;
  if (!serviceId || !environmentId) throw new Error('could not resolve serviceId/environmentId from `railway status --json`');
  return { serviceId, environmentId };
}

async function setBuildStart(svc, manualSteps) {
  const build = buildCommand(svc.path);
  const start = startCommand(svc.path);
  try {
    const { serviceId, environmentId } = resolveIds(svc);
    await graphql(SERVICE_INSTANCE_UPDATE, {
      serviceId,
      environmentId,
      input: { buildCommand: build, startCommand: start },
    });
    console.log('    ✓ build/start command set via API');
  } catch (err) {
    console.log(`    ⚠ couldn't set build/start automatically (${String(err).split('\n')[0]})`);
    manualSteps.push(
      `${svc.name}: Railway dashboard → service Settings → set\n` +
        `        Build Command: ${build}\n` +
        `        Start Command: ${start}`,
    );
  }
}

/** Create a Railway domain for a service on a specific port; return the domain (or null). */
function mintDomain(service, port, manualSteps) {
  if (DRY) {
    railway(['domain', '--service', service, '--port', String(port)]);
    return `<${service}-${port}.up.railway.app>`;
  }
  try {
    const out = JSON.parse(railway(['domain', '--service', service, '--port', String(port), '--json'], { capture: true }));
    const found = deepFind(out, (n) => typeof n.domain === 'string');
    const domain = found?.domain ?? (typeof out.domain === 'string' ? out.domain : undefined);
    if (!domain) throw new Error('no domain field in `railway domain --json` output');
    return domain;
  } catch {
    manualSteps.push(
      `${service}: add a SECOND domain targeting port ${port} (the sandbox proxy) in the Railway dashboard, ` +
        `then set SANDBOX_PROXY_PUBLIC_URL=https://<that-domain> on the ${service} service`,
    );
    return null;
  }
}

// --- main ------------------------------------------------------------------
async function main() {
  const all = discoverServices();
  const services = ONLY ? all.filter((s) => s.name === ONLY) : all;
  if (services.length === 0) {
    die(ONLY ? `no service named "${ONLY}"` : 'no services found under servers/* or apps/*');
  }

  console.log(`\n🚂 Railway deploy${DRY ? '  (DRY RUN — nothing will change)' : ''}`);
  console.log(`   services: ${services.map((s) => s.name).join(', ')}\n`);

  if (!ONLY) {
    const name = PROJECT_NAME ?? basename(ROOT);
    console.log(`1. create + link project: ${name}`);
    railway(['init', '--name', name]);
  } else {
    console.log('• --only: assuming the project is already linked (run without --only first)');
  }

  const manualSteps = [];

  console.log('\n2. provision services');
  for (const svc of services) {
    console.log(`\n  ▸ ${svc.name}  (${svc.path})${svc.public ? '  [public]' : '  [private]'}`);
    railway(['add', '--service', svc.name]);
    await setBuildStart(svc, manualSteps);
    for (const [k, v] of Object.entries(serviceVars(svc, services))) {
      railway(['variable', 'set', `${k}=${v}`, '--service', svc.name, '--skip-deploys']);
    }
    if (svc.public) railway(['domain', '--service', svc.name, '--port', String(svc.port)]);
    if (svc.role === 'agent') {
      // The agent also runs the spec-mandated sandbox proxy on port+1000 — a
      // SECOND browser-facing origin. Give it its own Railway domain and pass
      // its public URL to the agent (read by @ggui-ai/agent-server).
      const sandboxDomain = mintDomain(svc.name, svc.port + 1000, manualSteps);
      if (sandboxDomain) {
        railway(['variable', 'set', `SANDBOX_PROXY_PUBLIC_URL=https://${sandboxDomain}`, '--service', svc.name, '--skip-deploys']);
      }
    }
  }

  console.log('\n3. deploy services');
  for (const svc of services) {
    console.log(`\n  ⤴ ${svc.name}`);
    railway(['up', '--service', svc.name, '--detach']);
  }

  console.log(`\n✓ ${DRY ? 'DRY RUN complete — no changes made.' : 'Deploy triggered for all services.'}`);
  if (!DRY) {
    console.log('  Builds run on Railway; check progress with `railway logs --service <name>`.');
    console.log('  Public URLs: `railway domain --service web` (and agent, ggui).');
  }
  if (manualSteps.length > 0) {
    console.log(`\n⚠ ${manualSteps.length} manual step(s) — the Railway CLI cannot set build/start commands:`);
    for (const m of manualSteps) console.log(`   • ${m}`);
  }
}

main().catch((err) => {
  console.error('\n✗ deploy-railway failed:', err);
  process.exit(1);
});
