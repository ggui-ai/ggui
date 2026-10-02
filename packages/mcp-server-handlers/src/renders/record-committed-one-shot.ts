/**
 * ggui#1223 / #1305 — record a COMMITTED `oneShot` dispatch on its card, so
 * a re-served card renders the action spent after a reload.
 *
 * ONE decision, called by both ingress paths after the write each treats as
 * load-bearing: the live channel's `data:submit` after its ledger append,
 * and `ggui_runtime_submit_action` after its pipe append. "Committed" means
 * the same thing the runtime's wire guard means by it (spend only on a fire
 * that passed the card's contract), so the decision evaluates the contract
 * itself. It never changes whether a path ACCEPTS a dispatch: a dispatch the
 * contract rejects is delivered exactly as before and simply does not spend.
 *
 * The card is the head card unless the dispatch names another. A named
 * epoch other than the head's is a superseded card: nothing is written,
 * because the projection only ever shows a record on its own card, and a
 * superseded card re-serves frozen (#483). Absent ⇒ the head, which is what
 * every dispatch means before the wire carries a card epoch.
 */
import { validateActionData, type GguiSession } from '@ggui-ai/protocol';
import type { GguiSessionStore, SpentOneShotClaim } from '@ggui-ai/mcp-server-core';

/**
 * What {@link recordCommittedOneShot} decided. Every arm but `recorded` wrote
 * nothing, and none of them is an error: a caller logs only a thrown store
 * failure (fail-open). On `recorded`, `claim` carries the store's answer
 * when the store claims (ggui#1424) — `recorded`, `already-spent {by,
 * delivered}` or `superseded` — and is absent for a store that records
 * without claiming (the earlier port).
 */
export interface CommittedOneShotResult {
  readonly outcome: CommittedOneShotOutcome;
  readonly claim?: SpentOneShotClaim;
}

export type CommittedOneShotOutcome =
  /** The store applied the spend (a repeat of an already-spent action included). */
  | 'recorded'
  /** The card does not declare this action `oneShot` (or is not a component card). */
  | 'not-one-shot'
  /** The dispatch failed the card's action contract, so it never spends. */
  | 'not-committed'
  /** The dispatch named a card that is no longer the head. */
  | 'superseded-card'
  /** The store does not implement `recordSpentOneShot`; named once at server construction. */
  | 'not-durable';

export interface RecordCommittedOneShotInput {
  readonly store: GguiSessionStore;
  readonly sessionId: string;
  /** The render as stored: the head card, its `actionSpec` and its `epoch`. */
  readonly render: GguiSession;
  /** The dispatched `actionSpec` name. */
  readonly action: string;
  /** The dispatched payload (`ActionEventValue.data`). */
  readonly data: unknown;
  /** The dispatching card's history epoch, when the dispatch carries one. */
  readonly cardEpoch?: number;
  /** The gesture's `actionId` — the holder of the spend it claims (ggui#1424). */
  readonly actionId?: string;
  /** A take-over of an undelivered holder — see `SpentOneShotSpend.reclaimFrom`. */
  readonly reclaimFrom?: string;
  /** The holder's mark after its append landed — see `SpentOneShotSpend.delivered`. */
  readonly delivered?: true;
  /** The holder gives the action back after a conflicting append — see `SpentOneShotSpend.release`. */
  readonly release?: true;
}

/**
 * Decide and, when the dispatch is a committed `oneShot` on the head card,
 * record it. A store failure propagates: the caller owns its named warn line.
 */
export async function recordCommittedOneShot(
  input: RecordCommittedOneShotInput,
): Promise<CommittedOneShotResult> {
  const { render, action } = input;
  if (render.type !== 'component') return { outcome: 'not-one-shot' };
  const spec = render.actionSpec;
  if (spec?.[action]?.oneShot !== true) return { outcome: 'not-one-shot' };
  if (!validateActionData({ action, data: input.data }, spec).valid) return { outcome: 'not-committed' };
  const headEpoch = render.epoch ?? 0;
  const epoch = input.cardEpoch ?? headEpoch;
  if (epoch !== headEpoch) return { outcome: 'superseded-card' };
  if (input.store.recordSpentOneShot === undefined) return { outcome: 'not-durable' };
  const claim = await input.store.recordSpentOneShot(input.sessionId, {
    epoch,
    action,
    ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
    ...(input.reclaimFrom !== undefined ? { reclaimFrom: input.reclaimFrom } : {}),
    ...(input.delivered === true ? { delivered: true } : {}),
    ...(input.release === true ? { release: true } : {}),
  });
  return claim === undefined ? { outcome: 'recorded' } : { outcome: 'recorded', claim };
}
