/**
 * Inbound `action` frame handling — parse the canonical live-channel
 * action message, enforce the declared actionSpec contract, append the
 * envelope to the GguiSession's consume-buffer ledger, and ack with
 * the assigned sequence.
 *
 * Ordering contract (mirrors the first-party server): validate →
 * append → ack. The ack's `payload.sequence` is the wire-observable
 * proof the action event persisted to the consume buffer — the kit's
 * `action-ack-sequence` fixture grades exactly this. The retrieval
 * half (the agent draining the buffer via `ggui_consume`) is an MCP
 * tool call outside this WS-only server's scope.
 *
 * Contract enforcement: for `type: 'data:submit'` envelopes against a
 * session WITH a declared actionSpec, the ActionEventValue's `action`
 * MUST name a declared entry, and — when that entry declares a
 * `schema` — its `data` MUST conform to it (SPEC §4.6 receipt
 * validation). Both halves are graded by the protocol's own
 * `validateActionData`, the same validator the first-party server's
 * `assertActionContract` enforcement runs, so the two
 * implementations can never drift on what counts as a violation.
 * Violations reply an `error` frame with code `CONTRACT_VIOLATION`
 * (echoing the message's `requestId`, carrying the structured
 * violation list under `payload.details`) and the envelope is NOT
 * appended — rejected actions never reach the buffer. Sessions
 * without a declared actionSpec accept every action: no contract,
 * nothing to enforce.
 */
import { ContractViolationError, validateActionData } from '@ggui-ai/protocol';

import { isRecord } from '@ggui-ai/protocol';
import { appendEvent, type GguiSession, type Subscriber } from './render.js';

/**
 * One inbound action message — the canonical live-channel shape:
 * `{type: 'action', payload: ActionEnvelope, requestId?}` where the
 * envelope carries `{sessionId, type, payload?}` and, for
 * `type: 'data:submit'`, `payload` is the ActionEventValue
 * (`{action, data?, tool?}`).
 */
interface IncomingActionMessage {
  readonly type: 'action';
  readonly requestId?: string;
  readonly payload: {
    readonly sessionId: string;
    /** Event type, e.g. `'data:submit'`. */
    readonly type: string;
    /** ActionEventValue for `data:submit`; free-form otherwise. */
    readonly payload?: unknown;
  };
}

/**
 * Parse + validate an inbound action message. Returns the normalized
 * shape on success, `undefined` on any malformed input (matcher for
 * `no-op` fixtures expects silence, so loud rejection would break
 * them).
 *
 * Reads the canonical SPEC session-identity field `sessionId` from
 * the envelope body.
 */
export function parseActionFrame(frame: unknown): IncomingActionMessage | undefined {
  if (!isRecord(frame)) return undefined;
  if (frame['type'] !== 'action') return undefined;
  const envelope = frame['payload'];
  if (!isRecord(envelope)) return undefined;
  const sessionId = typeof envelope['sessionId'] === 'string' ? envelope['sessionId'] : undefined;
  if (sessionId === undefined) return undefined;
  const eventType = typeof envelope['type'] === 'string' ? envelope['type'] : undefined;
  if (eventType === undefined) return undefined;
  const requestId = typeof frame['requestId'] === 'string' ? frame['requestId'] : undefined;
  return {
    type: 'action',
    ...(requestId !== undefined ? { requestId } : {}),
    payload: {
      sessionId,
      type: eventType,
      ...('payload' in envelope ? { payload: envelope['payload'] } : {}),
    },
  };
}

export interface HandleActionContext {
  readonly render: GguiSession;
  /** Reply handle for the SENDING socket — acks and contract
   *  rejections go to the dispatcher, not the broadcast set. */
  readonly reply: Subscriber;
}

/**
 * Handle one parsed action message: enforce the declared-action
 * contract, append, ack. Synchronous — the ledger is in-memory, so
 * the ack ordering is deterministic relative to the inbound message
 * stream.
 */
export function handleAction(
  message: IncomingActionMessage,
  context: HandleActionContext,
): void {
  const { render, reply } = context;
  const requestIdProps =
    message.requestId !== undefined ? { requestId: message.requestId } : {};

  if (message.payload.type === 'data:submit' && render.actionSpec !== undefined) {
    const result = validateActionData(message.payload.payload, render.actionSpec);
    if (!result.valid) {
      // Same error construction as the first-party server's
      // `assertActionContract` path: `ContractViolationError` formats
      // the violation list into `message` and `toErrorData()` is the
      // structured `details` payload its `sendError` attaches.
      const violation = new ContractViolationError({
        tool: 'ggui_event',
        violations: result.violations,
      });
      reply.send({
        type: 'error',
        payload: {
          code: 'CONTRACT_VIOLATION',
          message: violation.message,
          details: violation.toErrorData(),
        },
        ...requestIdProps,
      });
      return;
    }
  }

  const sequence = appendEvent(render, {
    type: 'user.submitted',
    data: message.payload,
  });

  reply.send({
    type: 'ack',
    payload: { sequence, timestamp: Date.now() },
    ...requestIdProps,
  });
}

