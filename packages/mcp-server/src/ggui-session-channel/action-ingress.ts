/**
 * Inbound `action` ingress + consume bridge for the live channel —
 * contract enforcement on user gestures arriving over WS, the
 * dual-write onto the retained event ledger + the pending-events pipe
 * (`ggui_consume`'s queue), and the ack carrying the ledger seq back
 * to the client.
 */

import type { GguiSessionStore, PendingEventConsumer } from "@ggui-ai/mcp-server-core";
import { assertActionContract } from "@ggui-ai/mcp-server-handlers/renders";
import type { ActionEnvelope, ConsumeEventEntry, GguiSession } from "@ggui-ai/protocol";
import { ContractViolationError } from "@ggui-ai/protocol";
import type { WebSocketMessage } from "@ggui-ai/protocol/transport/websocket";
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { Logger } from "../logger.js";
import type { Subscriber } from "./internal-types.js";
import type { Outbound } from "./outbound.js";

/**
 * Resolve the active render variant for contract enforcement. Phase
 * B collapsed the prior (stack, currentStackIndex) lookup — a render
 * IS the addressable unit, so the active render is the stored render
 * itself. MCP Apps / system variants narrow to `undefined` so
 * upstream enforcement skips (allowlist + actionSpec checks are
 * no-ops when no `ComponentGguiSession` is active).
 */
function resolveActiveGguiSession(render: GguiSession | undefined): GguiSession | undefined {
  if (!render) return undefined;
  if (render.type === "mcpApps" || render.type === "system") return undefined;
  return render;
}

/**
 * Stamp the `tool` hint onto a `data:submit` envelope's
 * `ActionEventValue` payload before it persists onto the retained
 * event ledger (`user.submitted`).
 *
 * The hint derives server-side from the active render's
 * `actionSpec[action].nextStep` — the single authoritative source —
 * and only fills the gap when the inbound payload carries no `tool`
 * of its own. It rides the LEDGER copy only (operator surfaces —
 * console timeline, inspector feeds — read it); the consume-pipe
 * entry is the relay-identical {@link ConsumeEventEntry}, which
 * carries no tool slot — the agent reads `nextStep` from the
 * contract it authored.
 *
 * Pass-through (returns the envelope unchanged) when:
 *   - the envelope is not `data:submit`,
 *   - no `ComponentGguiSession` is active (mcpApps / system),
 *   - the payload lacks a string `action` or already carries a
 *     non-empty `tool`,
 *   - the named action declares no `nextStep`.
 */
function withDerivedToolHint(
  envelope: ActionEnvelope,
  activeItem: GguiSession | undefined
): ActionEnvelope {
  if (envelope.type !== "data:submit" || !activeItem) return envelope;
  if (activeItem.type === "mcpApps" || activeItem.type === "system") return envelope;
  const payload = envelope.payload;
  if (
    payload === null ||
    payload === undefined ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return envelope;
  }
  if (typeof payload.action !== "string" || payload.action.length === 0) return envelope;
  if (typeof payload.tool === "string" && payload.tool.length > 0) return envelope;
  const nextStep = activeItem.actionSpec?.[payload.action]?.nextStep;
  if (typeof nextStep !== "string" || nextStep.length === 0) return envelope;
  return { ...envelope, payload: { ...payload, tool: nextStep } };
}

/**
 * Project an accepted `data:submit` {@link ActionEnvelope} onto the
 * canonical {@link ConsumeEventEntry} shape the pending-events pipe
 * stores — the SAME shape `ggui_runtime_submit_action`'s dispatch
 * branch appends, so `ggui_consume` drains WS-originated gestures
 * and tools/call-relayed gestures identically.
 *
 * Field mapping:
 *   - `intent`     ← `payload.action` (the actionSpec key).
 *   - `actionData` ← `payload.data ?? null` (already validated by
 *     {@link assertActionContract} when a spec is declared).
 *   - `uiContext`  ← `{}` — WS clients don't mirror a contextSpec
 *     snapshot (that's the iframe-runtime observer's job); the empty
 *     object is the type's canonical "no slots mirrored" value.
 *   - `actionId`   ← server-minted 8-hex correlation id. The WS wire
 *     envelope carries none (only the iframe-runtime computes a
 *     gesture-side FNV-1a hash); minting here keeps the pipe entry's
 *     `drain_ack` keying well-formed.
 *   - `firedAt`    ← server clock — the WS envelope deliberately
 *     carries no client timestamp (see {@link ActionEnvelope}).
 *
 * Returns `null` when the payload lacks a non-empty string `action`
 * (possible only on spec-less renders, where the contract gate is
 * permissive) — there is no intent to key the entry on, so the
 * gesture stays ledger-only.
 */
