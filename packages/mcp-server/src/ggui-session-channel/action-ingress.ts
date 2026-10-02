/**
 * Inbound `action` ingress + consume bridge for the live channel —
 * contract enforcement on user gestures arriving over WS, the
 * dual-write onto the retained event ledger + the pending-events pipe
 * (`ggui_consume`'s queue), and the ack carrying the ledger seq back
 * to the client.
 */

import type {
  GguiSessionStore,
  PendingEventAppendOutcome,
  PendingEventConsumer,
} from "@ggui-ai/mcp-server-core";
import {
  assertActionContract,
  recordCommittedOneShot,
} from "@ggui-ai/mcp-server-handlers/renders";
import type { ActionEnvelope, ConsumeEventEntry, GguiSession } from "@ggui-ai/protocol";
import { ContractViolationError } from "@ggui-ai/protocol";
import type { WebSocketMessage } from "@ggui-ai/protocol/transport/websocket";
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { Logger } from "../logger.js";
import type { WsSubscriber } from "./internal-types.js";
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
    sub: WsSubscriber,
    message: WebSocketMessage & { type: "action" }
  ): Promise<void>;
}

export function createActionIngress(deps: ActionIngressDeps): ActionIngress {
  async function handleInboundAction(
    ws: WebSocket,
    sub: WsSubscriber,
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
    //
    // The append's outcome (ggui#1517) is not read here: this path mints
    // the pipe id per frame (`toConsumeEventEntry`), so a duplicate cannot
    // arise, and the ledger write is this path's load-bearing one.
    // The pipe entry (and its minted actionId, which also names the holder of
    // a oneShot spend, ggui#1424) is built once per frame.
    const entry = envelope.type === "data:submit" ? toConsumeEventEntry(envelope, sub.sessionId) : null;

    // ggui#1424 — the channel door refuses a second gesture on a spent
    // oneShot too, so the server's refusal holds at both doors. The claim is
    // taken BEFORE the writes under this frame's minted actionId; the answer
    // decides as it does on the tool door (`claimDispatchSpend` there):
    // already-spent by another holder whose delivery is marked → refused with
    // the channel's existing CONTRACT_VIOLATION error frame (#1358), one
    // violation at `actionSpec.<name>.oneShot`, no ledger row, no pipe entry,
    // one named line; an unmarked holder is taken over; the same holder, no
    // holder, a non-oneShot action, a store that answers no claim, or a store
    // failure (fail-open, named) → the frame goes on as before. The store
    // enforces `delivered`: the refusal arm reads it only as the store
    // answers it. Delivery is marked after the writes below.
    const framePayload = envelope.payload;
    const oneShotPayload =
      entry !== null &&
      activeItem !== undefined &&
      framePayload !== null &&
      typeof framePayload === "object" &&
      !Array.isArray(framePayload) &&
      typeof framePayload.action === "string"
        ? { action: framePayload.action, data: framePayload.data }
        : null;
    if (oneShotPayload !== null && entry !== null && activeItem !== undefined) {
      const verdict = await claimChannelSpend(deps, sub.sessionId, activeItem, oneShotPayload, entry.actionId);
      if (verdict.kind === "refuse") {
        deps.logger.warn("render_channel_one_shot_refused", {
          sessionId: sub.sessionId,
          action: oneShotPayload.action,
          actionId: entry.actionId,
          by: verdict.by,
        });
        deps.sendError(
          ws,
          "CONTRACT_VIOLATION",
          `actionSpec.${oneShotPayload.action} is declared oneShot and already fired on this card; a second gesture is refused`,
          message.requestId,
          {
            error: "contract_violation",
            violations: [
              {
                field: `actionSpec.${oneShotPayload.action}.oneShot`,
                keyword: "oneShot",
                message: "this one-shot action already fired on this card",
                expected: verdict.by,
                received: entry.actionId,
              },
            ],
            hint: "The action already fired on this card. Render a new card to fire it again.",
          }
        );
        return;
      }
    }
    const consumeWrite: Promise<PendingEventAppendOutcome | void> = (() => {
      if (deps.pendingEventConsumer === undefined || entry === null) {
        return Promise.resolve();
      }
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

    // ggui#1223 / #1305 / #1424 — the gesture is in the ledger, so the
    // holder MARKS its spend delivered (claimed above, before the writes),
    // BEFORE the ack: a client that holds the ack can reload and find the
    // card spent. FAIL-OPEN, as on the tool path: a failed record is named
    // and never withholds the ack. With no pipe entry (the frame did not
    // parse as a dispatch) the spend is recorded held by nobody, as before.
    if (envelope.type === "data:submit" && activeItem !== undefined) {
      const payload = envelope.payload;
      if (
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        typeof payload.action === "string"
      ) {
        try {
          await recordCommittedOneShot({
            store: deps.renderStore,
            sessionId: sub.sessionId,
            render: activeItem,
            action: payload.action,
            data: payload.data,
            ...(entry !== null ? { actionId: entry.actionId, delivered: true as const } : {}),
          });
        } catch (err) {
          deps.logger.warn("render_channel_spent_oneshot_persist_failed", {
            sessionId: sub.sessionId,
            action: payload.action,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    deps.send(ws, {
      type: "ack",
      payload: { sequence: seq, timestamp: Date.now() },
      ...(message.requestId ? { requestId: message.requestId } : {}),
    });
  }

  return { handleInboundAction };
}

/** The channel door's verdict on a oneShot claim (ggui#1424); mirrors the tool door's `claimDispatchSpend`. */
type ChannelSpendVerdict = { readonly kind: "proceed" } | { readonly kind: "refuse"; readonly by: string };

async function claimChannelSpend(
  deps: ActionIngressDeps,
  sessionId: string,
  render: GguiSession,
  payload: { readonly action: string; readonly data: unknown },
  actionId: string,
): Promise<ChannelSpendVerdict> {
  const claimOnce = async (spend: { readonly actionId: string; readonly reclaimFrom?: string }) => {
    try {
      return await recordCommittedOneShot({
        store: deps.renderStore,
        sessionId,
        render,
        action: payload.action,
        data: payload.data,
        ...spend,
      });
    } catch (err) {
      deps.logger.warn("render_channel_spent_oneshot_persist_failed", {
        sessionId,
        action: payload.action,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  };
  const first = await claimOnce({ actionId });
  const claim = first?.claim;
  if (claim === undefined || claim.outcome !== "already-spent" || claim.by === undefined || claim.by === actionId) {
    return { kind: "proceed" };
  }
  if (claim.delivered === true) return { kind: "refuse", by: claim.by };
  const retaken = await claimOnce({ actionId, reclaimFrom: claim.by });
  const second = retaken?.claim;
  if (second === undefined || second.outcome !== "already-spent" || second.by === undefined || second.by === actionId) {
    return { kind: "proceed" };
  }
  return { kind: "refuse", by: second.by };
}
