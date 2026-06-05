/**
 * `handleStream` — shared `ggui_emit` emission flow.
 *
 * Single source of truth for the validation + derivation a server-side
 * `ggui_emit` handler performs. Hosted + OSS mutation paths call this
 * helper with their own `sendEnvelope` adapter — the helper enforces the
 * design-locked rules, then delegates the actual transport/buffer side
 * effect.
 *
 * Rules enforced, in order (short-circuit on first failure):
 *
 *   1. Resolve target render — caller has already loaded it; helper
 *      verifies the render has a `streamSpec` AND
 *      `streamSpec[input.channel]` MUST exist.
 *      Missing either → throw {@link ChannelNotDeclaredError}.
 *
 *   2. Validate `input.payload` against
 *      `streamSpec[channel].schema` via
 *      {@link assertStreamContract}.
 *      Failure → `ContractViolationError{tool:'ggui_emit'}`.
 *
 *   3. If `input.complete === true`, the channel MUST have been declared
 *      with `complete: true`.
 *      Otherwise → throw {@link InvalidCompleteError}.
 *
 * After validation:
 *
 *   4. Derive `mode` from `streamSpec[channel].mode` (default
 *      `'append'`). Agent-supplied `mode` is NOT supported.
 *
 *   5. Build a {@link HandleStreamEnvelope} `{renderId, channel, mode,
 *      payload, complete?}` and hand it to the caller-supplied
 *      `sendEnvelope`.
 *
 *   6. `sendEnvelope` returns `{seq?}` — seq-aware implementations (OSS
 *      `GguiSessionStreamBuffer`) stamp and return the assigned sequence;
 *      implementations without a buffer (hosted today) return `{}`.
 *      `handleStream` propagates seq back through its result so the tool
 *      handler can surface it to the agent.
 *
 *   7. No-subscriber is NOT an error at this layer. Acceptance is at the
 *      server boundary; fan-out is a separate concern owned by
 *      `sendEnvelope`.
 *
 * What this helper is NOT:
 *   - NOT a transport adapter — it calls `sendEnvelope`, doesn't speak WS.
 *   - NOT a render store — callers pass the resolved render in.
 *   - NOT a post-complete state machine — the design lock defers strict
 *     per-channel quiescence enforcement. Producers SHOULD NOT emit
 *     after `complete: true`; this helper doesn't reject if they do.
 *
 * Seam-free, pure + injectable. Lives in renders alongside
 * `assertStreamContract` (payload validator) and `resolveStreamChannel`
 * (semantics lookup) — both of which this helper composes on.
 *
 * Post-Phase-B (flatten-render-identity): collapsed from the prior
 * `{sessionId, stack[], currentStackIndex}` target shape into a single
 * `GguiSessionStreamTarget` — every render IS the addressable scope.
 */
import type { GguiEmitInput, GguiEmitOutput, JsonValue, StreamSpec } from "@ggui-ai/protocol";
import {
  DEFAULT_STREAM_CHANNEL_MODE,
  resolveStreamChannel,
  type StreamChannelMode,
} from "@ggui-ai/protocol";
import { assertStreamContract } from "./assert-stream-contract.js";
import { ChannelNotDeclaredError, InvalidCompleteError } from "./errors.js";

/**
 * Minimum shape the helper needs from a resolved render. Callers
 * project their hosted DDB row or OSS in-memory render onto this — both
 * satisfy the shape naturally, so neither needs a cast.
 */
export interface GguiSessionStreamTarget {
  readonly renderId: string;
  readonly streamSpec?: StreamSpec;
}

/**
 * The envelope-input shape the helper hands to `sendEnvelope`. Structural
 * peer of `StreamEnvelopeInput` from `@ggui-ai/mcp-server-core` —
 * duplicated here to keep renders free of a mcp-server-core
 * dependency (renders sits below core in the layering).
 *
 * Consumers that accept `StreamEnvelopeInput` can assign this directly.
 */
export interface HandleStreamEnvelope {
  readonly renderId: string;
  readonly channel: string;
  readonly mode: StreamChannelMode;
  readonly payload: JsonValue;
  readonly complete?: boolean;
}

/**
 * Outcome returned by `sendEnvelope`. The optional `seq` is propagated
 * through to the tool output so agents can correlate emissions to
 * replay cursors on seq-aware implementations.
 */
export interface SendEnvelopeResult {
  readonly seq?: number;
}

/**
 * Caller-supplied dependency. Invoked AFTER all validation has passed.
 * May be async (hosted wraps an AWS SDK post; OSS wraps buffer record +
 * local fan-out). Errors propagate to the tool handler — `handleStream`
 * does not wrap them.
 */
export type SendEnvelopeFn = (envelope: HandleStreamEnvelope) => Promise<SendEnvelopeResult>;

export interface HandleStreamDeps {
  readonly render: GguiSessionStreamTarget;
  readonly sendEnvelope: SendEnvelopeFn;
}

/**
 * Run the `ggui_emit` emission flow. Returns a canonical
 * {@link GguiEmitOutput}.
 *
 * @throws {@link ChannelNotDeclaredError} — missing streamSpec or missing channel
 * @throws `ContractViolationError` (from `@ggui-ai/protocol`) — payload shape mismatch
 * @throws {@link InvalidCompleteError} — `complete: true` on a non-completable channel
 */
export async function handleStream<TPayload extends JsonValue = JsonValue>(
  input: GguiEmitInput<TPayload>,
  deps: HandleStreamDeps
): Promise<GguiEmitOutput> {
  const { render, sendEnvelope } = deps;

  // ── Step 1: streamSpec + channel must be declared ────────────────────
  const spec = render.streamSpec;
  const resolved = spec ? resolveStreamChannel(spec, input.channel) : undefined;
  if (!resolved) {
    const declared = spec ? Object.keys(spec) : [];
    throw new ChannelNotDeclaredError(input.channel, declared, render.renderId);
  }

  // ── Step 2: payload schema validation ────────────────────────────────
  // assertStreamContract treats `spec === undefined` as permissive (no-op),
  // but we've already proven `spec` is defined above — this call is the
  // schema check against the declared channel.
  assertStreamContract(spec, input.channel, input.payload);

  // ── Step 3: complete-legality ────────────────────────────────────────
  if (input.complete === true && !resolved.complete) {
    throw new InvalidCompleteError(input.channel);
  }

  // ── Step 4: derive mode from spec ────────────────────────────────────
  // resolveStreamChannel already applied DEFAULT_STREAM_CHANNEL_MODE.
  // This reference-dereference keeps the DEFAULT_STREAM_CHANNEL_MODE
  // constant statically reachable so a future rename notices this file.
  const mode: StreamChannelMode = resolved.mode ?? DEFAULT_STREAM_CHANNEL_MODE;

  // ── Step 5: build envelope-input and delegate to sendEnvelope ────────
  const envelope: HandleStreamEnvelope = {
    renderId: render.renderId,
    channel: input.channel,
    mode,
    payload: input.payload,
    ...(input.complete === true ? { complete: true as const } : {}),
  };
  const { seq } = await sendEnvelope(envelope);

  // ── Step 6: return acceptance (+ optional seq) ───────────────────────
  return seq !== undefined ? { accepted: true, seq } : { accepted: true };
}
