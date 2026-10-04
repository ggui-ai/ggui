// packages/ui-gen/src/adapters/claude/sdk-tool-pins.ts
//
// ggui#1714 — the tool surface of every Agent SDK `query()` this package runs.
//
// Left to its defaults, a `query()` session offers the model the CLI's whole
// built-in set (Bash, Edit, Read, Write, WebFetch, Task, …) and loads the host
// user's own Claude configuration (plugins, MCP servers from `~/.claude`).
// `allowedTools` does not narrow that: it only approves the names it lists.
// Measured on SDK 0.3.229 from the session's `system`/`init` message:
//
//   as before this file           → every built-in + the caller's tools
//   `tools: []` alone             → the caller's tools + a user-level plugin server
//   `tools: []` + `settingSources: []` → the caller's tools only
//
// So the pins are both, on every path. With them in place no permission
// bypass is needed: a tool named in `allowedTools` runs, and a server-level
// entry (`mcp__<server>`) approves every tool of that server (both measured
// on a live turn; with no entry the call is denied and the run reports it).

import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';

export type SdkToolPins = Required<Pick<Options, 'tools' | 'settingSources' | 'allowedTools'>>;

export interface SdkToolPinInput {
  /** The MCP servers the session gets, keyed by name. */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /** Tool names to approve. Absent → every tool of every server in `mcpServers`. */
  readonly allowedTools?: readonly string[];
  /**
   * The CLI built-ins to offer (e.g. `['Write']`) — an explicit opt-in.
   * Each one is also approved, so it runs without a prompt; a built-in that
   * writes or executes acts on the host with the session's permissions.
   */
  readonly builtinTools?: readonly string[];
}

export function sdkToolPins(input: SdkToolPinInput): SdkToolPins {
  const builtins = [...(input.builtinTools ?? [])];
  const approved =
    input.allowedTools !== undefined
      ? [...input.allowedTools]
      : Object.keys(input.mcpServers ?? {}).map((name) => `mcp__${name}`);
  return { tools: builtins, settingSources: [], allowedTools: [...approved, ...builtins] };
}
