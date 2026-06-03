/**
 * Dev/CI measurement of what each agent SDK authors for `serverInfo.name`,
 * per MCP tool, on a `ggui_handshake` draft. This is the empirical read on
 * Tier-2 reliability (Slice 1) — whether the config-key nudge stops weak
 * models from fabricating a server name.
 *
 * Two parts:
 *   - {@link classifyServerName} — pure: buckets an authored name against the
 *     server's real `initialize` name and the deployment's config key.
 *   - {@link emitAgentCaps} — env-gated stderr projection (mirrors the
 *     `GGUI_CACHE_TRACE_STDERR` convention in `cache-trace-sink.ts`). One
 *     greppable line per tool: `[ggui:agentcaps] tool=<key> serverInfo.name=<name|->`.
 *     Default OFF; pure side-effect; never alters the handshake decision.
 */
import type { DataContract } from '@ggui-ai/protocol';

/** How an authored `serverInfo.name` relates to ground truth. */
export type ServerNameClass = 'canonical' | 'config-key' | 'fabricated' | 'omitted';

/** Ground truth for one server in a measurement run. */
export interface ServerNameTruth {
  /** The server's real `initialize`-declared name (catalog ground truth). */
  readonly realName: string;
  /** The deployment's config key = the `mcp__<configKey>__` tool prefix. */
  readonly configKey: string;
}

/**
 * Bucket an authored `serverInfo.name` (or `undefined` when omitted) against
 * ground truth. `canonical` = matched the real initialize name (Tier-1 quality
 * without the library, i.e. the model guessed right); `config-key` = matched
 * the prefix handle (the nudge's intended Tier-2 output); `fabricated` =
 * neither (the failure the nudge targets); `omitted` = no name authored.
 */
export function classifyServerName(
  authored: string | undefined,
  truth: ServerNameTruth,
): ServerNameClass {
  if (authored === undefined) return 'omitted';
  if (authored === truth.realName) return 'canonical';
  if (authored === truth.configKey) return 'config-key';
  return 'fabricated';
}

/**
 * Which point in the handshake a measurement line captures.
 *   - `'authored'` (default) — the AUTHORED serverInfo, measured BEFORE
 *     canonicalization. This is the fabrication-detection read (does the
 *     model guess a server name, and what kind).
 *   - `'effective'` — the EFFECTIVE serverInfo, measured AFTER the Slice-2
 *     canonicalization step rewrote it to the catalog's canonical identity.
 *     Emitting this second line is how canonicalization becomes OBSERVABLE in
 *     the container: an `effective` line whose name is the canonical
 *     `initialize` value proves the canonicalization fired.
 */
export type AgentCapsPhase = 'authored' | 'effective';

/** Options for {@link emitAgentCaps}. `write` defaults to stderr; injectable for tests. */
export interface EmitAgentCapsOpts {
  /** Gate — caller passes `process.env.GGUI_AGENTCAPS_STDERR === '1'`. */
  readonly enabled: boolean;
  /**
   * Measurement phase — prefixes the greppable line so the authored read and
   * the post-canonicalization effective read are distinguishable downstream.
   * Defaults to `'authored'` (the pre-canonicalization fabrication read).
   */
  readonly phase?: AgentCapsPhase;
  /** Sink. Defaults to a `process.stderr.write` wrapper. */
  readonly write?: (line: string) => void;
}

/**
 * Emit one `[ggui:agentcaps]` line per declared agent tool when `enabled`.
 * Records the `serverInfo.name`/`version` verbatim (classification is done
 * downstream by the journey, which knows ground truth). When `phase` is
 * `'effective'` the line tag becomes `[ggui:agentcaps:effective]` so the
 * post-canonicalization read is distinguishable from the authored read; the
 * default `'authored'` keeps the bare `[ggui:agentcaps]` tag. No-op when
 * disabled or when the contract declares no agent tools.
 */
export function emitAgentCaps(contract: DataContract, opts: EmitAgentCapsOpts): void {
  if (!opts.enabled) return;
  const tools = contract.agentCapabilities?.tools;
  if (!tools) return;
  const write = opts.write ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const tag = opts.phase === 'effective' ? '[ggui:agentcaps:effective]' : '[ggui:agentcaps]';
  for (const [toolName, entry] of Object.entries(tools)) {
    const name = entry.serverInfo?.name ?? '-';
    const version = entry.serverInfo?.version ?? '-';
    write(`${tag} tool=${toolName} serverInfo.name=${name} serverInfo.version=${version}`);
  }
}
