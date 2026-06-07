/**
 * `ggui deploy` — idempotent orchestrator that provisions and wires a
 * ggui.ai cloud app for the current project.
 *
 * Sequencing (ggui-side only):
 *   1. login        — device-flow auth (if not already signed in)
 *   2. create-app   — POST /v1/apps, persist appId into ggui.json
 *   3. mint-key     — POST /v1/keys, write GGUI_MCP_BEARER into .env.local
 *   4. push         — export local blueprint pool + upload to the app
 *   5. wire-env     — write GGUI_MCP_URL into .env.local
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

export type DeployStepKind = 'login' | 'create-app' | 'mint-key' | 'push' | 'wire-env';

export interface DeployStep {
  readonly kind: DeployStepKind;
}

/**
 * Derive the ordered list of steps to execute given the current state.
 * Pure function — no I/O.
 */
export function planDeploySteps(s: DeployState): DeployStep[] {
  const steps: DeployStep[] = [];
  if (!s.authed) steps.push({ kind: 'login' });
  if (!s.appId) steps.push({ kind: 'create-app' });
  if (!s.hasKey) steps.push({ kind: 'mint-key' });
  steps.push({ kind: 'push' }, { kind: 'wire-env' });
  return steps;
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

  let hasKey = false;
  if (existsSync(envLocalPath)) {
    const raw = readFileSync(envLocalPath, 'utf-8');
    for (const rawLine of raw.split('\n')) {
      const l = rawLine.trim().startsWith('export ') ? rawLine.trim().slice(7) : rawLine.trim();
      const eq = l.indexOf('=');
      if (eq !== -1 && l.slice(0, eq).trim() === 'GGUI_MCP_BEARER') {
        const val = l.slice(eq + 1).replace(/^["']|["']$/g, '').trim();
        if (val.length > 0) { hasKey = true; break; }
      }
    }
  }

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
  5. wire-env     Write GGUI_MCP_URL into .env.local

Agent / MCP HOSTING (guuey.com) is handled separately.

Usage:
  ggui deploy
`;

/**
 * Orchestrate a full ggui-side deploy. Returns a process exit code.
 */
export async function runDeployCommand(_args: readonly string[]): Promise<number> {
  if (_args.includes('--help') || _args.includes('-h')) {
    process.stdout.write(DEPLOY_HELP);
    return 0;
  }

  const cwd = process.cwd();

  // Read current state.
  const ctx = readDeployContext(cwd);
  const { gguiJsonPath, envLocalPath } = ctx;
  let { state } = ctx;

  if (!gguiJsonPath) {
    process.stderr.write(
      'ggui deploy: no ggui.json found in this directory or its parents.\n' +
        '  Run from a scaffolded project directory (one created by `npx @ggui-ai/create-agentic-app`).\n',
    );
    return 1;
  }

  const steps = planDeploySteps(state);

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
        // Re-read auth state so subsequent steps that need the session work.
        state = { ...state, authed: true };
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
        // Persist appId into ggui.json.
        const read = readGguiJson(gguiJsonPath);
        if ('value' in read) {
          writeGguiJson(gguiJsonPath, { ...read.value, appId });
        }
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

      case 'wire-env': {
        process.stdout.write('\n[ggui deploy] Step: wire-env\n');
        if (!appId) {
          process.stderr.write('ggui deploy: wire-env: no appId resolved. This is a bug.\n');
          return 1;
        }
        // Prefer the connectUrl we got from create-app; fall back to
        // constructing the canonical cloud URL from appId.
        const mcpUrl = connectUrl
          ? `${connectUrl}/mcp`
          : `https://mcp.ggui.ai/apps/${appId}/mcp`;
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

  // Final resolved appId for the summary.
  const finalAppId = appId;
  const finalMcpUrl = connectUrl
    ? `${connectUrl}/mcp`
    : finalAppId
      ? `https://mcp.ggui.ai/apps/${finalAppId}/mcp`
      : '(unknown)';

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
