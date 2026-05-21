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
 *   1. Resolve target stack item:
 *      - `stackItemId` supplied → find item with matching `id`.
 *        Missing → throw {@link StackItemNotFoundError}.
 *      - Else → `session.currentStackIndex` lookup.
 *        Empty → throw {@link NoActiveStackItemError}.
 *
 *   2. Resolved item MUST have `streamSpec`, AND
 *      `streamSpec[input.channel]` MUST exist.
 *      Missing either → throw {@link ChannelNotDeclaredError}.
 *
 *   3. Validate `input.payload` against
 *      `streamSpec[channel].schema` via
 *      {@link assertStreamContract}.
 *      Failure → `ContractViolationError{tool:'ggui_emit'}`.
 *
 *   4. If `input.complete === true`, the channel MUST have been declared
 *      with `complete: true`.
 *      Otherwise → throw {@link InvalidCompleteError}.
 *
 * After validation:
 *
 *   5. Derive `mode` from `streamSpec[channel].mode` (default
 *      `'append'`). Agent-supplied `mode` is NOT supported.
 *
 *   6. Build a {@link StreamEnvelopeInput} `{sessionId, channel, mode,
 *      payload, complete?}` and hand it to the caller-supplied
 *      `sendEnvelope`.
 *
 *   7. `sendEnvelope` returns `{seq?}` — seq-aware implementations (OSS
 *      `SessionStreamBuffer`) stamp and return the assigned sequence;
 *      implementations without a buffer (hosted today) return `{}`.
 *      `handleStream` propagates seq back through its result so the tool
 *      handler can surface it to the agent.
 *
 *   8. No-subscriber is NOT an error at this layer. Acceptance is at the
 *      server boundary; fan-out is a separate concern owned by
 *      `sendEnvelope`.
 *
 * What this helper is NOT:
 *   - NOT a transport adapter — it calls `sendEnvelope`, doesn't speak WS.
 *   - NOT a session store — callers pass the session snapshot in.
 *   - NOT a post-complete state machine — the design lock defers strict
 *     per-channel quiescence enforcement. Producers SHOULD NOT emit
 *     after `complete: true`; this helper doesn't reject if they do.
 *
 * Seam-free, pure + injectable. Lives in session-mutations alongside
 * `assertStreamContract` (payload validator) and `resolveStreamChannel`
 * (semantics lookup) — both of which this helper composes on.
 */
import type {
  GguiEmitInput,
  GguiEmitOutput,
  JsonValue,
  StackItem,
  StreamSpec,
} from '@ggui-ai/protocol';
import {
  DEFAULT_STREAM_CHANNEL_MODE,
  resolveStreamChannel,
  type StreamChannelMode,
} from '@ggui-ai/protocol';
import { assertStreamContract } from './assert-stream-contract.js';
import {
  ChannelNotDeclaredError,
  InvalidCompleteError,
  NoActiveStackItemError,
  StackItemNotFoundError,
} from './errors.js';

/**
 * Minimum shape the helper needs from a resolved session. Callers project
 * their hosted DDB row or OSS in-memory Session onto this — both satisfy
 * the shape naturally, so neither needs a cast.
 */
export interface StreamSessionTarget {
  readonly sessionId: string;
  readonly stack: ReadonlyArray<Partial<StackItem> & { readonly id: string; readonly streamSpec?: StreamSpec }>;
  readonly currentStackIndex?: number;
}

/**
 * The envelope-input shape the helper hands to `sendEnvelope`. Structural
 * peer of `StreamEnvelopeInput` from `@ggui-ai/mcp-server-core` —
 * duplicated here to keep session-mutations free of a mcp-server-core
 * dependency (session-mutations sits below core in the layering).
 *
 * Consumers that accept `StreamEnvelopeInput` can assign this directly.
 */
export interface HandleStreamEnvelope {
  readonly sessionId: string;
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
export type SendEnvelopeFn = (
  envelope: HandleStreamEnvelope,
) => Promise<SendEnvelopeResult>;

export interface HandleStreamDeps {
  readonly session: StreamSessionTarget;
  readonly sendEnvelope: SendEnvelopeFn;
}

/**
 * Run the `ggui_emit` emission flow. Returns a canonical
 * {@link GguiEmitOutput}.
 *
 * @throws {@link NoActiveStackItemError} — empty stack and no stackItemId pinned
 * @throws {@link StackItemNotFoundError} — stackItemId supplied but not in stack
 * @throws {@link ChannelNotDeclaredError} — missing streamSpec or missing channel
 * @throws `ContractViolationError` (from `@ggui-ai/protocol`) — payload shape mismatch
 * @throws {@link InvalidCompleteError} — `complete: true` on a non-completable channel
 */
export async function handleStream<TPayload extends JsonValue = JsonValue>(
  input: GguiEmitInput<TPayload>,
  deps: HandleStreamDeps,
): Promise<GguiEmitOutput> {
  const { session, sendEnvelope } = deps;

  // ── Step 1: resolve target stack item ────────────────────────────────
  const stack = session.stack;
  let targetItem: (typeof stack)[number] | undefined;
  if (input.stackItemId !== undefined) {
    targetItem = stack.find((item) => item.id === input.stackItemId);
    if (!targetItem) {
      throw new StackItemNotFoundError(
        `Page not found: ${input.stackItemId}. Declared page ids: [${stack.map((item) => item.id).join(', ')}]`,
      );
    }
  } else {
    if (stack.length === 0) {
      throw new NoActiveStackItemError(session.sessionId);
    }
    const idx =
      session.currentStackIndex ?? stack.length - 1;
    targetItem = stack[Math.min(Math.max(idx, 0), stack.length - 1)];
    if (!targetItem) {
      throw new NoActiveStackItemError(session.sessionId);
    }
  }

  // ── Step 2: streamSpec + channel must be declared ────────────────────
  const spec = targetItem.streamSpec;
  const resolved = spec ? resolveStreamChannel(spec, input.channel) : undefined;
  if (!resolved) {
    const declared = spec ? Object.keys(spec) : [];
    throw new ChannelNotDeclaredError(input.channel, declared, targetItem.id);
  }

  // ── Step 3: payload schema validation ────────────────────────────────
  // assertStreamContract treats `spec === undefined` as permissive (no-op),
  // but we've already proven `spec` is defined above — this call is the
  // schema check against the declared channel.
  assertStreamContract(spec, input.channel, input.payload);

  // ── Step 4: complete-legality ────────────────────────────────────────
  if (input.complete === true && !resolved.complete) {
    throw new InvalidCompleteError(input.channel);
  }

  // ── Step 5: derive mode from spec ────────────────────────────────────
  // resolveStreamChannel already applied DEFAULT_STREAM_CHANNEL_MODE.
  // This reference-dereference keeps the DEFAULT_STREAM_CHANNEL_MODE
  // constant statically reachable so a future rename notices this file.
  const mode: StreamChannelMode = resolved.mode ?? DEFAULT_STREAM_CHANNEL_MODE;

  // ── Step 6: build envelope-input and delegate to sendEnvelope ────────
  const envelope: HandleStreamEnvelope = {
    sessionId: session.sessionId,
    channel: input.channel,
    mode,
    payload: input.payload,
    ...(input.complete === true ? { complete: true as const } : {}),
  };
  const { seq } = await sendEnvelope(envelope);

  // ── Step 7: return acceptance (+ optional seq) ───────────────────────
  return seq !== undefined ? { accepted: true, seq } : { accepted: true };
}
