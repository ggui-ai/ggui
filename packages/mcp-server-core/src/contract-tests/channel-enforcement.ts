/**
 * Contract test factory for live-channel enforcement consumers.
 *
 * Unlike the adapter contracts in this directory (SessionStore,
 * VectorStore, AuthAdapter, …) the subject under test here is NOT a
 * single interface implementation — it's the behavioral shape of any
 * code path that enforces live-channel contracts inbound + outbound.
 * Today that's the hosted Lambda handler + `@ggui-ai/mcp-server`'s
 * `/ws` endpoint, both wired through the shared
 * `@ggui-ai/mcp-server-handlers/session-mutations` helpers. The
 * contract suite asserts they behave identically on the invariants
 * both MUST honor.
 *
 * Normative invariants (every conforming consumer MUST satisfy):
 *
 *   Inbound:
 *     1. Allowlist gate runs for EVERY event type. An event whose
 *        `event.type` isn't in the active stack item's
 *        `subscription.events` (or the protocol's DEFAULT_SUBSCRIPTION
 *        when no subscription is declared) is rejected with code
 *        `EVENT_NOT_ALLOWED`.
 *     2. Missing subscription falls back to DEFAULT_SUBSCRIPTION
 *        (`data:submit` + `lifecycle:session_end`).
 *     3. Explicit subscription overrides the default — DEFAULT is a
 *        fallback, not a floor.
 *     4. For `data:submit` events ONLY, the payload is validated
 *        against the stack item's `actionSpec`. Violations are
 *        rejected with code `CONTRACT_VIOLATION`.
 *     5. Missing `actionSpec` is permissive (matches legacy "no
 *        contract declared = nothing to enforce" semantics).
 *     6. Allowlist check runs BEFORE payload check: an event with
 *        both problems is reported as `EVENT_NOT_ALLOWED` (the
 *        allowlist failure takes precedence).
 *
 *   Outbound:
 *     7. `data` payloads sent to subscribers are validated against
 *        the active stack item's `streamSpec`. Violations are
 *        REJECTED — the payload MUST NOT reach subscribers. Consumers
 *        are free to map the rejection to a thrown error (server-
 *        internal callers) or a structured wire envelope (agent-
 *        facing callers); the contract only asserts the delivery
 *        decision.
 *     8. Missing `streamSpec` is permissive.
 *
 * Out of scope for this contract:
 *   - Consumer-specific wire envelopes (hosted's ErrorPayload shape
 *     vs OSS's JSON framing vs a future transport's bytes). The
 *     contract asserts the DECISION (pass / reject-with-code), not
 *     the byte format.
 *   - Session-scoping, spoof rejection, auth: those are consumer-
 *     specific concerns that sit ABOVE the enforcement contract.
 *   - Persistence / fan-out mechanics / observer notification: those
 *     are consumer-specific effects that run AFTER the enforcement
 *     decision.
 *
 * Usage:
 *
 * ```ts
 * import { channelEnforcementContract } from
 *   '@ggui-ai/mcp-server-core/contract-tests';
 *
 * channelEnforcementContract('my channel impl', async () => ({
 *   async processInboundEvent(stackItem, event) { ... },
 *   async processOutboundData(stackItem, data) { ... },
 * }));
 * ```
 */
import { describe, expect, it } from 'vitest';
import type {
  ActionEnvelope,
  ActionEventValue,
  ActionSpec,
  EventType,
  JsonValue,
  StackItem,
  StreamSpec,
} from '@ggui-ai/protocol';

/**
 * Outcome of a single enforcement step. Consumers normalize their
 * consumer-specific results (thrown error / wire envelope / structured
 * response) into this shape.
 */
export type ChannelEnforcementOutcome =
  | { readonly kind: 'pass' }
  | { readonly kind: 'reject'; readonly code: ChannelRejectionCode };

/**
 * Rejection codes the enforcement contract formally recognizes.
 * Consumers MAY emit additional codes for out-of-contract concerns
 * (SESSION_MISMATCH, SESSION_NOT_FOUND, UNAUTHENTICATED, …) — those
 * stay consumer-specific and DO NOT appear in this enum.
 */
export type ChannelRejectionCode =
  | 'EVENT_NOT_ALLOWED'
  | 'CONTRACT_VIOLATION';

/**
 * Minimal harness shape. Consumers wire their real enforcement path
 * behind these two methods; the contract suite feeds inputs through
 * them and asserts the normalized outcome.
 */
