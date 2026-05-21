/**
 * `resolveStreamChannel` — the single source of truth for applying
 * per-channel defaults to a {@link StreamSpec} entry.
 *
 * Four runtime roles reason about stream channels today (hosted
 * Lambda fan-out, OSS `/ws` fan-out, `@ggui-ai/react` data receipt,
 * `@ggui-ai/react-native` data receipt). Each of them needs the same
 * question answered: "what are the effective semantics of channel X
 * on this spec?" Without a shared helper, each role applies the
 * `DEFAULT_STREAM_*` constants inline and those defaults drift.
 *
 * This helper is a THIN lookup + default-application pass. It is
 * explicitly NOT:
 *
 *   - a payload validator (that remains `validateStreamData` — the
 *     shape check is orthogonal to the semantics lookup).
 *   - a permission/authorization gate (channels are declared, not
 *     granted).
 *   - a replay-buffer read (no server-side buffer infrastructure
 *     exists yet; `replay` comes back as a DECLARATION, not a
 *     guarantee — see streamSpec design-lock for the honest stop).
 *
 * Returns `undefined` for two distinct cases, both of which are
 * "nothing to enforce" at call sites:
 *
 *   - `spec === undefined` — the stack item has no stream contract.
 *   - `spec.channels[channelName]` is missing — the channel isn't
 *     declared. Callers MUST NOT assume this means "permissive";
 *     rejection is the downstream responsibility of
 *     `validateStreamData` (which reports the undeclared-channel
 *     violation), not this helper.
 */
import {
  DEFAULT_STREAM_CHANNEL_COMPLETE,
  DEFAULT_STREAM_CHANNEL_MODE,
  DEFAULT_STREAM_REPLAY_POLICY,
  type JsonSchema,
  type JsonValue,
  type StreamChannelMode,
  type StreamReplayPolicy,
  type StreamSpec,
} from '../types/data-contract.js';

/**
 * A channel's fully-resolved runtime semantics. Every optional field
 * on the raw {@link import('../types/data-contract.js').StreamChannelEntry}
 * has been defaulted per the locked `DEFAULT_STREAM_*` constants, so
 * consumers that honor channel semantics never need to re-check for
 * `undefined` on `mode` / `replay` / `complete`.
 */
export interface ResolvedStreamChannel {
  /** Channel name (the lookup key used against `spec.channels`). */
  readonly name: string;
  /** Payload schema — the authoritative contract for deliveries. */
  readonly schema: JsonSchema;
  /** State-folding mode (defaulted). */
  readonly mode: StreamChannelMode;
  /** Replay policy (defaulted; advisory until replay infra ships). */
  readonly replay: StreamReplayPolicy;
  /** Whether this channel has a terminal completion marker (defaulted). */
  readonly complete: boolean;
  /** Optional passthrough — channel's human-readable description. */
  readonly description?: string;
  /** Optional passthrough — channel's example payload. */
  readonly example?: JsonValue;
  /** Optional passthrough — refresh tool declared for this channel.
   * Server-side action dispatch (WS-direct agent-less deployments)
   * fires this after a wired action succeeds; absence means "no
   * refresh fires." Distinct from the `source` poll/push feed on
   * `StreamChannelEntry`. See `StreamChannelEntry.tool`. */
  readonly tool?: string;
}

/**
 * Look up a channel's declared semantics in a {@link StreamSpec} and
 * return the fully-resolved view. Optional fields on the raw entry
 * (`mode` / `replay` / `complete`) are filled with their locked
 * defaults.
 *
 * @param spec        The active stack item's stream contract, or undefined
 *                    when the item has no `streamSpec` at all.
 * @param channelName The channel name to resolve — typically read
 *                    from the outbound envelope's `channel` field.
 * @returns `ResolvedStreamChannel` when the channel is declared;
 *          `undefined` otherwise (either the spec is absent or the
 *          channel isn't in `spec.channels`).
 */
export function resolveStreamChannel(
  spec: StreamSpec | undefined,
  channelName: string,
): ResolvedStreamChannel | undefined {
  if (!spec) return undefined;
  const entry = spec[channelName];
  if (!entry) return undefined;
  return {
    name: channelName,
    schema: entry.schema,
    mode: entry.mode ?? DEFAULT_STREAM_CHANNEL_MODE,
    replay: entry.replay ?? DEFAULT_STREAM_REPLAY_POLICY,
    complete: entry.complete ?? DEFAULT_STREAM_CHANNEL_COMPLETE,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.example !== undefined ? { example: entry.example } : {}),
    ...(entry.tool !== undefined ? { tool: entry.tool } : {}),
  };
}