function toConsumeEventEntry(
  envelope: ActionEnvelope,
  sessionId: string
): ConsumeEventEntry | null {
  const payload = envelope.payload;
  if (
    payload === null ||
    payload === undefined ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const action = payload.action;
  if (typeof action !== "string" || action.length === 0) return null;
  return {
    type: "action",
    sessionId,
    intent: action,
    actionData: payload.data ?? null,
    uiContext: {},
    actionId: randomBytes(4).toString("hex"),
    firedAt: new Date().toISOString(),
  };
}

export interface ActionIngressDeps {
  readonly logger: Logger;
  readonly renderStore: GguiSessionStore;
  /**
   * Pending-events pipe — see
   * `GguiSessionChannelOptions.pendingEventConsumer` for the dual-write
   * contract. Absent → ledger-only ingress.
   */
  readonly pendingEventConsumer?: PendingEventConsumer;
  readonly send: Outbound["send"];
  readonly sendError: Outbound["sendError"];
}

export interface ActionIngress {
  /**
   * Handle an inbound `action` message — the canonical flat
   * {@link ActionEnvelope} shape.
   *
   * Inbound actions are gated by {@link assertActionContract} only —
   * the actionSpec payload check for `data:submit` types. (The
   * pre-Phase-B `subscription.events` allowlist gate was deleted with
   * the session-stack collapse; per-render event policy needs a new
   * wire shape before any second gate can exist.)
   *
   * Accepted envelopes dual-write, mirroring the
   * `ggui_runtime_submit_action` relay's posture:
   *
   *   1. The retained event ledger (`renderStore.appendEvent`) — the
   *      ack's `seq` source; failure is the load-bearing
   *      `APPEND_FAILED` path.
   *   2. For `data:submit` only, the pending-events pipe
   *      ({@link ActionIngressDeps.pendingEventConsumer}) — the
   *      queue `ggui_consume` drains, so the agent receives the gesture
   *      mid-turn. Pipe failure degrades to ledger-only with a warn;
   *      it never changes the ack.
   */
  handleInboundAction(
    ws: WebSocket,
    sub: Subscriber,
    message: WebSocketMessage & { type: "action" }
  ): Promise<void>;
}

export function createActionIngress(deps: ActionIngressDeps): ActionIngress {
  async function handleInboundAction(
    ws: WebSocket,
    sub: Subscriber,
    message: WebSocketMessage & { type: "action" }
  ): Promise<void> {
    const envelope: ActionEnvelope = message.payload;

    // Spoof guard — envelope.sessionId is REQUIRED on the wire and
    // MUST match the subscriber's bound render.
    if (envelope.sessionId !== sub.sessionId) {
      deps.sendError(
        ws,
        "SESSION_MISMATCH",
        `Action targets render '${envelope.sessionId}' but this socket is subscribed to '${sub.sessionId}'`,
        message.requestId
      );
      return;
    }

    const stored = await deps.renderStore.get(sub.sessionId);
    if (!stored) {
      deps.sendError(
        ws,
        "SESSION_NOT_FOUND",
        `GguiSession ${sub.sessionId} no longer exists`,
        message.requestId
      );
      return;
    }

    // Phase B: a render IS the addressable unit. The prior stack
    // routing (stackIndex / cross-stack pickIds) collapses — the
    // resolved render itself is the active item.
    const activeItem = resolveActiveGguiSession(stored.render);

    // Contract enforcement: actionSpec payload check via
    // assertActionContract (data:submit only). Envelope.payload for
    // data:submit carries the ActionEventValue shape
    // (`{action, data?, tool?}`).
    if (envelope.type === "data:submit") {
      try {
        const activeActionSpec =
          activeItem && activeItem.type !== "mcpApps" && activeItem.type !== "system"
            ? activeItem.actionSpec
            : undefined;
        assertActionContract(activeActionSpec, envelope.payload);
      } catch (err) {
        if (err instanceof ContractViolationError) {
          deps.logger.warn("render_channel_contract_violation", {
            sessionId: sub.sessionId,
            violations: err.violations,
            envelope: "action",
          });
          deps.sendError(
            ws,
            "CONTRACT_VIOLATION",
            err.message,
            message.requestId,
            err.toErrorData()
          );
          return;
        }
        throw err;
      }
    }

    // Dual-write, mirroring `ggui_runtime_submit_action`'s dispatch
    // branch (`createGguiSubmitActionHandler`):
    //
    //   1. Ledger — `GguiSessionStore.appendEvent` assigns a monotonic
    //      seq the client acks back with so reconnects can resume via
    //      `fromSeq`. This retained copy is also the single build site
    //      for the operator-facing `tool` hint — see
    //      {@link withDerivedToolHint}.
    //   2. Pipe — for `data:submit` envelopes, the consume-entry
    //      projection ({@link toConsumeEventEntry}) lands on the
    //      pending-events pipe so the agent's `ggui_consume` long-poll
    //      drains it mid-turn. The ledger and the pipe are two
    //      different streams (queue vs append-only retained — see
    //      `pending-event-consumer.ts`); without this write a WS
    //      gesture would never reach the agent.
    //
    // Both writes fire concurrently via `Promise.allSettled` so each
    // outcome is inspected independently: a ledger rejection is the
    // load-bearing `APPEND_FAILED` error path (unchanged ack
    // semantics); a pipe rejection (pipe never opened / already
    // reaped) degrades to ledger-only with a warn — the WS client has
    // no `ui/message` fallback to branch on, so a new error frame
    // would be vocabulary without a consumer.
    const consumeWrite: Promise<void> = (() => {
      if (deps.pendingEventConsumer === undefined || envelope.type !== "data:submit") {
        return Promise.resolve();
      }
      const entry = toConsumeEventEntry(envelope, sub.sessionId);
      if (entry === null) return Promise.resolve();
      return deps.pendingEventConsumer.append(sub.sessionId, {
        // The pipe entry's stable id doubles as the `drain_ack` key —
        // same convention as the relay path's iframe-supplied id.
        id: entry.actionId,
        envelope: entry,
        createdAt: entry.firedAt,
      });
    })();
    const [ledgerResult, pipeResult] = await Promise.allSettled([
      deps.renderStore.appendEvent({
        sessionId: sub.sessionId,
        type: "user.submitted",
        data: withDerivedToolHint(envelope, activeItem),
      }),
      consumeWrite,
    ]);
    if (pipeResult.status === "rejected") {
      deps.logger.warn("render_channel_consume_append_failed", {
        sessionId: sub.sessionId,
        error:
          pipeResult.reason instanceof Error
            ? pipeResult.reason.message
            : String(pipeResult.reason),
      });
    }
    if (ledgerResult.status === "rejected") {
      const err = ledgerResult.reason;
      deps.logger.error("render_channel_append_failed", {
        sessionId: sub.sessionId,
        error: String(err),
      });
      deps.sendError(
        ws,
        "APPEND_FAILED",
        err instanceof Error ? err.message : String(err),
        message.requestId
      );
      return;
    }
    const seq: number = ledgerResult.value;

    deps.send(ws, {
      type: "ack",
      payload: { sequence: seq, timestamp: Date.now() },
      ...(message.requestId ? { requestId: message.requestId } : {}),
    });
  }

  return { handleInboundAction };
}
