/**
 * `ggui create app` — create a new app in the ggui.ai cloud and write
 * the returned appId back into the local ggui.json (if one is found).
 *
 * Calls `POST /v1/apps` with an optional display name and prints the
 * created app's id, connect URL, and default flag. When a ggui.json is
 * found in the working-directory ancestor chain, the command updates
 * (or adds) the `appId` field so subsequent `ggui deploy` invocations
 * can pick it up automatically.
 */
import { createApp } from './api-client.js';
import {
  findGguiJson,
  readGguiJson,
  writeGguiJson,
} from './internal/ggui-json.js';

export interface CreateAppFlags {
  name?: string;
  error?: string;
}

/**
 * Parse the args that follow `ggui create`. The first element must be
 * the literal string `'app'`; anything else is an error. Remaining
 * elements are flag pairs (`--name <value>`).
 */
export function parseCreateAppFlags(args: readonly string[]): CreateAppFlags {
  if (args[0] !== 'app') {
    return {
      error: `unknown create target: ${args[0] ?? '(none)'} (expected 'app')`,
    };
  }
  const rest = args.slice(1);
  const flags: CreateAppFlags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--name') {
      flags.name = rest[++i];
    }
  }
  return flags;
}

/**
 * Run `ggui create app [--name <displayName>]`.
 *
 * Returns 0 on success, 1 on API / I/O error, 2 on usage error.
 */
export async function runCreateCommand(
  args: readonly string[],
): Promise<number> {
  const flags = parseCreateAppFlags(args);
  if (flags.error) {
    process.stderr.write(`ggui create: ${flags.error}\n`);
    return 2;
  }

  const app = await createApp({ displayName: flags.name });

  // Persist the returned appId into the local ggui.json when one exists.
  const path = findGguiJson(process.cwd());
  if (path) {
    const read = readGguiJson(path);
    if ('value' in read) {
      writeGguiJson(path, { ...read.value, appId: app.appId });
    }
  }

  process.stdout.write(`App created.\n`);
  process.stdout.write(`  appId:      ${app.appId}\n`);
  process.stdout.write(`  connectUrl: ${app.connectUrl}\n`);
  process.stdout.write(`  default:    ${app.isDefault}\n`);
  return 0;
}
