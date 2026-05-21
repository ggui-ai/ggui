/**
 * Shared agent-entry resolution helpers.
 *
 * Consumed by both `ggui dev --agent <entry>` and `ggui serve`. Pure
 * functions over a path string + a working directory; no I/O, no
 * subprocess spawn (construction of the adapter does NOT spawn —
 * `@ggui-ai/agent-runtime/process` starts the process only when
 * `adapter.start()` is called).
 *
 * Command-neutral: error messages reference "agent entry" generically.
 * Callers wrap in command-specific prefixes (`ggui dev: …` /
 * `ggui serve: …`) when rendering.
 */
import { extname, isAbsolute, resolve } from 'node:path';
import {
  createNodeProcessAgentRuntime,
  type NodeProcessAgentRuntimeOptions,
} from '@ggui-ai/agent-runtime/process';
import type { AgentRuntimeAdapter } from '@ggui-ai/agent-runtime';

/** Narrow discriminated result of the entry-to-command mapper. */
export type AgentCommandResolution =
  | {
      ok: true;
      command: string;
      args: string[];
      entry: string;
      language: 'js' | 'ts';
    }
  | { ok: false; error: string };

/**
 * Map a user-supplied agent entry path to `{ command, args }` for
 * the subprocess adapter. The mapping is narrow on purpose:
 *
 *   - `.js` / `.mjs` / `.cjs` → `node <entry>`
 *   - `.ts` / `.tsx` / `.mts` → `node --import=tsx <entry>`
 *     (the user must have `tsx` resolvable — the adapter will
 *     surface the boot failure if not)
 *
 * Anything else is rejected with an actionable error. We deliberately
 * do NOT try to be clever with Deno / Bun / bundlers — the reference
 * adapter is exactly "run a Node process." Framework-specific
 * adapters (`@ggui-ai/agent-runtime/<adapter>`) own their own entry
 * policy.
 *
 * `entry` resolves against `cwd` when relative so the spawn receives
 * an absolute path regardless of where the command was invoked.
 */
export function resolveAgentCommand(
  entry: string,
  cwd: string,
): AgentCommandResolution {
  if (!entry || entry.length === 0) {
    return { ok: false, error: 'agent entry was empty' };
  }
  const absolute = isAbsolute(entry) ? entry : resolve(cwd, entry);
  const ext = extname(absolute).toLowerCase();

  const jsExts = new Set(['.js', '.mjs', '.cjs']);
  const tsExts = new Set(['.ts', '.tsx', '.mts']);

  if (jsExts.has(ext)) {
    return {
      ok: true,
      command: process.execPath,
      args: [absolute],
      entry: absolute,
      language: 'js',
    };
  }
  if (tsExts.has(ext)) {
    return {
      ok: true,
      command: process.execPath,
      args: ['--import=tsx', absolute],
      entry: absolute,
      language: 'ts',
    };
  }

  return {
    ok: false,
    error:
      `agent entry "${entry}" has an unsupported extension "${ext || '(none)'}". ` +
      `Supported: .js / .mjs / .cjs / .ts / .tsx / .mts. ` +
      `For other runtimes, the reference adapter is not the right tool — ` +
      `ship a framework-specific adapter under @ggui-ai/agent-runtime/<name>.`,
  };
}

/**
 * Construct a node-process adapter for a resolved entry. Separate
 * from {@link resolveAgentCommand} so tests can branch on the
 * mapping without constructing an actual adapter.
 */
export function buildAgentRuntime(
  resolution: Extract<AgentCommandResolution, { ok: true }>,
  extra: Partial<
    Omit<NodeProcessAgentRuntimeOptions, 'command' | 'args'>
  > = {},
): AgentRuntimeAdapter {
  return createNodeProcessAgentRuntime({
    name: 'node-process',
    command: resolution.command,
    args: resolution.args,
    ...extra,
  });
}
