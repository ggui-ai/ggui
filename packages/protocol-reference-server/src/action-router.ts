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
 * MUST name a declared entry. Violations reply an `error` frame with
 * code `CONTRACT_VIOLATION` (echoing the message's `requestId`) and
 * the envelope is NOT appended — undeclared actions never reach the
 * buffer. Sessions without a declared actionSpec accept every action:
 * no contract, nothing to enforce.
 */
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
  if (frame === null || typeof frame !== 'object') return undefined;
  const f = frame as Record<string, unknown>;
  if (f['type'] !== 'action') return undefined;
  const envelope = f['payload'];
  if (envelope === null || typeof envelope !== 'object') return undefined;
  const e = envelope as Record<string, unknown>;
  const sessionId = typeof e['sessionId'] === 'string' ? e['sessionId'] : undefined;
  if (sessionId === undefined) return undefined;
  const eventType = typeof e['type'] === 'string' ? e['type'] : undefined;
  if (eventType === undefined) return undefined;
  const requestId = typeof f['requestId'] === 'string' ? f['requestId'] : undefined;
  return {
    type: 'action',
    ...(requestId !== undefined ? { requestId } : {}),
    payload: {
      sessionId,
      type: eventType,
      ...('payload' in e ? { payload: e['payload'] } : {}),
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
    const violation = checkActionContract(render.actionSpec, message.payload.payload);
    if (violation !== undefined) {
      reply.send({
        type: 'error',
        payload: { code: 'CONTRACT_VIOLATION', message: violation },
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

/**
 * Name-membership half of the action contract: the ActionEventValue
 * must be an object whose `action` names a declared actionSpec entry.
 * Returns the violation message, or `undefined` when the value
 * conforms. Schema validation of `data` is out of the reference
 * server's scope — the declared entries' `schema` field is authoring-
 * reserved vocabulary the kit's fixtures don't exercise yet.
 */
function checkActionContract(
  actionSpec: Readonly<Record<string, unknown>>,
  value: unknown,
): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'Action payload must be an object with an `action` field';
  }
  const action = (value as Record<string, unknown>)['action'];
  if (typeof action !== 'string' || action.length === 0) {
    return 'Missing or empty `action` identifier';
  }
  if (!(action in actionSpec)) {
    const declared = Object.keys(actionSpec).join(', ') || '(none)';
    return `Unknown action '${action}'. Declared actions: ${declared}`;
  }
  return undefined;
}
