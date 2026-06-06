/**
 * Wired-action dispatcher — consumes an inbound `action` frame and
 * emits the matching `_ggui:contract-error` stream frame (plus happy-
 * path effects) per SPEC §4.4 + Contract #3.
 *
 * This file owns every ContractErrorCode emission path the
 * conformance kit's matcher asserts on:
 *
 *   - TOOL_NOT_FOUND   — dispatched action's tool is not registered
 *   - TOOL_THREW       — handler throws
 *   - TOOL_TIMEOUT     — handler exceeds `TIMEOUT_MS` (500ms)
 *   - SCHEMA_VIOLATION — handler returns shape not matching declared
 *                        channel schema (currently: `malformed` kind
 *                        always trips this path)
 *
 * Happy-path: echo handler's success return fires an observability
 * signal (kit's `wired-action-success` fixture asserts the router
 * dispatch observably happened). Since observability events are
 * unmatchable-on-ws per the conformance kit's matcher, the
 * happy-path emission here is best-effort: we emit a non-reserved
 * stream frame on `_ggui:wired-tool-invoked` carrying
 * `{toolName, actionName}` so an iframe-host kit can match the same
 * tool invocation signal from either side. Pure WS kit currently
 * treats this as SKIP.
 */
import { makeContractErrorPayload } from '@ggui-ai/protocol';

import type { GguiSession } from './render.js';
import type { ToolRegistry } from './tool-registry.js';

/** Timeout the `timeout` handler exceeds; the kit's matcher
 *  recognizes TOOL_TIMEOUT within this window. */
const TIMEOUT_MS = 500;

/**
 * One inbound action frame shape. Matches the fixtures' authored
 * `inputEnvelope` for `wired-action-*` cases — the runner sends the
 * envelope verbatim. The session-identity field is the canonical SPEC
 * field `sessionId`.
 */
interface IncomingActionFrame {
  readonly type: 'action';
  readonly channel?: number;
  readonly sessionId: string;
  readonly action: {
    readonly name: string;
    readonly data?: unknown;
  };
}

/**
 * Parse + validate an inbound action frame. Returns the normalized
 * shape on success, `undefined` on any malformed input (matcher for
 * `no-op` fixtures expects silence, so loud rejection would break
 * them).
 *
 * Reads the canonical SPEC session-identity field `sessionId`.
 */
export function parseActionFrame(frame: unknown): IncomingActionFrame | undefined {
  if (frame === null || typeof frame !== 'object') return undefined;
  const f = frame as Record<string, unknown>;
  if (f['type'] !== 'action') return undefined;
  const sessionId = typeof f['sessionId'] === 'string' ? f['sessionId'] : undefined;
  if (sessionId === undefined) return undefined;
  const action = f['action'];
  if (action === null || typeof action !== 'object') return undefined;
  const a = action as Record<string, unknown>;
  const name = a['name'];
  if (typeof name !== 'string') return undefined;
  const data = 'data' in a ? a['data'] : undefined;
  const channelValue = f['channel'];
  return {
    type: 'action',
    ...(typeof channelValue === 'number' ? { channel: channelValue } : {}),
    sessionId,
    action: { name, ...(data !== undefined ? { data } : {}) },
  };
}

export interface DispatchContext {
  readonly render: GguiSession;
  readonly tools: ToolRegistry;
}

/**
 * Dispatch one action frame. Runs asynchronously; contract-error
 * emissions are broadcast to every subscriber on the GguiSession via
 * `render.subscribers`.
 *
 * Returns when the dispatch's observable outcome has been emitted
 * (either a happy-path observability frame or a contract-error).
 * The awaiting call site is the WS message handler — letting it
 * await ensures the kit's observation window captures the emission.
 */
