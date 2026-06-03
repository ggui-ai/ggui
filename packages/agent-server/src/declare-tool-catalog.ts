/**
 * Cross-framework tool-identity declaration (library → ggui).
 *
 * When the operator opts into `crossFramework`, the agent-server derives
 * a `{ bareToolName -> canonical serverInfo }` catalog from the canonical
 * {@link buildAgentCatalog} result (which performed the real MCP
 * `initialize` to obtain each tool's `serverInfo`) and DECLARES it to ggui
 * via the `ggui_runtime_declare_tool_catalog` tool — on the SAME ggui URL +
 * bearer the agent uses, so ggui resolves the SAME `appId` and scopes the
 * write. ggui then canonicalizes a reused blueprint's
 * `agentCapabilities.tools[*].serverInfo` against this catalog at handshake
 * time, making blueprint reuse identity-stable across runtimes.
 *
 * This is a Tier-2 enhancement: a transport / RPC failure is caught and
 * logged, never thrown. The agent still functions without canonicalization
 * (reuse falls back to whatever the inbound contract named the server).
 */
import type { AgentToolEntry } from '@ggui-ai/protocol';
import { callMcpToolsCall } from './mcp-client.js';

/**
 * Canonical serverInfo identity declared per bare tool name — the value
 * shape of `ggui_runtime_declare_tool_catalog`'s `toolCatalog` map. The
 * ggui-side schema is `.strict()`, so `version` MUST be ABSENT (not
 * `undefined`) when the source entry has no version.
 */
export type DeclaredToolIdentity = { name: string; version?: string };

/**
 * Project the canonical {@link AgentToolEntry} catalog (keyed by bare tool
 * name) down to the `{ bareToolName -> {name, version?} }` map the ggui
 * declaration tool accepts.
 *
 * Entries with no `serverInfo` are OMITTED — there is no canonical identity
 * to declare for a tool whose server we never learned (e.g. a tool the LLM
 * authored without a `serverInfo`). `version` rides along only when present.
 */
export function toDeclarationCatalog(
  catalog: Record<string, AgentToolEntry>,
): Record<string, DeclaredToolIdentity> {
  const out: Record<string, DeclaredToolIdentity> = {};
  for (const [toolName, entry] of Object.entries(catalog)) {
    const serverInfo = entry.serverInfo;
    if (serverInfo === undefined) continue;
    const identity: DeclaredToolIdentity = { name: serverInfo.name };
    if (serverInfo.version !== undefined) identity.version = serverInfo.version;
    out[toolName] = identity;
  }
  return out;
}

/**
 * Signature of the MCP `tools/call` primitive this helper invokes —
 * matches {@link callMcpToolsCall}. Injectable so tests can assert the
 * declaration without a live ggui MCP.
 */
type ToolsCall = typeof callMcpToolsCall;

/**
 * Declare the canonical tool catalog to ggui via
 * `ggui_runtime_declare_tool_catalog`, on the agent's own ggui connection.
 *
 * Non-fatal: a transport failure (rejected `call`) OR a JSON-RPC error
 * envelope is caught + logged; this never throws. The declaration is a
 * best-effort enhancement, so a failure must not break the agent run.
 */
export async function declareToolCatalog(args: {
  readonly ggui: { readonly url: string; readonly bearer: string };
  readonly catalog: Record<string, AgentToolEntry>;
  readonly call?: ToolsCall;
  readonly log?: (line: string) => void;
}): Promise<void> {
  const call = args.call ?? callMcpToolsCall;
  const log = args.log ?? ((): void => {});
  const toolCatalog = toDeclarationCatalog(args.catalog);
  try {
    const rpc = await call({
      url: args.ggui.url,
      bearer: args.ggui.bearer,
      name: 'ggui_runtime_declare_tool_catalog',
      arguments: { toolCatalog },
    });
    if (rpc.error !== undefined) {
      log(
        `[agent-server] tool-catalog declaration rejected by ggui: ${rpc.error.message ?? 'no message'}`,
      );
      return;
    }
    log(
      `[agent-server] declared canonical tool catalog to ggui (${Object.keys(toolCatalog).length} tool(s))`,
    );
  } catch (err) {
    log(
      `[agent-server] tool-catalog declaration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
