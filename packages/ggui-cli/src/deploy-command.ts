/**
 * `ggui deploy` — idempotent orchestrator that provisions and wires a
 * ggui.ai cloud app for the current project.
 *
 * Sequencing (ggui-side only):
 *   1. login        — device-flow auth (if not already signed in)
 *   2. create-app   — POST /v1/apps, persist appId into ggui.json
 *   3. mint-key     — POST /v1/keys, write GGUI_MCP_BEARER into .env.local
 *   4. push         — export local blueprint pool + upload to the app
 *   5. push-config  — PATCH /v1/apps/{appId}: gadgets + publicEnv from ggui.json
 *   6. wire-env     — write GGUI_MCP_URL into .env.local
 *
 * Each step is skipped when its gate is already satisfied, making the
 * command idempotent — run it again after a partial failure and it
 * resumes from the first unsatisfied step.
 *
 * Agent / MCP HOSTING (guuey.com) is out of scope for `ggui deploy`.
 * This command wires only the ggui UI layer.
 */
/* eslint-disable no-console */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tryLoadAuthSession } from './auth-store.js';
import { runLoginCommand } from './auth-login.js';
import { createApp, createKey } from './api-client.js';
import { findGguiJson, readGguiJson, writeGguiJson } from './internal/ggui-json.js';
import { runPushCommand } from './push-command.js';
import { runConfigPushStep } from './config-push.js';
import { runProviderKeyCommand } from './provider-key-command.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pure planner — no I/O, fully unit-testable
// ─────────────────────────────────────────────────────────────────────────────

/** Current deployment state, read from disk at the start of the command. */
export interface DeployState {
  /** True if a valid auth session exists in ~/.ggui/auth.json. */
  readonly authed: boolean;
  /** appId from ggui.json, if already set. */
  readonly appId?: string;
  /** True if GGUI_MCP_BEARER is already present in .env.local. */
  readonly hasKey: boolean;
}

export type DeployStepKind = 'login' | 'create-app' | 'mint-key' | 'push' | 'push-config' | 'push-keys' | 'wire-env';

export interface DeployStep {
  readonly kind: DeployStepKind;
}

/** Input to the planner — pure data, no I/O. */
export interface DeployInput {
  readonly state: DeployState;
  /** When true, insert a `push-keys` step after `push-config` and before `wire-env`. */
  readonly pushKeys?: boolean;
}

/**
 * Derive the ordered list of steps to execute given the current state.
 * Pure function — no I/O.
 *
 * Step order:
 *   login? → create-app? → mint-key? → push → push-config → push-keys? → wire-env
 */
export function planDeploySteps(input: DeployInput): DeployStep[] {
  const { state: s, pushKeys } = input;
  const steps: DeployStep[] = [];
  if (!s.authed) steps.push({ kind: 'login' });
  if (!s.appId) steps.push({ kind: 'create-app' });
  if (!s.hasKey) steps.push({ kind: 'mint-key' });
  steps.push({ kind: 'push' }, { kind: 'push-config' });
  if (pushKeys) steps.push({ kind: 'push-keys' });
  steps.push({ kind: 'wire-env' });
  return steps;
}

/**
 * Resolve the `GGUI_MCP_URL` value `ggui deploy` wires into `.env.local`.
 *
 * The per-app cloud pod serves the MCP transport at the BARE per-app endpoint
 * `<base>/apps/<appId>` (the `connectUrl` the backend advertises) — NOT a
 * `/mcp` sub-path. The `/mcp` suffix is the LOCAL `ggui serve` convention;
 * appending it here produced a URL the per-app pod 404s, so the agent (which
 * reads GGUI_MCP_URL verbatim) could never connect to a deployed app.
 *
 *   - `connectUrl` present (a create-app ran this session) → use it VERBATIM —
 *     the deployment-correct base (prod `mcp.ggui.ai`, sandbox
 *     `<env>.mcp.sandbox.ggui.ai`, derived from whichever backend `GGUI_API_URL`
 *     pointed at).
 *   - absent → the PRODUCTION default `https://mcp.ggui.ai/apps/<appId>`.
 *
 * The caller leaves any pre-existing `GGUI_MCP_URL` untouched (env override).
 */