export async function dispatchAction(
  frame: IncomingActionFrame,
  context: DispatchContext,
): Promise<void> {
  const { render, tools } = context;
  const actionName = frame.action.name;

  // Action → tool resolution, in priority order:
  //   1. Explicit `register-actionspec` directive on this render.
  //   2. Tool whose name equals the action name (1:1 convention).
  //
  // A real ggui server uses a blueprint's declared `actionSpec` to
  // bind action names to tool names; the reference server honors the
  // same binding via the fixture's explicit `register-actionspec`
  // setup directive. If neither path resolves, emit TOOL_NOT_FOUND
  // with `toolName = actionName` — the error payload names the
  // missing tool by the identifier the dispatcher was asked to
  // resolve, which is the action name itself.
  const actionSpec = render.actionSpecs.get(actionName);
  let toolName: string | undefined = actionSpec?.tool;
  if (toolName === undefined && tools.has(actionName)) {
    toolName = actionName;
  }

  if (toolName === undefined) {
    emitContractError(render, {
      code: 'TOOL_NOT_FOUND',
      toolName: actionName,
      actionName,
      message: `no actionSpec bound action '${actionName}' and no tool of that name is registered`,
    });
    return;
  }

  const tool = tools.get(toolName);
  if (tool === undefined) {
    emitContractError(render, {
      code: 'TOOL_NOT_FOUND',
      toolName,
      actionName,
      message: `tool '${toolName}' is not registered`,
    });
    return;
  }

  // Malformed handler is defined to return the wrong shape — emit
  // SCHEMA_VIOLATION instead of passing the bad return through.
  if (tool.kind === 'malformed') {
    emitContractError(render, {
      code: 'SCHEMA_VIOLATION',
      toolName: tool.name,
      actionName,
      message: `tool '${tool.name}' returned a shape that does not match the declared channel schema`,
    });
    return;
  }

  // Run the handler with a timeout bound. `timeout` kind wins the
  // timeout race deliberately; other handlers should resolve or
  // throw well before 500ms.
  let handlerOutcome: { readonly kind: 'resolved'; readonly value: unknown } | { readonly kind: 'rejected'; readonly error: Error } | { readonly kind: 'timeout' };
  try {
    handlerOutcome = await Promise.race([
      (async () => {
        try {
          const value = await tool.handler(frame.action.data);
          return { kind: 'resolved' as const, value };
        } catch (err) {
          return {
            kind: 'rejected' as const,
            error: err instanceof Error ? err : new Error(String(err)),
          };
        }
      })(),
      new Promise<{ readonly kind: 'timeout' }>((done) => {
        setTimeout(() => done({ kind: 'timeout' }), TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    // Promise.race never rejects since we catch inside; defensive.
    emitContractError(render, {
      code: 'TOOL_THREW',
      toolName: tool.name,
      actionName,
      message: (err as Error).message ?? String(err),
      causedBy: (err as Error).stack?.split('\n').slice(0, 3).join('\n'),
    });
    return;
  }

  if (handlerOutcome.kind === 'timeout') {
    emitContractError(render, {
      code: 'TOOL_TIMEOUT',
      toolName: tool.name,
      actionName,
      message: `tool '${tool.name}' exceeded ${TIMEOUT_MS}ms`,
    });
    return;
  }

  if (handlerOutcome.kind === 'rejected') {
    emitContractError(render, {
      code: 'TOOL_THREW',
      toolName: tool.name,
      actionName,
      message: handlerOutcome.error.message,
      causedBy: handlerOutcome.error.stack?.split('\n').slice(0, 3).join('\n'),
    });
    return;
  }

  // Happy path — emit the observability signal so iframe-host kits
  // can observe it. WS-only kit's matcher will return
  // `unmatchable-on-ws` for `observability-event`, which the runner
  // maps to SKIP (not FAIL). That's the intended behavior per the
  // kit's design note at the top of `match-behavior.ts`.
  broadcast(render, {
    type: 'stream',
    payload: {
      channel: '_ggui:wired-tool-invoked',
      value: { toolName: tool.name, actionName },
    },
  });

  // Refresh-stream fan-out (SPEC §2.3 StreamSpec refresh triggers).
  // After a successful wired-action dispatch, every streamSpec
  // declared on the GguiSession fires its refresh tool and emits a
  // stream-update on the bound channel. This is the wire-level
  // proof of the refresh-after-action contract the kit's
  // `stream-refresh-success` fixture asserts.
  //
  // Refresh-tool failures are emitted as contract-errors with
  // `sourceAction: 'refresh-stream'` so the kit's matcher can
  // distinguish action-path failures from refresh-path failures
  // (and so `stream-schema-violation` has a path forward when its
  // fixture flips off the known-failures list).
  await dispatchRefreshStreams(render, tools);
}

/**
 * Run every streamSpec's refresh tool and broadcast the result on
 * its bound channel. Errors map to canonical `_ggui:contract-error`
 * envelopes with `sourceAction: 'refresh-stream'`. Sequential
 * dispatch keeps subscriber-frame ordering deterministic — the
 * kit's matcher doesn't depend on order today, but a real ggui
 * runtime emits in declaration order and the reference server
 * preserves that contract.
 */
async function dispatchRefreshStreams(
  render: GguiSession,
  tools: ToolRegistry,
): Promise<void> {
  for (const spec of render.streamSpecs.values()) {
    const refreshTool = tools.get(spec.tool);
    if (refreshTool === undefined) {
      emitContractError(render, {
        code: 'TOOL_NOT_FOUND',
        toolName: spec.tool,
        actionName: spec.channel,
        message: `streamSpec for channel '${spec.channel}' references tool '${spec.tool}', which is not registered`,
        sourceActionType: 'refresh-stream',
      });
      continue;
    }
    if (refreshTool.kind === 'malformed' || refreshTool.kind === 'malformed-stream') {
      emitContractError(render, {
        code: 'SCHEMA_VIOLATION',
        toolName: refreshTool.name,
        actionName: spec.channel,
        message: `refresh tool '${refreshTool.name}' returned a shape that does not match channel '${spec.channel}'`,
        sourceActionType: 'refresh-stream',
      });
      continue;
    }
    let value: unknown;
    try {
      value = await refreshTool.handler(undefined);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      emitContractError(render, {
        code: 'TOOL_THREW',
        toolName: refreshTool.name,
        actionName: spec.channel,
        message: error.message,
        causedBy: error.stack?.split('\n').slice(0, 3).join('\n'),
        sourceActionType: 'refresh-stream',
      });
      continue;
    }
    broadcast(render, {
      type: 'stream',
      payload: {
        channel: spec.channel,
        value,
      },
    });
  }
}

// =============================================================================
// Contract-error emission
// =============================================================================

interface EmitContractErrorInput {
  readonly code: string;
  readonly toolName: string;
  readonly actionName: string;
  readonly message: string;
  readonly causedBy?: string;
  /** Defaults to `'wired-action'` when omitted. */
  readonly sourceActionType?: 'wired-action' | 'refresh-stream';
}

function emitContractError(render: GguiSession, input: EmitContractErrorInput): void {
  // Canonical SPEC §4.4 `ContractErrorPayload` via the central
  // builder. Nested `error: {code, message, causedBy}` alongside
  // flat `toolName` / `actionName` / `sourceAction` / `timestamp`.
  // The conformance kit's matcher reads this canonical shape
  // directly — no dual-shape workaround needed.
  const value = makeContractErrorPayload({
    toolName: input.toolName,
    actionName: input.actionName,
    sourceAction: {
      type: input.sourceActionType ?? 'wired-action',
      dispatchedAt: new Date().toISOString(),
    },
    error: {
      code: input.code,
      message: input.message,
      ...(input.causedBy !== undefined ? { causedBy: input.causedBy } : {}),
    },
    timestamp: new Date().toISOString(),
  });
  broadcast(render, {
    type: 'stream',
    payload: {
      channel: '_ggui:contract-error',
      value,
    },
  });
}

function broadcast(render: GguiSession, frame: unknown): void {
  for (const subscriber of render.subscribers) {
    try {
      subscriber.send(frame);
    } catch {
      // Subscriber lifecycle issues (closed socket, etc.) are the
      // subscriber's problem — the router keeps broadcasting.
    }
  }
}
