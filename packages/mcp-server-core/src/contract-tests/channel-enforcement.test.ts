/**
 * Self-test for `channelEnforcementContract` — proves the contract
 * cases are well-formed by running them against a REFERENCE harness
 * that uses only `@ggui-ai/protocol` validators.
 *
 * This harness doubles as documentation: any consumer can satisfy the
 * contract by composing the three enforcement primitives in the order
 * shown below. Real consumers (hosted Lambda, @ggui-ai/mcp-server /ws)
 * compose them slightly differently — they own persistence, transport,
 * and observer concerns — but the enforcement shape is identical.
 *
 * The reference harness deliberately does NOT import
 * `@ggui-ai/mcp-server-handlers/session-mutations`. Mcp-server-handlers
 * depends on mcp-server-core, so pulling the helpers in here would
 * create a circular dep. The reference uses protocol primitives
 * directly to stay dep-clean AND to show that the contract is a
 * property of the PROTOCOL's shared validators, not of any one
 * consumer package.
 */
import {
  DEFAULT_SUBSCRIPTION,
  validateActionData,
  validateStreamData,
} from '@ggui-ai/protocol';
import {
  channelEnforcementContract,
  type ChannelEnforcementHarness,
} from './channel-enforcement.js';

const referenceHarness: ChannelEnforcementHarness = {
  async processInboundEvent(stackItem, envelope) {
    // Step 1: allowlist. Missing subscription → DEFAULT_SUBSCRIPTION.
    const allowed =
      stackItem?.subscription?.events ?? DEFAULT_SUBSCRIPTION.events;
    if (!allowed.includes(envelope.type as (typeof allowed)[number])) {
      return { kind: 'reject', code: 'EVENT_NOT_ALLOWED' };
    }
    // Step 2: payload contract (data:submit only, permissive without actionSpec).
    if (envelope.type === 'data:submit' && stackItem?.actionSpec) {
      const result = validateActionData(
        envelope.payload,
        stackItem.actionSpec,
      );
      if (!result.valid) {
        return { kind: 'reject', code: 'CONTRACT_VIOLATION' };
      }
    }
    return { kind: 'pass' };
  },
  async processOutboundData(stackItem, channel, payload) {
    if (!stackItem?.streamSpec) return { kind: 'pass' };
    const result = validateStreamData(channel, payload, stackItem.streamSpec);
    if (!result.valid) {
      return { kind: 'reject', code: 'CONTRACT_VIOLATION' };
    }
    return { kind: 'pass' };
  },
};

channelEnforcementContract(
  'reference protocol-validator composition',
  () => referenceHarness,
);
