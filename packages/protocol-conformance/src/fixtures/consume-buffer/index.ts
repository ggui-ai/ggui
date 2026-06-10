/**
 * `consume-buffer` fixture sub-module.
 *
 * Exercises the single action-routing model's wire-observable half:
 * every UI action lands as an event on the GguiSession's consume
 * buffer, and the buffer append is provable on pure WS.
 *
 *   - `action-ack-sequence` — a declared action's ack frame carries
 *     `payload.sequence`, the monotonic event sequence the append
 *     assigned. Persistence proof.
 *   - `undeclared-action-rejected` — a `data:submit` action absent
 *     from the declared actionSpec replies an `error` frame with code
 *     `CONTRACT_VIOLATION`; nothing is appended. Contract-gate proof.
 *
 * The retrieval half — the agent draining the buffer via
 * `ggui_consume` — is an MCP tool call a WS-only runner cannot drive;
 * that obligation belongs to an MCP-binding driver, not this catalog.
 */
import actionAckSequence from './action-ack-sequence.json' with { type: 'json' };
import undeclaredActionRejected from './undeclared-action-rejected.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting consume-buffer action routing (SPEC
 *  §nextStep-evolution single model + §4.4 contract enforcement). */
export const consumeBufferFixtures: readonly TestCase[] = [
  actionAckSequence as TestCase,
  undeclaredActionRejected as TestCase,
];
