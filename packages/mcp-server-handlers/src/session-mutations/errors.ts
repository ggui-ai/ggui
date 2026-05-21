/**
 * Typed errors thrown by shared session-mutation helpers.
 *
 * Lives alongside the helpers (not in @ggui-ai/protocol) because these are
 * mutation-flow diagnostics — the protocol's ContractViolationError covers
 * the contract-violation surface; these cover the "target not found" /
 * "malformed input" surface that mutation paths need to distinguish.
 */

/**
 * Thrown when a mutation targets a stack item id (`stackItemId`) that does not
 * exist in the session's current stack. Distinct from ContractViolationError
 * so callers can route to a session-reset/replay flow rather than a
 * contract-renegotiation flow.
 *
 * Also thrown by `ggui_update` when the supplied `stackItemId` cannot be
 * resolved against the SessionStore's stackItemId secondary index — covers
 * three cases (stackItemId never minted, session already closed,
 * cross-tenant access attempt). The message intentionally does NOT
 * distinguish them, to avoid leaking the existence of cross-tenant
 * stack items.
 */
export class StackItemNotFoundError extends Error {
  readonly code = 'stack_item_not_found' as const;
  constructor(message: string) {
    super(message);
    this.name = 'StackItemNotFoundError';
  }
}

/**
 * Thrown by `ggui_handshake` when the wire input is missing the
 * required `sessionId` field. The flat top-level field replaces the
 * pre-CC nested `session.id?` shape; agents that haven't migrated will
 * trip this error on the first handshake.
 *
 * Recovery: call `ggui_new_session({seed?})` first, then thread
 * the returned `sessionId` into every subsequent `ggui_handshake` /
 * `ggui_update` call in the same chat.
 */
export class SessionRequiredError extends Error {
  readonly code = 'session_required' as const;
  constructor() {
    super(
      `ggui_handshake: sessionId is REQUIRED. Call ggui_new_session({seed?: '<stable-id-for-this-chat>'}) FIRST to mint a session, then thread the returned sessionId through every subsequent ggui_handshake call. Sessions persist across multiple handshake/push pairs in the same chat — call ggui_new_session ONCE per chat conversation, not per push. If you already called ggui_new_session earlier in this chat, reuse that sessionId.`,
    );
    this.name = 'SessionRequiredError';
  }
}

/**
 * Thrown when a tool that requires a sessionId receives one that
 * doesn't resolve to any live session for the caller's appId. Three
 * triggers, all surfaced as the same error to avoid leaking cross-
 * tenant existence:
 *
 *   1. The sessionId was never minted (typo, fabricated, replay from a
 *      different deployment).
 *   2. The sessionId belongs to a different appId (cross-tenant probe).
 *   3. The session was deleted or its TTL expired.
 *
 * Recovery: call `ggui_new_session` to mint a fresh sessionId, then
 * thread it through subsequent calls. The prior session's stack items
 * are NOT recoverable via this path — stackItemIds from the lost session
 * will return StackItemNotFoundError on `ggui_update`.
 */
export class SessionNotFoundError extends Error {
  readonly code = 'session_not_found' as const;
  constructor(public readonly sessionId: string) {
    super(
      `Session "${sessionId}" not found. Either it was never minted, expired (TTL), was deleted, or belongs to a different appId. Recovery: call ggui_new_session({seed?: '<stable-id-for-this-chat>'}) to mint a fresh sessionId, then thread it through subsequent calls. Stack items from the lost session are not recoverable on this path.`,
    );
    this.name = 'SessionNotFoundError';
  }
}

/**
 * Thrown by `ggui_new_session` when a `seed`-derived sessionId resolves
 * to an existing session that has been closed (terminal state — no
 * further operations accepted). The seed-deterministic-derivation flow
 * intentionally surfaces this so agents can pick a different seed or
 * omit `seed` to mint a fresh UUID, rather than silently replaying onto
 * a dead session.
 *
 * NOT thrown by `ggui_handshake` / `ggui_update` — those route closed-
 * session access through `SessionNotFoundError` (the session is no
 * longer addressable) or `StackItemNotFoundError` (the stack item lookup
 * failed because the session was closed).
 */
export class SessionClosedError extends Error {
  readonly code = 'session_closed' as const;
  constructor(public readonly sessionId: string) {
    super(
      `ggui_new_session: seed-derived sessionId "${sessionId}" resolves to a CLOSED session. Recovery: pass a different seed (e.g. include topic / timestamp / scope to make it more specific), or omit seed entirely to mint a fresh random UUID.`,
    );
    this.name = 'SessionClosedError';
  }
}

/**
 * Thrown when `ggui_emit` is called with no resolvable active stack item.
 *
 * Distinct from `StackItemNotFoundError`: PageNotFound means "the stackItemId you
 * supplied does not exist in the stack"; NoActiveStackItem means "the
 * stack is empty, so there's no default target to resolve against." The
 * two share a structural ancestor but surface differently to the caller —
 * one is a stale-reference bug, the other is a session-lifecycle bug.
 */
export class NoActiveStackItemError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`No active stack item for session '${sessionId}'. Push a card before streaming.`);
    this.name = 'NoActiveStackItemError';
    this.sessionId = sessionId;
  }
}

