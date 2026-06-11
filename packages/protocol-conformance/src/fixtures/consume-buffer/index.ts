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
 *     `CONTRACT_VIOLATION`; nothing is appended. Contract-gate proof,
 *     name-membership half.
 *   - `action-payload-schema-violation` — a `data:submit` action
 *     naming a DECLARED entry whose `data` violates the entry's
 *     declared payload schema replies the same `error` frame with
 *     code `CONTRACT_VIOLATION`; nothing is appended. Contract-gate
 *     proof, payload-schema half (SPEC §4.6 receipt validation).
 *
 * The retrieval half — the agent draining the buffer via
 * `ggui_consume` — is an MCP tool call a WS-only runner cannot drive;
 * that obligation belongs to an MCP-binding driver, not this catalog.
 * Same declared-gap posture for the schema-validity meta-check on the
 * DECLARED schema itself: a malformed authored schema is a fixture-
 * authoring error the runner throws on (validating parse), while a
 * malformed AGENT-authored schema on a live server is a `ggui_render`
 * / `ggui_handshake` rejection (SPEC Section 7.9) outside this WS
 * kit's observation window.
 */
import actionAckSequence from './action-ack-sequence.json' with { type: 'json' };
import actionPayloadSchemaViolation from './action-payload-schema-violation.json' with { type: 'json' };
import undeclaredActionRejected from './undeclared-action-rejected.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting consume-buffer action routing (SPEC
 *  §nextStep-evolution single model + §4.4 contract enforcement +
 *  §4.6 receipt validation). */
export const consumeBufferFixtures: readonly TestCase[] = [
  actionAckSequence as TestCase,
  actionPayloadSchemaViolation as TestCase,
  undeclaredActionRejected as TestCase,
];