export function resolveDeployMcpUrl(connectUrl: string | undefined, appId: string): string {
  return connectUrl ?? `https://mcp.ggui.ai/apps/${appId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// .env.local upsert helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read-modify-write `.env.local` at `envLocalPath`, upserting `key=value`.
 *
 * - If the file doesn't exist, creates it with only this line.
 * - If the key already exists, replaces its value in-place.
 * - Other keys/comments are preserved unchanged.
 * - No trailing newline is added beyond the final `\n`.
 */
export function upsertEnvLocal(envLocalPath: string, key: string, value: string): void {
  const line = `${key}=${value}`;
  if (!existsSync(envLocalPath)) {
    writeFileSync(envLocalPath, `${line}\n`, 'utf-8');
    return;
  }
  const raw = readFileSync(envLocalPath, 'utf-8');
  const lines = raw.split('\n');
  let found = false;
  const updated = lines.map((l) => {
    // Match `KEY=...` or `export KEY=...` (no leading spaces per convention).
    const trimmed = l.startsWith('export ') ? l.slice(7) : l;
    const eq = trimmed.indexOf('=');
    if (eq !== -1 && trimmed.slice(0, eq).trim() === key) {
      found = true;
      return line;
    }
    return l;
  });
  if (!found) {
    // Append: ensure one blank line before the new entry if the file is
    // non-empty and doesn't already end with a blank line.
    const last = updated[updated.length - 1];
    if (last !== undefined && last.trim() !== '') {
      updated.push('');
    }
    updated.push(line);
  }
  // Rejoin preserving the original trailing-newline behaviour.
  const result = updated.join('\n');
  writeFileSync(envLocalPath, result.endsWith('\n') ? result : `${result}\n`, 'utf-8');
}

/**
 * Read the non-empty value of `key` from `.env.local`, or `undefined` if
 * the file doesn't exist, the key is absent, or its value is empty.
 * Strips surrounding quotes + `export ` prefix the same way `upsertEnvLocal`
 * recognises them.
 */
export function readEnvLocalValue(
  envLocalPath: string,
  key: string,
): string | undefined {
  if (!existsSync(envLocalPath)) return undefined;
  const raw = readFileSync(envLocalPath, 'utf-8');
  for (const rawLine of raw.split('\n')) {
    const l = rawLine.trim().startsWith('export ')
      ? rawLine.trim().slice(7)
      : rawLine.trim();
    const eq = l.indexOf('=');
    if (eq !== -1 && l.slice(0, eq).trim() === key) {
      const val = l
        .slice(eq + 1)
        .replace(/^["']|["']$/g, '')
        .trim();
      if (val.length > 0) return val;
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// State reader
// ─────────────────────────────────────────────────────────────────────────────

interface ResolvedProjectContext {
  readonly gguiJsonPath: string | null;
  readonly envLocalPath: string;
  readonly state: DeployState;
}

/**
 * Read the current deploy state from disk:
 *   - authed  : ~/.ggui/auth.json is present + valid
 *   - appId   : ggui.json#appId if found
 *   - hasKey  : GGUI_MCP_BEARER present in .env.local (not empty)
 */
function readDeployContext(cwd: string): ResolvedProjectContext {
  const gguiJsonPath = findGguiJson(cwd);
  // .env.local lives next to ggui.json when one is found, else at cwd.
  const projectRoot = gguiJsonPath ? dirname(gguiJsonPath) : cwd;
  const envLocalPath = join(projectRoot, '.env.local');

  const authed = tryLoadAuthSession() !== null;

  let appId: string | undefined;
  if (gguiJsonPath) {
    const result = readGguiJson(gguiJsonPath);
    if ('value' in result) {
      const v = result.value['appId'];
      if (typeof v === 'string' && v.length > 0) appId = v;
    }
  }

  const hasKey = readEnvLocalValue(envLocalPath, 'GGUI_MCP_BEARER') !== undefined;

  return {
    gguiJsonPath,
    envLocalPath,
    state: { authed, appId, hasKey },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export const DEPLOY_HELP = `ggui deploy — provision + wire a ggui.ai cloud app for this project

Idempotent: run it again after a partial failure to resume.

Steps (ggui-side only):
  1. login        Sign in (skipped if already authed)
  2. create-app   Create a cloud app + write appId into ggui.json
  3. mint-key     Create a connector key + write GGUI_MCP_BEARER into .env.local
  4. push         Export + upload blueprints to the app
  5. push-config  Push declared gadgets + publicEnv to the app
  6. push-keys    Push provider API key from env to the app (only with --push-keys)
  7. wire-env     Write GGUI_MCP_URL into .env.local

Agent / MCP HOSTING (guuey.com) is handled separately.

Usage:
  ggui deploy [--push-keys]

Options:
  --push-keys  Read the provider API key from the appropriate env var
               (e.g. ANTHROPIC_API_KEY) and push it to the cloud app so
               keySource=own renders work. Derives the provider from
               ggui.json#generation.model (or pass --provider to
               \`ggui provider-key set\` directly).
`;

/**
 * Orchestrate a full ggui-side deploy. Returns a process exit code.
 */
export async function runDeployCommand(_args: readonly string[]): Promise<number> {
  if (_args.includes('--help') || _args.includes('-h')) {
    process.stdout.write(DEPLOY_HELP);
    return 0;
  }

  const pushKeys = _args.includes('--push-keys');

  const cwd = process.cwd();

  // Read current state.
  const ctx = readDeployContext(cwd);
  const { gguiJsonPath, envLocalPath, state } = ctx;

  if (!gguiJsonPath) {
    process.stderr.write(
      'ggui deploy: no ggui.json found in this directory or its parents.\n' +
        '  Run from a scaffolded project directory (one created by `npx @ggui-ai/create-agentic-app`).\n',
    );
    return 1;
  }

  const steps = planDeploySteps({ state, pushKeys });

  // Mutable state for values discovered mid-run that subsequent steps need.
  let appId = state.appId;
  let connectUrl: string | undefined;

  for (const step of steps) {
    switch (step.kind) {
      case 'login': {
        process.stdout.write('\n[ggui deploy] Step: login\n');
        const code = await runLoginCommand([]);
        if (code !== 0) {
          process.stderr.write('ggui deploy: login failed. Aborting.\n');
          return code;
        }
        // runLoginCommand persisted the session to ~/.ggui/auth.json;
        // createApp / createKey load it internally, so nothing to thread
        // forward here.
        break;
      }

      case 'create-app': {
        process.stdout.write('\n[ggui deploy] Step: create-app\n');
        let app: Awaited<ReturnType<typeof createApp>>;
        try {
          app = await createApp({});
        } catch (err) {
          process.stderr.write(
            `ggui deploy: create-app failed — ${err instanceof Error ? err.message : String(err)}\n`,
          );
          return 1;
        }
        appId = app.appId;
        connectUrl = app.connectUrl;
        // Persist appId into ggui.json. The app already exists server-side
        // now, so a persist failure is LOUD: without the appId on disk a
        // re-run would call create-app again and create a DUPLICATE app.
        const read = readGguiJson(gguiJsonPath);
        if ('error' in read) {
          process.stderr.write(
            `ggui deploy: create-app: app ${app.appId} was created, but ggui.json ` +
              `could not be read to persist appId — ${read.error}\n` +
              `  Add "appId": "${app.appId}" to ggui.json manually before re-running, ` +
              `or a re-run will create a DUPLICATE app.\n`,
          );
          return 1;
        }
        writeGguiJson(gguiJsonPath, { ...read.value, appId });
        process.stdout.write(`  appId:      ${app.appId}\n`);
        process.stdout.write(`  connectUrl: ${app.connectUrl}\n`);
        break;
      }

      case 'mint-key': {
        process.stdout.write('\n[ggui deploy] Step: mint-key\n');
        let key: Awaited<ReturnType<typeof createKey>>;
        try {
          key = await createKey({ name: 'ggui deploy' });
        } catch (err) {
          process.stderr.write(
            `ggui deploy: mint-key failed — ${err instanceof Error ? err.message : String(err)}\n`,
          );
          return 1;
        }
        // Write the one-time-reveal secret into .env.local.
        upsertEnvLocal(envLocalPath, 'GGUI_MCP_BEARER', key.apiKey);
        process.stdout.write(`  Key created (prefix: ${key.prefix}). Written to .env.local.\n`);
        break;
      }

      case 'push': {
        process.stdout.write('\n[ggui deploy] Step: push\n');
        if (!appId) {
          process.stderr.write('ggui deploy: push: no appId resolved. This is a bug.\n');
          return 1;
        }
        const code = await runPushCommand(['--app', appId]);
        if (code !== 0) {
          process.stderr.write('ggui deploy: push failed. Aborting.\n');
          return code;
        }
        break;
      }

      case 'push-config': {
        process.stdout.write('\n[ggui deploy] Step: push-config\n');
        if (!appId) {
          process.stderr.write('ggui deploy: push-config: no appId resolved. This is a bug.\n');
          return 1;
        }
        const code = await runConfigPushStep(appId);
        if (code !== 0) {
          process.stderr.write('ggui deploy: push-config failed. Aborting.\n');
          return code;
        }
        break;
      }

      case 'push-keys': {
        process.stdout.write('\n[ggui deploy] Step: push-keys\n');
        if (!appId) {
          process.stderr.write('ggui deploy: push-keys: no appId resolved. This is a bug.\n');
          return 1;
        }
        const code = await runProviderKeyCommand(['set', '--app', appId]);
        if (code !== 0) {
          process.stderr.write('ggui deploy: push-keys failed. Aborting.\n');
          return code;
        }
        break;
      }

      case 'wire-env': {
        process.stdout.write('\n[ggui deploy] Step: wire-env\n');
        if (!appId) {
          process.stderr.write('ggui deploy: wire-env: no appId resolved. This is a bug.\n');
          return 1;
        }
        // NEVER clobber an existing GGUI_MCP_URL. The FIRST deploy writes
        // the deployment-correct base derived from create-app's connectUrl
        // (e.g. sandbox `<env>.mcp.sandbox.ggui.ai`, prod `mcp.ggui.ai`).
        // On REDEPLOY we have only the appId — reconstructing a hardcoded
        // prod URL here would silently break a sandbox/non-prod deployment.
        // So: leave any existing value alone; only write when absent.
        const existing = readEnvLocalValue(envLocalPath, 'GGUI_MCP_URL');
        if (existing) {
          process.stdout.write(
            `  GGUI_MCP_URL already set (${existing}) — leaving it unchanged.\n`,
          );
          break;
        }
        // No prior value → resolve the deployment-correct BARE per-app URL
        // (see resolveDeployMcpUrl: the per-app pod serves MCP at the bare
        // endpoint, never `/mcp`). The fallback to the production default only
        // fires when create-app didn't run this session — a first deploy always
        // has connectUrl, so it never reaches the fallback in practice.
        const mcpUrl = resolveDeployMcpUrl(connectUrl, appId);
        upsertEnvLocal(envLocalPath, 'GGUI_MCP_URL', mcpUrl);
        process.stdout.write(`  GGUI_MCP_URL=${mcpUrl}\n`);
        break;
      }

      default: {
        // Exhaustiveness check — DeployStepKind is a union; this branch
        // is unreachable in correct code.
        const _exhaustive: never = step.kind;
        process.stderr.write(`ggui deploy: unknown step "${_exhaustive as string}"\n`);
        return 1;
      }
    }
  }

  // keySource=own WARN — if the project declared keySource='own' but the
  // user didn't pass --push-keys this deploy, remind them that cloud renders
  // will reject until a key is set.
  if (!pushKeys && appId) {
    const gguiReadResult = readGguiJson(gguiJsonPath);
    if ('value' in gguiReadResult) {
      const { z } = await import('zod');
      const schema = z.object({
        generation: z.object({ keySource: z.string().optional() }).optional(),
      });
      const parsed = schema.safeParse(gguiReadResult.value);
      if (parsed.success && parsed.data.generation?.keySource === 'own') {
        process.stderr.write(
          `\n  WARN: keySource=own but no provider key pushed — run\n` +
            `    ggui deploy --push-keys\n` +
            `  or\n` +
            `    ggui provider-key set --app ${appId}\n` +
            `  else cloud renders will reject.\n`,
        );
      }
    }
  }

  // Report the URL actually in .env.local — after wire-env that file is
  // authoritative (a preserved sandbox/non-prod value is reflected
  // accurately rather than re-derived as the prod default).
  const finalMcpUrl = readEnvLocalValue(envLocalPath, 'GGUI_MCP_URL') ?? '(unknown)';

  process.stdout.write('\n');
  process.stdout.write('  ggui deploy complete.\n');
  process.stdout.write(`\n`);
  process.stdout.write(`  App MCP endpoint:  ${finalMcpUrl}\n`);
  process.stdout.write(`  Bearer key:        in .env.local (GGUI_MCP_BEARER)\n`);
  process.stdout.write('\n');
  process.stdout.write(
    '  The agent will use the cloud ggui endpoint on next `pnpm dev`.\n' +
      '  Local ggui service is skipped automatically when GGUI_MCP_URL is remote.\n' +
      '\n' +
      '  Agent / MCP hosting (guuey.com) is handled separately.\n',
  );
  return 0;
}