/**
 * Thrown when `ggui_emit` targets a channel that is not declared on the
 * resolved stack item's `streamSpec`, OR when the resolved stack
 * item has no `streamSpec` at all.
 *
 * Post-streamSpec-rewrite, permissive-when-spec-missing is no longer
 * allowed: a stack item without a streamSpec cannot accept `ggui_emit`
 * emissions. Callers who want a card without live-channel affordances
 * simply don't call the tool.
 */
export class ChannelNotDeclaredError extends Error {
  readonly channel: string;
  readonly declaredChannels: ReadonlyArray<string>;
  readonly stackItemId: string | undefined;

  constructor(channel: string, declaredChannels: ReadonlyArray<string>, stackItemId?: string) {
    super(
      `Channel '${channel}' is not declared on the stack item's streamSpec. Declared channels: [${declaredChannels.join(', ') || '(none — no streamSpec on this card)'}]`,
    );
    this.name = 'ChannelNotDeclaredError';
    this.channel = channel;
    this.declaredChannels = declaredChannels;
    if (stackItemId !== undefined) {
      this.stackItemId = stackItemId;
    } else {
      this.stackItemId = undefined;
    }
  }
}

/**
 * Thrown when `ggui_emit` sets `complete: true` on a channel that was
 * not declared with `complete: true` on the streamSpec. A channel's
 * completability is part of its contract — retroactively declaring one
 * completable at emit time would let producers violate receivers'
 * expectations (receivers render 'channel closed' state only for
 * channels they know can close).
 */
export class InvalidCompleteError extends Error {
  readonly channel: string;

  constructor(channel: string) {
    super(
      `Channel '${channel}' was not declared with complete: true on its streamSpec. Declare completability on the spec, or drop complete from the emission.`,
    );
    this.name = 'InvalidCompleteError';
    this.channel = channel;
  }
}

/**
 * Thrown when an inbound event's `type` is not in the active stack item's
 * `subscription.events` allowlist. Distinct from `ContractViolationError`
 * because this is an access violation, not a schema violation — different
 * semantics, different hint, different callsite response (no contract to
 * re-negotiate; the client should fix which event types it emits, or the
 * agent should widen its subscription).
 *
 * The three enforcement concerns stay structurally distinct:
 *   - ContractViolationError       — payload shape violates a declared schema
 *   - StackItemNotFoundError            — target stack item id doesn't exist
 *   - EventNotAllowedError (this)  — event type not in the subscription allowlist
 */
export class EventNotAllowedError extends Error {
  readonly eventType: string;
  readonly allowedEvents: ReadonlyArray<string>;

  constructor(eventType: string, allowedEvents: ReadonlyArray<string>) {
    super(
      `Event type '${eventType}' is not in the session's subscription allowlist. Declared events: [${allowedEvents.join(', ') || '(none)'}]`,
    );
    this.name = 'EventNotAllowedError';
    this.eventType = eventType;
    this.allowedEvents = allowedEvents;
  }

  /**
   * Structured payload for wire-level error envelopes. Returns a mutable
   * `string[]` (not readonly) so the shape is assignable to `JsonValue`
   * at transport boundaries without a cast.
   */
  toErrorData(): {
    error: 'event_not_allowed';
    eventType: string;
    allowedEvents: string[];
  } {
    return {
      error: 'event_not_allowed',
      eventType: this.eventType,
      allowedEvents: [...this.allowedEvents],
    };
  }
}

/**
 * Closed enum union of every error code the push + handshake gate
 * stack can throw for gadget-related rejections. Keeps the wire
 * vocabulary single-sourced so the cloud, standalone server, and SDK
 * error matchers don't silently diverge as new gate paths land.
 *
 * Tag stays as the readonly `code` field on each error class above
 * (`GadgetNotRegisteredError.code`, `GadgetPublicEnvMissingError.code`).
 * This union is the type-level closure consumers can switch on.
 *
 * ## NOT in this union: `gadget_preservation:<hook>`
 *
 * The `gadget_preservation:*` namespace does NOT belong in this
 * union. `gadget_preservation:<hook>` is a
 * `Tier0CheckResult.subcategory` value emitted by the ui-gen
 * self-check pipeline at
 * `packages/ui-gen/src/check/run-tier0.ts:gadget_preservation:${hook}`
 * — a CODE-LEVEL diagnostic about whether the LLM kept the boilerplate
 * direct import of each gadget export (`import { useFoo } from
 * '<package>'`) intact. It rides on the
 * synthesis/check loop, never on the push/handshake gate stack, and
 * has its own structured shape (`{tier, category, subcategory,
 * severity, description, fix}`) distinct from this string-union wire
 * vocabulary.
 *
 * Keeping the two namespaces separate is intentional: this union is
 * the GATE-rejection contract (server-side refusal to mutate state);
 * `gadget_preservation:*` is the CODE-quality finding (LLM output
 * needs another pass). Conflating them would lose the "where in the
 * pipeline did this fail" signal that each consumer relies on.
 */
export type GadgetGateErrorCode =
  | 'gadget_not_registered'
  | 'gadget_package_mismatch'
  | 'gadget_public_env_missing'
  | 'unknown_generator';