export interface ChannelEnforcementHarness {
  /**
   * Process an inbound event against the given active stack item.
   * `stackItem === undefined` models the "no active stack item" case
   * (empty stack / out-of-range index) — the harness should treat it
   * as "no subscription and no actionSpec declared" so the contract
   * can assert the DEFAULT_SUBSCRIPTION fallback.
   */
  processInboundEvent(
    stackItem: StackItem | undefined,
    envelope: ActionEnvelope,
  ): Promise<ChannelEnforcementOutcome>;

  /**
   * Process an outbound fan-out delivery against the given active
   * stack item. Takes the explicit `channel` + `payload` pair — the
   * same split the {@link import('@ggui-ai/protocol').StreamEnvelope}
   * wire shape uses. Same `undefined` semantics as above for the
   * stack item.
   */
  processOutboundData(
    stackItem: StackItem | undefined,
    channel: string,
    payload: JsonValue,
  ): Promise<ChannelEnforcementOutcome>;
}

/**
 * Invoke the contract suite. `makeHarness` is called once per `it`
 * block so state doesn't bleed across cases.
 */
export function channelEnforcementContract(
  label: string,
  makeHarness: () =>
    | Promise<ChannelEnforcementHarness>
    | ChannelEnforcementHarness,
): void {
  describe(`channel enforcement contract — ${label}`, () => {
    // ── Inbound: allowlist gate ────────────────────────────────────

    it('allows an event type declared in the stack item subscription', async () => {
      const harness = await makeHarness();
      const stackItem = makeStackItem({
        subscription: { events: ['data:submit'] },
      });
      const outcome = await harness.processInboundEvent(
        stackItem,
        makeEvent('data:submit'),
      );
      expect(outcome.kind).toBe('pass');
    });

    it('falls back to DEFAULT_SUBSCRIPTION when stack item has no subscription', async () => {
      const harness = await makeHarness();
      const stackItem = makeStackItem({}); // no subscription
      // DEFAULT_SUBSCRIPTION includes 'data:submit' + 'lifecycle:session_end'.
      const submit = await harness.processInboundEvent(
        stackItem,
        makeEvent('data:submit'),
      );
      expect(submit.kind).toBe('pass');
      const end = await harness.processInboundEvent(
        stackItem,
        makeEvent('lifecycle:session_end'),
      );
      expect(end.kind).toBe('pass');
    });

    it('falls back to DEFAULT_SUBSCRIPTION when stack item is undefined', async () => {
      const harness = await makeHarness();
      const outcome = await harness.processInboundEvent(
        undefined,
        makeEvent('data:submit'),
      );
      expect(outcome.kind).toBe('pass');
    });

    it('rejects event type outside explicit subscription with EVENT_NOT_ALLOWED', async () => {
      const harness = await makeHarness();
      const stackItem = makeStackItem({
        subscription: { events: ['data:submit'] },
      });
      const outcome = await harness.processInboundEvent(
        stackItem,
        makeEvent('interaction:click'),
      );
      expect(outcome).toEqual({ kind: 'reject', code: 'EVENT_NOT_ALLOWED' });
    });

    it('rejects a DEFAULT-allowed type when the explicit subscription omits it', async () => {
      const harness = await makeHarness();
      // lifecycle:session_end is in DEFAULT_SUBSCRIPTION but NOT in NARROW.
      // The explicit list wins; DEFAULT is a fallback, not a floor.
      const stackItem = makeStackItem({
        subscription: { events: ['data:submit'] },
      });
      const outcome = await harness.processInboundEvent(
        stackItem,
        makeEvent('lifecycle:session_end'),
      );
      expect(outcome).toEqual({ kind: 'reject', code: 'EVENT_NOT_ALLOWED' });
    });

    // ── Inbound: payload contract (data:submit only) ───────────────

    it('allows non-data:submit events without touching actionSpec', async () => {
      const harness = await makeHarness();
      // actionSpec is declared but we're sending a lifecycle event —
      // the payload check must NOT run for non-data:submit events.
      const stackItem = makeStackItem({
        subscription: {
          events: ['data:submit', 'lifecycle:session_end'],
        },
        actionSpec: SUBMIT_SPEC,
      });
      const outcome = await harness.processInboundEvent(
        stackItem,
        makeEvent('lifecycle:session_end'),
      );
      expect(outcome.kind).toBe('pass');
    });

    it('allows data:submit with declared action and matching payload', async () => {
      const harness = await makeHarness();
      const stackItem = makeStackItem({ actionSpec: SUBMIT_SPEC });
      const outcome = await harness.processInboundEvent(
        stackItem,
        makeEvent('data:submit', { action: 'submit', data: { text: 'hi' } }),
      );
      expect(outcome.kind).toBe('pass');
    });

    it('permissive when stack item has no actionSpec (no contract = nothing to enforce)', async () => {
      const harness = await makeHarness();
      const stackItem = makeStackItem({}); // no actionSpec
      const outcome = await harness.processInboundEvent(
        stackItem,
        makeEvent('data:submit', { action: 'anything', data: {} }),
      );
      expect(outcome.kind).toBe('pass');
    });

    it('rejects data:submit with undeclared action id using CONTRACT_VIOLATION', async () => {
      const harness = await makeHarness();
      const stackItem = makeStackItem({ actionSpec: SUBMIT_SPEC });
      const outcome = await harness.processInboundEvent(
        stackItem,
        makeEvent('data:submit', { action: 'deleteAccount', data: {} }),
      );
      expect(outcome).toEqual({ kind: 'reject', code: 'CONTRACT_VIOLATION' });
    });

    it('allows data:submit on a declared void-payload action (no schema on entry)', async () => {
      const harness = await makeHarness();
      // `ActionEntry.schema` is optional — void-payload actions
      // (fire-and-forget buttons, etc.) declare the action without a
      // schema. The contract pins that validateActionData MUST be
      // permissive for such actions even when callers attach
      // forward-compat metadata to `data`.
      const stackItem = makeStackItem({
        actionSpec: {
          archive: { label: 'Archive' }, // no schema → void payload
        },
      });
      const outcome = await harness.processInboundEvent(
        stackItem,
        makeEvent('data:submit', { action: 'archive', data: { client: 'x' } }),
      );
      expect(outcome.kind).toBe('pass');
    });

    // ── Ordering: allowlist runs BEFORE payload ────────────────────

    it('reports allowlist failure first when an event fails both checks', async () => {
      const harness = await makeHarness();
      // interaction:click is NOT in the subscription AND carries a value
      // that would also fail actionSpec. Allowlist takes precedence.
      const stackItem = makeStackItem({
        subscription: { events: ['data:submit'] },
        actionSpec: SUBMIT_SPEC,
      });
      const outcome = await harness.processInboundEvent(
        stackItem,
        makeEvent('interaction:click', { action: 'deleteAccount', data: {} }),
      );
      expect(outcome).toEqual({ kind: 'reject', code: 'EVENT_NOT_ALLOWED' });
    });

    // ── Outbound: fan-out contract ─────────────────────────────────

    it('allows outbound data matching streamSpec', async () => {
      const harness = await makeHarness();
      const stackItem = makeStackItem({ streamSpec: TICK_SPEC });
      const outcome = await harness.processOutboundData(stackItem, 'tick', {
        count: 3,
      });
      expect(outcome.kind).toBe('pass');
    });

    it('permissive when stack item has no streamSpec', async () => {
      const harness = await makeHarness();
      const stackItem = makeStackItem({}); // no streamSpec
      const outcome = await harness.processOutboundData(
        stackItem,
        'anything',
        {},
      );
      expect(outcome.kind).toBe('pass');
    });

    it('rejects outbound data violating streamSpec with CONTRACT_VIOLATION', async () => {
      const harness = await makeHarness();
      const stackItem = makeStackItem({ streamSpec: TICK_SPEC });
      const outcome = await harness.processOutboundData(
        stackItem,
        'undeclared',
        {},
      );
      expect(outcome).toEqual({ kind: 'reject', code: 'CONTRACT_VIOLATION' });
    });
  });
}

// ── Shared test fixtures ─────────────────────────────────────────────

const SUBMIT_SPEC: ActionSpec = {
  submit: {
    label: 'Submit',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
};

const TICK_SPEC: StreamSpec = {
  tick: {
    schema: {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    },
  },
};

interface StackItemPatch {
  id?: string;
  subscription?: StackItem['subscription'];
  actionSpec?: ActionSpec;
  streamSpec?: StreamSpec;
}

function makeStackItem(patch: StackItemPatch): StackItem {
  return {
    id: patch.id ?? 'page-0',
    componentCode: '/* stub */',
    createdAt: new Date().toISOString(),
    ...(patch.subscription ? { subscription: patch.subscription } : {}),
    ...(patch.actionSpec ? { actionSpec: patch.actionSpec } : {}),
    ...(patch.streamSpec ? { streamSpec: patch.streamSpec } : {}),
  };
}

function makeEvent(
  eventType: EventType,
  value?: ActionEventValue,
): ActionEnvelope {
  const envelope: ActionEnvelope = {
    sessionId: 'sess-contract',
    type: eventType,
    stackIndex: 0,
  };
  if (value !== undefined) {
    envelope.payload = value as unknown as JsonValue;
  }
  return envelope;
}
